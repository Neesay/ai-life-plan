import AlarmKit
import Foundation
import SwiftUI

struct BlockAlarmMetadata: AlarmMetadata {
    var blockId: String
    var label: String
}

typealias BlockAlarmConfiguration = AlarmManager.AlarmConfiguration<BlockAlarmMetadata>

/// Keeps AlarmKit identical to the server's alarm list.
enum AlarmScheduler {
    static let snoozeMinutes = 15
    private static let pinnedKey = "pinnedAlarms" // local-only alarms (snoozes, tests): uuid -> expiry

    // MARK: Authorization

    static var authorizationState: AlarmManager.AuthorizationState {
        AlarmManager.shared.authorizationState
    }

    @discardableResult
    static func requestAuthorization() async -> Bool {
        switch AlarmManager.shared.authorizationState {
        case .authorized: return true
        case .denied: return false
        case .notDetermined:
            return (try? await AlarmManager.shared.requestAuthorization()) == .authorized
        @unknown default: return false
        }
    }

    // MARK: Booking

    static func schedule(id: UUID, label: String, blockId: String, at date: Date) async throws {
        let stop = AlarmButton(text: "On it", textColor: .white, systemImageName: "checkmark.circle.fill")
        let snooze = AlarmButton(text: "+\(snoozeMinutes) min", textColor: .white, systemImageName: "clock.arrow.circlepath")
        let alert = AlarmPresentation.Alert(
            title: LocalizedStringResource(stringLiteral: label),
            stopButton: stop,
            secondaryButton: snooze,
            secondaryButtonBehavior: .custom
        )
        let attributes = AlarmAttributes(
            presentation: AlarmPresentation(alert: alert),
            metadata: BlockAlarmMetadata(blockId: blockId, label: label),
            tintColor: Color.red
        )
        let config = BlockAlarmConfiguration(
            countdownDuration: nil,
            schedule: .fixed(date),
            attributes: attributes,
            stopIntent: CheckInIntent(blockId: blockId, alarmId: id.uuidString, action: "on_it"),
            secondaryIntent: SnoozeIntent(blockId: blockId, alarmId: id.uuidString, label: label)
        )
        _ = try await AlarmManager.shared.schedule(id: id, configuration: config)
    }

    /// Diff the phone's alarms against the server list. Returns how many alarms are now booked.
    @discardableResult
    static func reconcile(with server: [AlarmSpec]) async throws -> Int {
        let pinned = activePinned()
        let wanted = Dictionary(server.compactMap { spec in
            UUID(uuidString: spec.id).map { ($0, spec) }
        }, uniquingKeysWith: { first, _ in first })
        let existing = try AlarmManager.shared.alarms

        for alarm in existing where wanted[alarm.id] == nil && !pinned.contains(alarm.id) {
            if alarm.state == .alerting { continue } // never kill one that's ringing
            try? AlarmManager.shared.cancel(id: alarm.id)
        }
        let existingIds = Set(existing.map(\.id))
        for (id, spec) in wanted where !existingIds.contains(id) && spec.fireAt > Date() {
            try await schedule(id: id, label: spec.label, blockId: spec.blockId, at: spec.fireAt)
        }
        return (try? AlarmManager.shared.alarms.count) ?? 0
    }

    /// Cancel any still-pending alarms for a block (after "On it" / skip).
    static func cancelRemaining(forBlock blockId: String, except: UUID? = nil) {
        let cached = Store.load(ScheduleResponse.self, "schedule.json")?.alarms ?? []
        for spec in cached where spec.blockId == blockId && spec.fireAt > Date() {
            guard let id = UUID(uuidString: spec.id), id != except else { continue }
            try? AlarmManager.shared.cancel(id: id)
        }
    }

    // MARK: Local-only alarms

    static func scheduleLocal(label: String, blockId: String, in seconds: TimeInterval) async throws {
        let id = UUID()
        let fire = Date().addingTimeInterval(seconds)
        pin(id, until: fire.addingTimeInterval(600))
        try await schedule(id: id, label: label, blockId: blockId, at: fire)
    }

    private static func pin(_ id: UUID, until: Date) {
        var map = UserDefaults.standard.dictionary(forKey: pinnedKey) as? [String: Double] ?? [:]
        map[id.uuidString] = until.timeIntervalSince1970
        UserDefaults.standard.set(map, forKey: pinnedKey)
    }

    private static func activePinned() -> Set<UUID> {
        let now = Date().timeIntervalSince1970
        let map = (UserDefaults.standard.dictionary(forKey: pinnedKey) as? [String: Double] ?? [:]).filter { $0.value > now }
        UserDefaults.standard.set(map, forKey: pinnedKey)
        return Set(map.keys.compactMap(UUID.init(uuidString:)))
    }
}
