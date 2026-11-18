import CoreLocation
import Foundation

/// Geofences for the places from /api/places. Enter/exit → place_enter / place_exit events,
/// and every crossing piggybacks a sync (it's one of the few background wake-ups we get).
actor LocationMonitor {
    static let shared = LocationMonitor()
    private static let monitorName = "places"

    private var monitor: CLMonitor?
    private var session: CLServiceSession?
    private var listening = false

    /// Call on every launch, including background relaunches caused by region events.
    func start() async {
        guard monitor == nil else { return }
        session = CLServiceSession(authorization: .always)
        let m = await CLMonitor(Self.monitorName)
        monitor = m
        guard !listening else { return }
        listening = true
        Task.detached {
            do {
                for try await event in await m.events {
                    await LocationMonitor.shared.handle(event)
                }
            } catch {
                await LocationMonitor.shared.stopped()
            }
        }
    }

    private func stopped() { listening = false }

    private func handle(_ event: CLMonitor.Event) async {
        let type: String
        switch event.state {
        case .satisfied: type = "place_enter"
        case .unsatisfied: type = "place_exit"
        default: return
        }
        await EventQueue.shared.enqueue(OutgoingEvent(type: type, payload: ["place": event.identifier, "via": "geofence"], ts: event.date))
        await SyncEngine.shared.sync(reason: "geofence")
    }

    func update(places: [Place]) async {
        await start()
        guard let monitor else { return }
        let wanted = Dictionary(places.prefix(20).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for id in await monitor.identifiers where wanted[id] == nil {
            await monitor.remove(id)
        }
        for (id, place) in wanted {
            let condition = CLMonitor.CircularGeographicCondition(
                center: CLLocationCoordinate2D(latitude: place.lat, longitude: place.lng),
                radius: CLLocationDistance(place.radiusM)
            )
            // add() replaces an existing condition with the same identifier.
            await monitor.add(condition, identifier: id, assuming: .unsatisfied)
        }
    }

    var regionCount: Int {
        get async { await monitor?.identifiers.count ?? 0 }
    }
}

/// Owns the CLLocationManager used only to ask for When-In-Use then Always permission.
@MainActor
final class LocationPermission: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = LocationPermission()
    private let manager = CLLocationManager()
    @Published var status: CLAuthorizationStatus

    override init() {
        status = manager.authorizationStatus
        super.init()
        manager.delegate = self
    }

    func request() {
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        default: break
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let s = manager.authorizationStatus
        Task { @MainActor in
            self.status = s
            if s == .authorizedWhenInUse { self.manager.requestAlwaysAuthorization() }
            if s == .authorizedAlways || s == .authorizedWhenInUse { await LocationMonitor.shared.start() }
        }
    }

    var label: String {
        switch status {
        case .authorizedAlways: return "Always ✓"
        case .authorizedWhenInUse: return "While using (needs Always)"
        case .denied, .restricted: return "Denied — enable in Settings"
        case .notDetermined: return "Not asked yet"
        @unknown default: return "Unknown"
        }
    }
}
