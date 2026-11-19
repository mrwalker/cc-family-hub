import Foundation

/// The response of `GET /api/stream` (see docs/stream.md and app/worker/stream.js).
///
/// Decoding is lenient on purpose: every card has an envelope and a `glance`, which is
/// all the panel needs to draw it. `data` is decoded only for the components this app
/// draws natively (`today`, `trips`, `grocery`), so a component or field it doesn't know
/// still shows, from its glance.
struct StreamResponse: Decodable {
    struct Member: Decodable, Hashable {
        let id: String
        let name: String
        let color: String
    }

    struct ComponentError: Decodable {
        let component: String
        let error: String
    }

    let title: String
    let view: Member?
    let members: [Member]
    let hubUrl: String
    let generatedAt: String
    let cards: [Card]
    let errors: [ComponentError]

    private enum Keys: String, CodingKey { case title, view, members, hubUrl, generatedAt, cards, errors }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        // A response without a cards list isn't a stream.
        guard c.contains(.cards) else {
            throw DecodingError.keyNotFound(Keys.cards, .init(codingPath: [], debugDescription: "No cards"))
        }
        title = c.value(.title) ?? "Family Hub"
        view = c.value(.view)
        members = c.list(.members)
        hubUrl = c.value(.hubUrl) ?? ""
        generatedAt = c.value(.generatedAt) ?? ""
        cards = c.list(.cards)
        errors = c.list(.errors)
    }

    func member(_ id: String) -> Member? { members.first { $0.id == id } }
}

/// One card of the stream: the envelope, its glance, and `data` for known components.
struct Card: Decodable, Identifiable {
    struct Glance: Decodable {
        let headline: String
        let detail: String
        let image: String?
        let emoji: String?
        let colors: [String]

        private enum Keys: String, CodingKey { case headline, detail, image, emoji, colors }

        init(headline: String) {
            self.headline = headline
            detail = ""
            image = nil
            emoji = nil
            colors = []
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            headline = c.value(.headline) ?? ""
            detail = c.value(.detail) ?? ""
            image = c.value(.image).flatMap { (s: String) in s.isEmpty ? nil : s }
            emoji = c.value(.emoji).flatMap { (s: String) in s.isEmpty ? nil : s }
            colors = c.list(.colors)
        }
    }

    let id: String
    let component: String
    let title: String
    /// Seconds to stay up in the panel.
    let dwell: Double
    let url: String?
    let glance: Glance

    // `data`, for the components drawn natively. Nil for any other component, or
    // when the data can't be read (the card then falls back to its glance).
    let today: TodayData?
    let trip: TripData?
    let grocery: GroceryData?

    private enum Keys: String, CodingKey { case id, component, title, dwell, url, glance, data }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        component = c.value(.component) ?? String(id.split(separator: ":").first ?? "")
        title = c.value(.title) ?? ""
        dwell = max(3, c.number(.dwell) ?? 15)
        url = c.value(.url).flatMap { (s: String) in s.isEmpty ? nil : s }
        glance = c.value(.glance) ?? Glance(headline: title)
        today = component == "today" ? c.value(.data) : nil
        trip = component == "trips" ? c.value(.data) : nil
        grocery = component == "grocery" ? c.value(.data) : nil
    }

    /// The glance headline as one short line, with the card's emoji in front.
    var shortText: String {
        let headline = glance.headline.truncated(28)
        guard !headline.isEmpty else { return "" }
        return glance.emoji.map { "\($0) \(headline)" } ?? headline
    }
}

// ─── data for the native layouts ────────────────────────────────────────────

/// `today`: the rest of today and all of tomorrow (app/worker/components/today.js).
struct TodayData: Decodable {
    struct Event: Decodable {
        let title: String
        let day: String        // "Today" | "Tomorrow"
        let time: String       // "3:20 PM" | "All day", in the family's timezone
        let startAt: String
        let endAt: String?
        let allDay: Bool
        let location: String?
        let members: [String]
        let colors: [String]

        private enum Keys: String, CodingKey { case title, day, time, startAt, endAt, allDay, location, members, colors }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            title = try c.decode(String.self, forKey: .title)
            day = c.value(.day) ?? "Today"
            time = c.value(.time) ?? ""
            startAt = c.value(.startAt) ?? ""
            endAt = c.value(.endAt)
            allDay = c.value(.allDay) ?? false
            location = c.value(.location).flatMap { (s: String) in s.isEmpty ? nil : s }
            members = c.list(.members)
            colors = c.list(.colors)
        }
    }

    struct Flag: Decodable {
        let severity: String
        let message: String
    }

    let events: [Event]
    let moreEvents: Int
    let flags: [Flag]
    let eventsError: String?

    private enum Keys: String, CodingKey { case events, moreEvents, flags, eventsError }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        events = c.list(.events)
        moreEvents = c.int(.moreEvents) ?? 0
        flags = c.list(.flags)
        eventsError = c.value(.eventsError)
    }
}

extension TodayData.Event {
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

/// `trips`: one upcoming or active trip (app/worker/components/trips.js).
struct TripData: Decodable {
    struct Row: Decodable {
        let name: String
        let color: String
        let points: Int

        private enum Keys: String, CodingKey { case name, color, points }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            name = try c.decode(String.self, forKey: .name)
            color = c.value(.color) ?? "#888888"
            points = c.int(.points) ?? 0
        }
    }

    /// One stop on an active trip's schedule for today.
    struct Stop: Decodable {
        let time: String
        let emoji: String?
        let title: String

        private enum Keys: String, CodingKey { case time, emoji, title }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            title = try c.decode(String.self, forKey: .title)
            time = c.value(.time) ?? ""
            emoji = c.value(.emoji)
        }
    }

    let name: String
    let dates: String
    let status: String     // "upcoming" | "active"
    let daysUntil: Int
    let day: Int?
    let days: Int
    let countdown: String?
    let who: [String]
    let leaderboard: [Row]
    let questsDone: Int
    let questsTotal: Int
    let today: [Stop]

    private enum Keys: String, CodingKey {
        case name, dates, status, daysUntil, day, days, countdown, who, leaderboard, questsDone, questsTotal, today
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = try c.decode(String.self, forKey: .name)
        dates = c.value(.dates) ?? ""
        status = c.value(.status) ?? "upcoming"
        daysUntil = c.int(.daysUntil) ?? 0
        day = c.int(.day)
        days = c.int(.days) ?? 0
        countdown = c.value(.countdown).flatMap { (s: String) in s.isEmpty ? nil : s }
        who = c.list(.who)
        leaderboard = c.list(.leaderboard)
        questsDone = c.int(.questsDone) ?? 0
        questsTotal = c.int(.questsTotal) ?? 0
        today = c.list(.today)
    }

    var isActive: Bool { status == "active" }
}

/// `grocery`: the shared shopping list (app/worker/components/grocery.js).
struct GroceryData: Decodable {
    struct Item: Decodable {
        let name: String
        let quantity: Int
        let store: String?
        let done: Bool

        private enum Keys: String, CodingKey { case name, quantity, store, done }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            name = try c.decode(String.self, forKey: .name)
            quantity = c.int(.quantity) ?? 1
            store = c.value(.store).flatMap { (s: String) in s.isEmpty ? nil : s }
            done = c.value(.done) ?? false
        }
    }

    let items: [Item]

    private enum Keys: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        items = try decoder.container(keyedBy: Keys.self).list(.items)
    }

    var toBuy: [Item] { items.filter { !$0.done } }
}

// ─── lenient decoding ───────────────────────────────────────────────────────

/// Decodes to nil instead of failing, so one bad element doesn't lose a whole list.
private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension KeyedDecodingContainer {
    /// The value, or nil when it's missing, null, or of another type.
    func value<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }

    /// The list's readable elements, or [] when it's missing or not a list.
    func list<T: Decodable>(_ key: Key) -> [T] {
        ((try? decodeIfPresent([Lossy<T>].self, forKey: key)) ?? nil)?.compactMap(\.value) ?? []
    }

    /// A number given as a number or a numeric string.
    func number(_ key: Key) -> Double? {
        if let d: Double = value(key) { return d }
        if let s: String = value(key) { return Double(s.trimmingCharacters(in: .whitespaces)) }
        return nil
    }

    func int(_ key: Key) -> Int? { number(key).map { Int($0.rounded()) } }
}

// ─── formatting ─────────────────────────────────────────────────────────────

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

    static func parse(_ s: String) -> Date? {
        internet.date(from: s) ?? fractional.date(from: s)
    }

    static func shortTime(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    /// "3:20 PM" today, else "Nov 18, 3:20 PM".
    static func asOf(_ date: Date) -> String {
        Calendar.current.isDateInToday(date)
            ? shortTime(date)
            : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}

extension String {
    func truncated(_ max: Int) -> String {
        count <= max ? self : String(prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }
}
