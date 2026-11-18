import SwiftUI

@main
struct AccountableApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var engine = SyncEngine.shared

    init() {
        Task {
            await LocationMonitor.shared.start()
            await EventQueue.shared.flush()
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(engine)
                .onOpenURL { url in
                    // accountable://sync (used by Shortcuts automations)
                    Task { await engine.sync(reason: "url:\(url.host ?? "")") }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    await AlarmScheduler.requestAuthorization()
                    await engine.sync(reason: "foreground")
                }
            }
        }
        .backgroundTask(.appRefresh(SyncEngine.refreshTaskId)) {
            SyncEngine.scheduleBackgroundRefresh()
            await SyncEngine.shared.sync(reason: "background")
        }
    }
}

struct RootView: View {
    @EnvironmentObject var engine: SyncEngine

    var body: some View {
        TabView {
            Tab("Today", systemImage: "checklist") {
                NavigationStack { TodayView() }
            }
            Tab("Settings", systemImage: "gearshape") {
                NavigationStack { SettingsView() }
            }
        }
    }
}
