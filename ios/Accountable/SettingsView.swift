import AlarmKit
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var engine: SyncEngine
    @StateObject private var location = LocationPermission.shared
    @State private var serverURL = AppSettings.serverURL
    @State private var token = AppSettings.apiToken
    @State private var message: String?
    @State private var alarmAuth = AlarmScheduler.authorizationState
    @State private var regions = 0

    var body: some View {
        Form {
            Section("Server") {
                TextField("https://your-app.vercel.app", text: $serverURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("API token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Save") {
                    AppSettings.serverURL = serverURL
                    AppSettings.apiToken = token
                    Task { message = await engine.sync(reason: "settings") }
                }
            }

            Section("Status") {
                LabeledContent("Last sync", value: engine.lastSync?.formatted(date: .abbreviated, time: .standard) ?? "never")
                LabeledContent("Alarms booked", value: "\(engine.bookedCount)")
                LabeledContent("Schedule version", value: engine.schedule?.version ?? "–")
                LabeledContent("Queued events", value: "\(engine.pendingEvents)")
                LabeledContent("Alarm permission", value: alarmAuthLabel)
                LabeledContent("Location", value: location.label)
                LabeledContent("Geofences", value: "\(regions)")
                if let error = engine.lastError {
                    Text(error).foregroundStyle(.red).font(.footnote)
                }
            }

            Section("Actions") {
                Button("Sync now") {
                    Task { message = await engine.sync(reason: "manual") }
                }
                Button("Test alarm in 1 min") {
                    Task {
                        guard await AlarmScheduler.requestAuthorization() else {
                            message = "AlarmKit permission denied — enable it in iOS Settings → Accountable."
                            return
                        }
                        do {
                            try await AlarmScheduler.scheduleLocal(label: "TEST ALARM", blockId: "test", in: 60)
                            message = "Test alarm booked for 1 minute from now. Lock the phone and put it on Silent."
                        } catch {
                            message = "AlarmKit refused: \(error.localizedDescription)"
                        }
                    }
                }
                Button("Allow alarms") {
                    Task {
                        _ = await AlarmScheduler.requestAuthorization()
                        alarmAuth = AlarmScheduler.authorizationState
                    }
                }
                Button("Allow location (Always)") { location.request() }
            }

            if let message {
                Section { Text(message).font(.footnote) }
            }
        }
        .navigationTitle("Settings")
        .task {
            alarmAuth = AlarmScheduler.authorizationState
            regions = await LocationMonitor.shared.regionCount
            await engine.refreshPendingCount()
        }
    }

    private var alarmAuthLabel: String {
        switch alarmAuth {
        case .authorized: "Allowed ✓"
        case .denied: "Denied — enable in iOS Settings"
        case .notDetermined: "Not asked yet"
        @unknown default: "Unknown"
        }
    }
}
