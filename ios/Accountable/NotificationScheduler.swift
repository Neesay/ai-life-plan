import Foundation
import UserNotifications

/// Quiet reminders: ordinary notifications that obey the Silent switch (used for lectures,
/// meetings, and any alarm that falls inside a quiet block).
enum NotificationScheduler {
    /// Server-managed notifications. Anything with this prefix not in the server list is removed.
    static let serverPrefix = "acc-"
    /// Local-only notifications (snoozes). Never removed by reconcile.
    static let localPrefix = "accl-"
    static let category = "BLOCK"

    static func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            return (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        }
        return settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
    }

    static func registerCategories() {
        let onIt = UNNotificationAction(identifier: "on_it", title: "On it", options: [])
        let snooze = UNNotificationAction(identifier: "snooze", title: "+15 min", options: [])
        let skip = UNNotificationAction(identifier: "skip", title: "Skip", options: [.foreground])
        let cat = UNNotificationCategory(identifier: category, actions: [onIt, snooze, skip], intentIdentifiers: [])
        UNUserNotificationCenter.current().setNotificationCategories([cat])
    }

    private static func content(title: String, body: String, blockId: String) -> UNMutableNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        c.sound = .default // silent when the phone is on Silent
        c.categoryIdentifier = category
        c.userInfo = ["blockId": blockId, "label": title]
        c.interruptionLevel = .active
        return c
    }

    private static func trigger(at date: Date) -> UNCalendarNotificationTrigger {
        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
    }

    /// Make pending notifications match the server's notification-type alarms. Returns how many are booked.
    @discardableResult
    static func reconcile(with specs: [AlarmSpec]) async -> Int {
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests().map(\.identifier)
        let wanted = Dictionary(specs.map { (serverPrefix + $0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let stale = pending.filter { $0.hasPrefix(serverPrefix) && wanted[$0] == nil }
        center.removePendingNotificationRequests(withIdentifiers: stale)
        let existing = Set(pending)
        for (id, spec) in wanted where !existing.contains(id) && spec.fireAt > Date() {
            let body = spec.quieted == true ? "Quiet reminder (you're in a quiet block)" : spec.fireLocal
            let request = UNNotificationRequest(identifier: id, content: content(title: spec.label, body: body, blockId: spec.blockId), trigger: trigger(at: spec.fireAt))
            try? await center.add(request)
        }
        return wanted.count
    }

    static func scheduleLocal(title: String, blockId: String, in seconds: TimeInterval) async {
        let request = UNNotificationRequest(
            identifier: localPrefix + UUID().uuidString,
            content: content(title: title, body: "Snoozed reminder", blockId: blockId),
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(seconds, 1), repeats: false)
        )
        try? await UNUserNotificationCenter.current().add(request)
    }
}

/// Handles the notification action buttons (On it / +15 / Skip) and shows banners in the foreground.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let blockId = info["blockId"] as? String else { return }
        let label = info["label"] as? String ?? "Reminder"
        let action: String
        switch response.actionIdentifier {
        case "on_it": action = "on_it"
        case "snooze": action = "snooze"
        case "skip": action = "skip"
        default: return // plain tap just opens the app
        }
        await EventQueue.shared.enqueue(OutgoingEvent(type: "checkin", blockId: blockId, payload: ["action": action, "via": "notification"]))
        if action == "snooze" {
            let base = label.components(separatedBy: " · ").first ?? label
            await NotificationScheduler.scheduleLocal(title: "\(base) · snoozed", blockId: blockId, in: TimeInterval(AlarmScheduler.snoozeMinutes * 60))
        } else {
            AlarmScheduler.cancelRemaining(forBlock: blockId)
        }
        await EventQueue.shared.flush()
    }
}
