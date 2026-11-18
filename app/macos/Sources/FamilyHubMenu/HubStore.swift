import AppKit
import Foundation

/// Fetches `/api/widget`, keeps the last good response on disk for offline use,
/// and derives what the menu bar shows.
@MainActor
final class HubStore: ObservableObject {
    typealias Event = WidgetData.Event

    @Published private(set) var settings: HubSettings
    @Published private(set) var data: WidgetData?
    @Published private(set) var problem: String?
    @Published private(set) var isOffline = false
    @Published private(set) var isLoading = false
    @Published private(set) var now = Date()
    @Published private(set) var trips: [TripSummary] = []
    @Published private(set) var photo: NSImage?
    /// Which item the menu bar shows when it rotates (see MenuBarText.rotate).
    @Published private(set) var rotation = 0

    private var photoIDs: [String] = []
    private var photoListAt = Date.distantPast
    private var photoID: String?

    private let refreshEvery: TimeInterval = 5 * 60
    private let retryEvery: TimeInterval = 60
    private var nextRefresh = Date.distantPast
    private var timer: Timer?
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 20
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    init() {
        settings = HubSettings.load()
        data = Cache.read(view: settings.view)
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                // Give the network a moment to come back after sleep.
                try? await Task.sleep(for: .seconds(5))
                await self?.refresh()
            }
        }
        if isConfigured {
            Task { await refresh() }
        } else {
            DispatchQueue.main.async { SettingsWindow.show(self) }
        }
    }

    /// Opening the menu refreshes data more than a couple of minutes old.
    func refreshIfOld() async {
        if let at = data.flatMap({ Dates.parse($0.generatedAt) }), Date().timeIntervalSince(at) < 120, problem == nil { return }
        await refresh()
    }

    var isConfigured: Bool { !settings.url.isEmpty }

    var hubURL: URL? { URL(string: data?.hubUrl ?? (settings.url.isEmpty ? "" : settings.url + "/")) }

    /// Events that haven't finished yet (the list goes stale between refreshes).
    var events: [Event] { (data?.events ?? []).filter { !$0.isOver(at: now) } }

    func update(_ new: HubSettings) {
        let reload = new.url != settings.url || new.view != settings.view
            || new.clientId != settings.clientId || new.clientSecret != settings.clientSecret
        new.save()
        settings = new
        if reload {
            data = Cache.read(view: new.view)
            problem = nil
            isOffline = false
            Task { await refresh() }
        }
    }

    func refresh() async {
        guard isConfigured, !isLoading else { return }
        isLoading = true
        defer { isLoading = false; now = Date() }
        nextRefresh = Date().addingTimeInterval(retryEvery)
        do {
            let fresh = try await HubClient.fetch(settings, session: session)
            data = fresh
            problem = nil
            isOffline = false
            Cache.write(fresh, view: settings.view)
            nextRefresh = Date().addingTimeInterval(refreshEvery)
            await refreshExtras()
        } catch {
            problem = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            isOffline = data != nil
        }
    }

    /// Trips (every refresh) and the photo list (every 10 minutes). Failures just
    /// leave the old values: these are extras on top of the calendar.
    private func refreshExtras() async {
        if let body = try? await HubClient.get(settings, path: "/api/widget/trips", session: session),
           let list = try? JSONDecoder().decode(TripsResponse.self, from: body) {
            trips = list.trips
        }
        if Date().timeIntervalSince(photoListAt) > 600,
           let body = try? await HubClient.get(settings, path: "/api/widget/photos", session: session),
           let list = try? JSONDecoder().decode(PhotoList.self, from: body) {
            photoIDs = list.photos.map(\.id)
            photoListAt = Date()
            if photo == nil { await nextPhoto() }
        }
    }

    /// Shows a different random photo from the album.
    func nextPhoto() async {
        let choices = photoIDs.filter { $0 != photoID }
        guard let id = choices.randomElement() ?? photoIDs.first else { return }
        let path = "/api/widget/photos/" + (id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)
        if let body = try? await HubClient.get(settings, path: path, session: session), let image = NSImage(data: body) {
            photo = image
            photoID = id
        }
    }

    private func tick() {
        now = Date()
        rotation += 1
        if now >= nextRefresh { Task { await refresh() } }
    }

    // ─── Menu bar text ──────────────────────────────────────────────────────

    /// The next timed event that hasn't started, else one in progress.
    var nextEvent: Event? {
        let timed = events.filter { !$0.allDay }
        return timed.first { ($0.start ?? now) > now } ?? timed.first ?? events.first
    }

    var menuBarText: String {
        guard isConfigured, data != nil else { return "" }
        switch settings.menuBarText {
        case .iconOnly:
            return ""
        case .nextEvent:
            return nextEvent.map(eventText) ?? tripText ?? ""
        case .trip:
            return tripText ?? ""
        case .auto:
            if let e = nextEvent, e.day == "Today", !e.allDay { return eventText(e) }
            return tripText ?? ""
        case .rotate:
            // Next event today, then each trip's countdown; one step per 30-second tick.
            var items: [String] = []
            if let e = nextEvent, e.day == "Today", !e.allDay { items.append(eventText(e)) }
            items += trips.map(tripShort)
            if items.isEmpty, let t = tripText { items.append(t) }
            return items.isEmpty ? "" : items[rotation % items.count]
        }
    }

    private func eventText(_ e: Event) -> String {
        let title = e.title.truncated(24)
        if e.allDay { return e.day == "Today" ? title : "\(e.day): \(title)" }
        if e.day != "Today" { return "\(e.day) \(e.time) · \(title)" }
        if let start = e.start {
            let minutes = Int((start.timeIntervalSince(now) / 60).rounded(.up))
            if minutes <= 0 { return "Now · \(title)" }
            if minutes < 60 { return "in \(minutes)m · \(title)" }
        }
        return "\(e.time) · \(title)"
    }

    private func tripShort(_ t: TripSummary) -> String {
        if t.isActive { return "\(t.title) day \(t.day ?? 1)/\(t.days)" }
        if t.daysUntil <= 1 { return "\(t.title) tomorrow" }
        return "\(t.title) \(t.daysUntil)d"
    }

    private var tripText: String? {
        guard let t = data?.nextTrip else { return nil }
        let mark = t.emoji ?? "✈︎"
        if t.isActive { return "\(mark) Day \(t.day ?? 1)/\(t.days)" }
        if t.daysUntil <= 1 { return "\(mark) tomorrow" }
        return "\(mark) \(t.daysUntil)d"
    }
}

// ─── Network ────────────────────────────────────────────────────────────────

enum HubError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let m): m }
    }
}

enum HubClient {
    /// GET a path on the hub with the service token; the body on 200, else throws.
    static func get(_ settings: HubSettings, path: String, session: URLSession) async throws -> Data {
        guard let url = URL(string: settings.url + path) else { throw HubError.message("Bad URL") }
        var request = URLRequest(url: url)
        if !settings.clientId.isEmpty {
            request.setValue(settings.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
            request.setValue(settings.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        }
        let (body, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw HubError.message("HTTP error") }
        return body
    }

    static func fetch(_ settings: HubSettings, session: URLSession) async throws -> WidgetData {
        guard var components = URLComponents(string: settings.url + "/api/widget") else {
            throw HubError.message("The hub URL isn't valid. Check it in Settings.")
        }
        components.queryItems = [URLQueryItem(name: "view", value: settings.view)]
        guard let url = components.url else { throw HubError.message("The hub URL isn't valid. Check it in Settings.") }

        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !settings.clientId.isEmpty {
            request.setValue(settings.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
            request.setValue(settings.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        }

        let (body, response) = try await session.data(for: request)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        if status == 200, let data = try? JSONDecoder().decode(WidgetData.self, from: body) {
            return data
        }
        if let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
           let message = object["error"] as? String {
            throw HubError.message(message)
        }
        // Access answers a missing or wrong token with 401/403, or a redirect to its login page.
        if status == 401 || status == 403 || http?.url?.host?.contains("cloudflareaccess") == true {
            throw HubError.message("The hub didn't accept this app's service token. Check it in Settings.")
        }
        if status == 404 {
            throw HubError.message("This hub has no /api/widget. It needs cc-family-hub v0.3.0 or later.")
        }
        throw HubError.message("The hub answered \(status).")
    }
}

// ─── Offline cache ──────────────────────────────────────────────────────────

enum Cache {
    private static func file(_ view: String) -> URL? {
        guard let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let folder = dir.appendingPathComponent(Bundle.main.bundleIdentifier ?? "family-hub", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safe = view.filter { $0.isLetter || $0.isNumber || $0 == "-" }
        return folder.appendingPathComponent("widget-\(safe).json")
    }

    static func read(view: String) -> WidgetData? {
        guard let url = file(view), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(WidgetData.self, from: data)
    }

    static func write(_ value: WidgetData, view: String) {
        guard let url = file(view), let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
