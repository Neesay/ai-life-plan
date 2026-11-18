import AlarmKit
import AppIntents
import Foundation

/// "On it" — the alarm's stop button. Runs in the app process, even if the app wasn't open.
struct CheckInIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Check in"
    static var description = IntentDescription("Log that you're on it.")
    static var openAppWhenRun = false
    static var isDiscoverable = false

    @Parameter(title: "Block ID") var blockId: String
    @Parameter(title: "Alarm ID") var alarmId: String
    @Parameter(title: "Action") var action: String

    init() {
        blockId = ""
        alarmId = ""
        action = "on_it"
    }

    init(blockId: String, alarmId: String, action: String) {
        self.blockId = blockId
        self.alarmId = alarmId
        self.action = action
    }

    func perform() async throws -> some IntentResult {
        let uuid = UUID(uuidString: alarmId)
        if let uuid { try? AlarmManager.shared.stop(id: uuid) }
        // Write to the durable queue first, then try to send.
        await EventQueue.shared.enqueue(OutgoingEvent(type: "checkin", blockId: blockId, payload: ["action": action, "via": "alarm"]))
        if action == "on_it" || action == "skip" {
            AlarmScheduler.cancelRemaining(forBlock: blockId, except: uuid)
        }
        await EventQueue.shared.flush()
        return .result()
    }
}

/// "+15 min" — the alarm's secondary button. Books a local alarm 15 min out and logs a snooze.
struct SnoozeIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Snooze"
    static var description = IntentDescription("Ring again in 15 minutes.")
    static var openAppWhenRun = false
    static var isDiscoverable = false

    @Parameter(title: "Block ID") var blockId: String
    @Parameter(title: "Alarm ID") var alarmId: String
    @Parameter(title: "Label") var label: String

    init() {
        blockId = ""
        alarmId = ""
        label = ""
    }

    init(blockId: String, alarmId: String, label: String) {
        self.blockId = blockId
        self.alarmId = alarmId
        self.label = label
    }

    func perform() async throws -> some IntentResult {
        if let uuid = UUID(uuidString: alarmId) { try? AlarmManager.shared.stop(id: uuid) }
        let base = label.components(separatedBy: " · ").first ?? label
        try? await AlarmScheduler.scheduleLocal(
            label: "\(base) · snoozed",
            blockId: blockId,
            in: TimeInterval(AlarmScheduler.snoozeMinutes * 60)
        )
        await EventQueue.shared.enqueue(OutgoingEvent(type: "checkin", blockId: blockId, payload: ["action": "snooze", "minutes": "\(AlarmScheduler.snoozeMinutes)", "via": "alarm"]))
        await EventQueue.shared.flush()
        return .result()
    }
}

/// Exposed to Shortcuts: "Sync Schedule" runs a full sync in the background, no app UI needed.
struct SyncScheduleIntent: AppIntent {
    static var title: LocalizedStringResource = "Sync Schedule"
    static var description = IntentDescription("Fetch the latest plan and book its alarms.")
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let result = await SyncEngine.shared.sync(reason: "shortcut")
        return .result(dialog: "\(result)")
    }
}

struct AccountableShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SyncScheduleIntent(),
            phrases: ["Sync \(.applicationName)", "Sync my schedule in \(.applicationName)"],
            shortTitle: "Sync Schedule",
            systemImageName: "arrow.triangle.2.circlepath"
        )
    }
}
