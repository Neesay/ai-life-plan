import Foundation

enum APIError: LocalizedError {
    case notConfigured
    case http(Int, String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Set the server URL and API token in Settings."
        case let .http(code, body): return "Server returned \(code): \(body.prefix(200))"
        }
    }
}

struct APIClient {
    var baseURL: String = AppSettings.serverURL
    var token: String = AppSettings.apiToken

    private func request(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: Data? = nil) throws -> URLRequest {
        guard !baseURL.isEmpty, !token.isEmpty,
              var comps = URLComponents(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)
        else { throw APIError.notConfigured }
        if !query.isEmpty { comps.queryItems = query }
        guard let url = comps.url else { throw APIError.notConfigured }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private func send<T: Decodable>(_ req: URLRequest, as: T.Type) async throws -> T {
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(code) else { throw APIError.http(code, String(decoding: data, as: UTF8.self)) }
        return try JSON.decoder.decode(T.self, from: data)
    }

    func schedule(hours: Double = 48) async throws -> ScheduleResponse {
        let now = Date()
        let req = try request("/api/schedule", query: [
            URLQueryItem(name: "from", value: JSON.formatISO(now)),
            URLQueryItem(name: "to", value: JSON.formatISO(now.addingTimeInterval(hours * 3600))),
            URLQueryItem(name: "client", value: "ios"),
        ])
        return try await send(req, as: ScheduleResponse.self)
    }

    func places() async throws -> [Place] {
        try await send(request("/api/places"), as: PlacesResponse.self).places
    }

    struct PostResult: Decodable { let inserted: Int; let duplicates: Int }

    func post(events: [OutgoingEvent]) async throws -> PostResult {
        let body = try JSON.encoder.encode(["events": events])
        return try await send(request("/api/events", method: "POST", body: body), as: PostResult.self)
    }
}

/// Durable outbox. Every event is written to disk before any network call, and the whole
/// queue is flushed on every launch/sync, so nothing depends on background observers.
actor EventQueue {
    static let shared = EventQueue()
    private let file = "event-queue.json"

    func enqueue(_ event: OutgoingEvent) {
        var q = Store.load([OutgoingEvent].self, file) ?? []
        q.append(event)
        if q.count > 2000 { q.removeFirst(q.count - 2000) }
        Store.save(q, file)
    }

    var pendingCount: Int { (Store.load([OutgoingEvent].self, file) ?? []).count }

    /// Posts everything queued. Events stay queued until the server acknowledges them.
    @discardableResult
    func flush() async -> Bool {
        let q = Store.load([OutgoingEvent].self, file) ?? []
        guard !q.isEmpty else { return true }
        do {
            for chunk in stride(from: 0, to: q.count, by: 200) {
                _ = try await APIClient().post(events: Array(q[chunk ..< min(chunk + 200, q.count)]))
            }
            // Only drop what we sent; anything enqueued meanwhile stays.
            let sent = Set(q.map(\.clientId))
            let remaining = (Store.load([OutgoingEvent].self, file) ?? []).filter { !sent.contains($0.clientId) }
            Store.save(remaining, file)
            return true
        } catch {
            return false
        }
    }

    /// Enqueue and try to send straight away.
    func record(_ event: OutgoingEvent) async {
        enqueue(event)
        await flush()
    }
}
