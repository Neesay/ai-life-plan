import BackgroundTasks
import Foundation

@MainActor
final class SyncEngine: ObservableObject {
    static let shared = SyncEngine()
    static let refreshTaskId = "app.accountability.alarms.refresh"

    @Published private(set) var schedule: ScheduleResponse? = Store.load(ScheduleResponse.self, "schedule.json")
    @Published private(set) var lastSync: Date? = UserDefaults.standard.object(forKey: "lastSync") as? Date
    @Published private(set) var lastError: String?
    @Published private(set) var bookedCount: Int = UserDefaults.standard.integer(forKey: "bookedCount")
    @Published private(set) var isSyncing = false
    @Published private(set) var pendingEvents = 0

    private var lastPlacesFetch: Date?

    /// Flush queued events → fetch schedule → make AlarmKit match → refresh geofences.
    @discardableResult
    func sync(reason: String) async -> String {
        guard AppSettings.isConfigured else {
            lastError = APIError.notConfigured.localizedDescription
            return "Not configured"
        }
        if isSyncing { return "Already syncing" }
        isSyncing = true
        defer { isSyncing = false }

        await EventQueue.shared.flush()
        pendingEvents = await EventQueue.shared.pendingCount
        do {
            let response = try await APIClient().schedule()
            Store.save(response, "schedule.json")
            schedule = response
            if AlarmScheduler.authorizationState == .authorized {
                bookedCount = try await AlarmScheduler.reconcile(with: response.alarms)
                UserDefaults.standard.set(bookedCount, forKey: "bookedCount")
            }
            lastSync = Date()
            UserDefaults.standard.set(lastSync, forKey: "lastSync")
            lastError = nil

            // Places rarely change; refresh at most hourly.
            if lastPlacesFetch.map({ Date().timeIntervalSince($0) > 3600 }) ?? true {
                if let places = try? await APIClient().places() {
                    lastPlacesFetch = Date()
                    await LocationMonitor.shared.update(places: places)
                }
            }
            Self.scheduleBackgroundRefresh()
            return "Synced (\(reason)): \(response.alarms.count) alarms in the next 48h"
        } catch {
            lastError = error.localizedDescription
            return "Sync failed: \(error.localizedDescription)"
        }
    }

    func refreshPendingCount() async {
        pendingEvents = await EventQueue.shared.pendingCount
    }

    nonisolated static func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskId)
        request.earliestBeginDate = Date().addingTimeInterval(30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    // MARK: Today helpers

    var blocks: [Block] { (schedule?.blocks ?? []).filter { $0.source != "rule" } }

    func currentBlock(at now: Date = Date()) -> Block? {
        blocks.first { $0.startAt <= now && $0.endAt > now }
    }

    func nextBlock(at now: Date = Date()) -> Block? {
        blocks.first { $0.startAt > now }
    }

    /// Check in from the Today screen.
    func checkIn(_ block: Block, action: String, reason: String? = nil) async {
        var payload = ["action": action, "via": "app"]
        if let reason, !reason.isEmpty { payload["reason"] = reason }
        await EventQueue.shared.enqueue(OutgoingEvent(type: "checkin", blockId: block.id, payload: payload))
        switch action {
        case "on_it", "skip":
            AlarmScheduler.cancelRemaining(forBlock: block.id)
        case "snooze":
            try? await AlarmScheduler.scheduleLocal(
                label: "\(block.alarmLabel) · snoozed",
                blockId: block.id,
                in: TimeInterval(AlarmScheduler.snoozeMinutes * 60)
            )
        default: break
        }
        await sync(reason: "checkin")
    }
}
