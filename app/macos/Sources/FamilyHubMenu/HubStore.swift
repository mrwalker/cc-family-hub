import AppKit
import Foundation

/// Fetches the stream (`/api/stream`), keeps the last good response on disk for
/// offline use, loads card images, and derives what the menu bar shows.
@MainActor
final class HubStore: ObservableObject {
    typealias Event = TodayData.Event

    @Published private(set) var settings: HubSettings
    @Published private(set) var data: StreamResponse?
    @Published private(set) var problem: String?
    @Published private(set) var isOffline = false
    @Published private(set) var isLoading = false
    @Published private(set) var now = Date()
    /// Card images by URL (`glance.image`), for the cards in the current stream.
    @Published private(set) var images: [String: NSImage] = [:]
    /// Which headline the menu bar shows when it rotates (see MenuBarText.rotate).
    @Published private(set) var rotation = 0

    private var imageLoads: Set<String> = []
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

    /// `live: false` (snapshots) skips the timers, the wake refresh and the first-run Settings window.
    init(settings: HubSettings = .load(), live: Bool = true) {
        self.settings = settings
        data = Cache.read(view: settings.view)
        guard live else { return }
        // Every 30 seconds: the menu bar's rotation step, and the refresh check.
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
        if let at = generatedAt, Date().timeIntervalSince(at) < 120, problem == nil { return }
        await refresh()
    }

    var isConfigured: Bool { !settings.url.isEmpty }

    var generatedAt: Date? { data.flatMap { Dates.parse($0.generatedAt) } }

    var hubURL: URL? {
        let hub = data?.hubUrl ?? ""
        return URL(string: !hub.isEmpty ? hub : (settings.url.isEmpty ? "" : settings.url + "/"))
    }

    var cards: [Card] { data?.cards ?? [] }

    /// The `today` card, which the panel keeps in view above the rotation.
    var todayCard: Card? { cards.first { $0.component == "today" && $0.today != nil } }

    /// The cards the panel rotates through: the whole stream, less the `today` anchor.
    var panelCards: [Card] {
        guard let anchor = todayCard else { return cards }
        return cards.filter { $0.id != anchor.id }
    }

    /// Today's and tomorrow's events that haven't finished yet (the list goes stale between refreshes).
    var events: [Event] { (todayCard?.today?.events ?? []).filter { !$0.isOver(at: now) } }

    func update(_ new: HubSettings) {
        let reload = new.url != settings.url || new.view != settings.view
            || new.clientId != settings.clientId || new.clientSecret != settings.clientSecret
        new.save()
        settings = new
        if reload {
            data = Cache.read(view: new.view)
            images = [:]
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
            let (fresh, body) = try await HubClient.fetchStream(settings, session: session)
            data = fresh
            problem = nil
            isOffline = false
            Cache.write(body, view: settings.view)
            nextRefresh = Date().addingTimeInterval(refreshEvery)
            // Keep only the images this stream still uses.
            let wanted = Set(fresh.cards.compactMap(\.glance.image))
            images = images.filter { wanted.contains($0.key) }
        } catch {
            problem = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            isOffline = data != nil
        }
    }

    func image(for card: Card) -> NSImage? {
        card.glance.image.flatMap { images[$0] }
    }

    /// Loads a card's image if it has one and it isn't loaded yet. A failure leaves the
    /// card on its glance layout.
    func loadImage(for card: Card) async {
        guard let url = card.glance.image, images[url] == nil, !imageLoads.contains(url) else { return }
        imageLoads.insert(url)
        defer { imageLoads.remove(url) }
        if let body = try? await HubClient.getImage(settings, url: url, session: session),
           let image = NSImage(data: body) {
            images[url] = image
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

    var menuBarText: String { menuBarText(settings.menuBarText) }

    func menuBarText(_ mode: MenuBarText) -> String {
        guard isConfigured, data != nil else { return "" }
        switch mode {
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
            let items = rotateItems
            return items.isEmpty ? "" : items[rotation % items.count]
        }
    }

    /// Every card's headline, in stream order: what Rotate steps through.
    var rotateItems: [String] { cards.map(\.shortText).filter { !$0.isEmpty } }

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

    /// The first trip card's headline ("🏖️ 12 days", "🏖️ Day 2 of 5"). An active trip leads the stream.
    private var tripText: String? {
        guard let trip = cards.first(where: { $0.component == "trips" }), !trip.glance.headline.isEmpty else { return nil }
        return "\(trip.glance.emoji ?? "✈︎") \(trip.glance.headline.truncated(28))"
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
    private static func request(_ settings: HubSettings, _ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        // The service token goes only to the hub itself.
        if !settings.clientId.isEmpty, let hub = URL(string: settings.url),
           url.host == hub.host, url.port == hub.port, url.scheme == hub.scheme {
            request.setValue(settings.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
            request.setValue(settings.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        }
        return request
    }

    /// A card image (`glance.image`, under `/api/stream/image/…`).
    static func getImage(_ settings: HubSettings, url: String, session: URLSession) async throws -> Data {
        guard let url = URL(string: url) else { throw HubError.message("Bad URL") }
        let (body, response) = try await session.data(for: request(settings, url))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw HubError.message("HTTP error") }
        return body
    }

    /// The stream for this Mac, and its raw body for the offline cache.
    static func fetchStream(_ settings: HubSettings, session: URLSession) async throws -> (StreamResponse, Data) {
        guard var components = URLComponents(string: settings.url + "/api/stream") else {
            throw HubError.message("The hub URL isn't valid. Check it in Settings.")
        }
        components.queryItems = [
            URLQueryItem(name: "view", value: settings.view),
            URLQueryItem(name: "output", value: "mac-menu-bar"),
        ]
        guard let url = components.url else { throw HubError.message("The hub URL isn't valid. Check it in Settings.") }

        var req = request(settings, url)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let (body, response) = try await session.data(for: req)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        // Access answers a missing or wrong token with 401/403, or a redirect to its login page.
        if status == 401 || status == 403 || http?.url?.host?.contains("cloudflareaccess") == true {
            throw HubError.message("The hub didn't accept this app's service token. Check it in Settings.")
        }
        if status == 200 {
            if let stream = try? JSONDecoder().decode(StreamResponse.self, from: body) { return (stream, body) }
            throw HubError.message("The hub's answer wasn't a stream. Check the hub URL in Settings.")
        }
        if status == 404 {
            throw HubError.message("This hub has no /api/stream. Upgrade its cc-family-hub to v0.9.0 or later.")
        }
        // The hub explains other refusals, e.g. an unknown view.
        if let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
           let message = object["error"] as? String {
            throw HubError.message(message)
        }
        throw HubError.message("The hub answered \(status).")
    }
}

// ─── Offline cache ──────────────────────────────────────────────────────────

/// The last stream response for each view, as the hub sent it.
enum Cache {
    private static var folder: URL? {
        guard let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let folder = dir.appendingPathComponent(Bundle.main.bundleIdentifier ?? "family-hub", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private static func safe(_ view: String) -> String {
        view.filter { $0.isLetter || $0.isNumber || $0 == "-" }
    }

    static func read(view: String) -> StreamResponse? {
        guard let url = folder?.appendingPathComponent("stream-\(safe(view)).json"),
              let body = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(StreamResponse.self, from: body)
    }

    static func write(_ body: Data, view: String) {
        guard let folder else { return }
        try? body.write(to: folder.appendingPathComponent("stream-\(safe(view)).json"), options: .atomic)
        // The /api/widget cache from before the stream.
        try? FileManager.default.removeItem(at: folder.appendingPathComponent("widget-\(safe(view)).json"))
    }
}
