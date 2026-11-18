import Foundation

/// The response of `GET /api/widget` (see app/worker/widget.js).
struct WidgetData: Codable, Equatable {
    struct Member: Codable, Equatable, Hashable {
        let id: String
        let name: String
        let color: String
    }

    struct Event: Codable, Equatable {
        let title: String
        let day: String        // "Today" | "Tomorrow"
        let time: String       // "3:20 PM" | "All day", in the family's timezone
        let startAt: String
        let endAt: String?
        let allDay: Bool
        let location: String?
        let members: [String]
        let colors: [String]
    }

    struct Trip: Codable, Equatable {
        let id: String
        let name: String
        let emoji: String?
        let startDate: String
        let endDate: String
        let status: String     // "upcoming" | "active"
        let daysUntil: Int
        let day: Int?
        let days: Int
        let url: String

        var isActive: Bool { status == "active" }
        var displayName: String { emoji.map { "\($0) \(name)" } ?? name }
    }

    let title: String
    let view: Member?
    let members: [Member]
    let events: [Event]
    let moreEvents: Int?
    let eventsError: String?
    let nextTrip: Trip?
    let hubUrl: String
    let generatedAt: String
}

extension WidgetData.Event {
    var start: Date? { allDay ? nil : Dates.parse(startAt) }
    var end: Date? { allDay ? nil : endAt.flatMap(Dates.parse) }

    func isOver(at now: Date) -> Bool {
        guard let finish = end ?? start else { return false }
        return finish <= now
    }

    func isHappening(at now: Date) -> Bool {
        guard let start, start <= now else { return false }
        return !isOver(at: now)
    }
}

enum Dates {
    private static let internet: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let ymd: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .gmt
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let monthDay: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = .gmt
        f.setLocalizedDateFormatFromTemplate("MMMd")
        return f
    }()

    static func parse(_ s: String) -> Date? {
        internet.date(from: s) ?? fractional.date(from: s)
    }

    static func shortTime(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    /// "Nov 24 – Nov 28" from two YYYY-MM-DD dates.
    static func range(_ from: String, _ to: String) -> String {
        guard let a = ymd.date(from: from), let b = ymd.date(from: to) else { return "" }
        return "\(monthDay.string(from: a)) – \(monthDay.string(from: b))"
    }
}

extension String {
    func truncated(_ max: Int) -> String {
        count <= max ? self : String(prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }
}
