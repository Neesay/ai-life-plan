import Foundation

struct Block: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let category: String
    let startAt: Date
    let endAt: Date
    let startLocal: String
    let endLocal: String
    let alarmOffsetsMin: [Int]
    let alarmLabel: String
    let requiredPlace: String?
    let status: String
    let source: String
    let version: Int

    var isActive: Bool { status == "planned" || status == "moved" }
}

/// One alarm the server wants booked. `id` is a deterministic UUID that changes whenever
/// the alarm's time or label changes, so the phone just diffs id sets.
struct AlarmSpec: Codable, Identifiable, Hashable {
    let id: String
    let key: String
    let blockId: String
    let offsetMin: Int
    let fireAt: Date
    let fireLocal: String
    let label: String
    let category: String
}

struct ScheduleResponse: Codable {
    let version: String
    let generatedAt: Date
    let blocks: [Block]
    let alarms: [AlarmSpec]
}

struct Place: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let lat: Double
    let lng: Double
    let radiusM: Int
}

struct PlacesResponse: Codable {
    let places: [Place]
}

/// An event waiting to be posted. `clientId` makes retries idempotent on the server.
struct OutgoingEvent: Codable, Identifiable, Hashable {
    var id: String { clientId }
    let clientId: String
    let type: String
    let ts: Date
    let blockId: String?
    let payload: [String: String]
    let source: String

    init(type: String, blockId: String? = nil, payload: [String: String] = [:], ts: Date = Date()) {
        self.clientId = UUID().uuidString
        self.type = type
        self.ts = ts
        self.blockId = blockId
        self.payload = payload
        self.source = "app"
    }
}

enum JSON {
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            if let date = parseISO(s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Bad date \(s)"))
        }
        return d
    }()

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(formatISO(date))
        }
        return e
    }()

    static func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    static func formatISO(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }
}
