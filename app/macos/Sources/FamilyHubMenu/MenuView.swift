import AppKit
import SwiftUI

/// The panel that opens from the menu bar: today and tomorrow on top, and below them
/// the rest of the stream, one card at a time.
struct MenuView: View {
    @EnvironmentObject var store: HubStore
    /// Snapshots only: the card the rotation starts on (a card id, a component, or an index).
    var startCard: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if !store.isConfigured {
                setupPrompt
            } else {
                if let problem = store.problem { banner(problem) }
                if let data = store.data {
                    if let today = store.todayCard, let todayData = today.today {
                        TodayAnchor(card: today, today: todayData, events: store.events, data: data, now: store.now)
                    }
                    if !store.panelCards.isEmpty {
                        CardRotator(cards: store.panelCards, start: startCard)
                    } else if store.todayCard == nil {
                        Text("Nothing in the stream right now").font(.callout).foregroundStyle(.secondary)
                    }
                } else if store.isLoading {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                }
            }
            Divider()
            footer
        }
        .padding(14)
        .frame(width: 340)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(store.data?.view.map { Color(hex: $0.color) } ?? Color.accentColor)
                .frame(width: 8, height: 8)
            Text(store.data?.view?.name ?? "Family").font(.headline)
            Spacer()
            if store.isLoading { ProgressView().controlSize(.mini) }
            Text(store.data?.title ?? "Family Hub").font(.caption).foregroundStyle(.secondary)
        }
    }

    private var setupPrompt: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Connect to your hub to see today, the next trip, and the rest of the stream.")
                .foregroundStyle(.secondary)
            Button("Set Up…") { SettingsWindow.show(store) }
        }
    }

    private func banner(_ problem: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: store.isOffline ? "wifi.slash" : "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                if store.isOffline, let at = store.generatedAt {
                    Text("Offline · as of \(Dates.asOf(at))").font(.caption.weight(.semibold))
                }
                Text(problem).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.12)))
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button("Open Hub") { openURL(store.hubURL?.absoluteString) }
                .disabled(store.hubURL == nil)
            Spacer()
            if store.problem == nil, let at = store.generatedAt {
                Text("Updated \(Dates.shortTime(at))").font(.caption).foregroundStyle(.tertiary)
            }
            Button { Task { await store.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                .help("Refresh (⌘R)")
                .keyboardShortcut("r")
                .disabled(store.isLoading || !store.isConfigured)
            Button { SettingsWindow.show(store) } label: { Image(systemName: "gearshape") }
                .help("Settings (⌘,)")
                .keyboardShortcut(",")
            Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }
                .help("Quit Family Hub (⌘Q)")
                .keyboardShortcut("q")
        }
        .buttonStyle(.borderless)
    }
}

// ─── today: the anchor ──────────────────────────────────────────────────────

/// The `today` card: urgent flags, then events under Today / Tomorrow headings.
struct TodayAnchor: View {
    let card: Card
    let today: TodayData
    let events: [TodayData.Event]
    let data: StreamResponse
    let now: Date

    private var groups: [(day: String, events: [TodayData.Event])] {
        var out: [(day: String, events: [TodayData.Event])] = []
        for e in events {
            if out.last?.day == e.day { out[out.count - 1].events.append(e) } else { out.append((e.day, [e])) }
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(today.flags.prefix(3).enumerated()), id: \.offset) { _, flag in
                Label(flag.message, systemImage: "exclamationmark.circle.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
            if let error = today.eventsError, events.isEmpty {
                Text("Calendars didn't load: \(error)").font(.callout).foregroundStyle(.secondary)
            } else if events.isEmpty {
                Text("Nothing else today or tomorrow").font(.callout).foregroundStyle(.secondary)
            } else if events.count > 9 && !Snapshot.isRequested {
                // (ImageRenderer can't draw a ScrollView, so snapshots show the whole list.)
                ScrollView { list }.frame(height: 380)
            } else {
                list
            }
        }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(groups, id: \.day) { group in
                SectionLabel(text: group.day)
                    .padding(.top, group.day == groups.first?.day ? 0 : 8)
                    .padding(.bottom, 2)
                ForEach(Array(group.events.enumerated()), id: \.offset) { _, event in
                    EventRow(event: event, names: names(event), now: now) { openURL(card.url ?? data.hubUrl) }
                }
            }
            if today.moreEvents > 0 {
                Text("+\(today.moreEvents) more").font(.caption).foregroundStyle(.secondary).padding(.top, 4)
            }
        }
    }

    private func names(_ e: TodayData.Event) -> String {
        e.members.compactMap { data.member($0)?.name }.joined(separator: ", ")
    }
}

struct EventRow: View {
    let event: TodayData.Event
    let names: String
    let now: Date
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        let happening = event.isHappening(at: now)
        HStack(spacing: 8) {
            ColorBar(colors: event.colors)
                .frame(width: 3, height: event.location == nil ? 16 : 30)
            Text(happening ? "Now" : event.time)
                .font(.system(size: 11, weight: happening ? .semibold : .regular, design: .monospaced))
                .foregroundStyle(happening ? Color.accentColor : .secondary)
                .frame(width: 62, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(event.title).lineLimit(1)
                if let location = event.location {
                    Text(location).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .background(RoundedRectangle(cornerRadius: 6).fill(hovering ? Color.primary.opacity(0.08) : .clear))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(perform: open)
        .help(names)
    }
}

// ─── the rotation ───────────────────────────────────────────────────────────

/// The stream's other cards, one at a time, each for its `dwell`. Pauses while the
/// pointer is over it; the arrows and dots pick a card; clicking a card opens its `url`.
struct CardRotator: View {
    @EnvironmentObject var store: HubStore
    let cards: [Card]

    /// Where the rotation is. The id keeps it on the same card across a refresh; the
    /// position covers a card that's gone, and a stream with the same photo twice.
    @State private var position: Int
    @State private var currentID: String?
    @State private var shown: Double = 0
    @State private var hovering = false
    @State private var isOpen = false

    static let size = CGSize(width: 312, height: 200)

    init(cards: [Card], start: String? = nil) {
        self.cards = cards
        let i = Self.startIndex(cards, start)
        _position = State(initialValue: i)
        _currentID = State(initialValue: cards.isEmpty ? nil : cards[i].id)
    }

    /// Where to start: the card with that id, else the first of that component, else that position.
    static func startIndex(_ cards: [Card], _ start: String?) -> Int {
        guard !cards.isEmpty else { return 0 }
        let i = start.flatMap { s in
            cards.firstIndex { $0.id == s } ?? cards.firstIndex { $0.component == s } ?? Int(s)
        } ?? 0
        return min(max(i, 0), cards.count - 1)
    }

    private var index: Int {
        let n = cards.count
        if position < n, cards[position].id == currentID { return position }
        if let currentID, let i = cards.firstIndex(where: { $0.id == currentID }) { return i }
        return min(position, n - 1)
    }

    var body: some View {
        let i = index
        let card = cards[i]
        VStack(spacing: 6) {
            Button { openURL(card.url ?? store.hubURL?.absoluteString) } label: {
                CardView(card: card, image: store.image(for: card), members: store.data?.members ?? [], highlighted: hovering)
                    .frame(width: Self.size.width, height: Self.size.height)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .contentShape(RoundedRectangle(cornerRadius: 10))
                    .id(card.id + "#\(i)")
                    .transition(.opacity)
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            .help(card.url.map { _ in "Open \(card.title.isEmpty ? "the hub" : card.title)" } ?? "Open the hub")
            if cards.count > 1 { controls(i) }
        }
        .task(id: card.id) {
            // This card's image, then the next one's, so it's ready when it comes up.
            await store.loadImage(for: card)
            await store.loadImage(for: cards[(i + 1) % cards.count])
        }
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { _ in
            guard isOpen, !hovering, cards.count > 1 else { return }
            shown += 1
            if shown >= cards[index].dwell { go(to: index + 1) }
        }
        .onAppear { isOpen = true }
        .onDisappear { isOpen = false }
    }

    private func controls(_ i: Int) -> some View {
        HStack(spacing: 8) {
            arrow("chevron.left", help: "Previous card") { go(to: i - 1) }
            if cards.count <= 20 {
                HStack(spacing: 5) {
                    ForEach(cards.indices, id: \.self) { j in
                        Circle()
                            .fill(j == i ? Color.accentColor : Color.secondary.opacity(0.35))
                            .frame(width: 6, height: 6)
                            .contentShape(Rectangle().inset(by: -3))
                            .onTapGesture { go(to: j) }
                    }
                }
            } else {
                Text("\(i + 1) of \(cards.count)").font(.caption).monospacedDigit().foregroundStyle(.secondary)
            }
            arrow("chevron.right", help: "Next card") { go(to: i + 1) }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private func arrow(_ symbol: String, help: String, action: @escaping () -> Void) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 10, weight: .semibold))
            .frame(width: 18, height: 14)
            .contentShape(Rectangle())
            .onTapGesture(perform: action)
            .help(help)
    }

    private func go(to j: Int) {
        let n = cards.count
        guard n > 0 else { return }
        let next = ((j % n) + n) % n
        withAnimation(.easeInOut(duration: 0.5)) {
            position = next
            currentID = cards[next].id
        }
        shown = 0
    }
}

/// One card, in its native layout when there is one, else from its glance.
struct CardView: View {
    let card: Card
    let image: NSImage?
    let members: [StreamResponse.Member]
    var highlighted = false

    var body: some View {
        Group {
            switch card.component {
            case "photos" where image != nil:
                PhotoCardView(card: card, image: image!)
            case "trips" where card.trip != nil:
                TripCardView(card: card, trip: card.trip!, hero: image, members: members, highlighted: highlighted)
            case "grocery" where card.grocery != nil:
                GroceryCardView(card: card, grocery: card.grocery!, highlighted: highlighted)
            default:
                GlanceCardView(card: card, image: image, highlighted: highlighted)
            }
        }
        .frame(width: CardRotator.size.width, height: CardRotator.size.height)
    }
}

/// A photo from the family album, filling the card, with its date.
struct PhotoCardView: View {
    let card: Card
    let image: NSImage

    var body: some View {
        Image(nsImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: CardRotator.size.width, height: CardRotator.size.height)
            .clipped()
            .overlay(alignment: .bottomLeading) {
                if !card.glance.headline.isEmpty {
                    Text(card.glance.headline)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.6), radius: 3)
                        .padding(10)
                }
            }
    }
}

/// An upcoming or active trip: hero, countdown, and the leaderboard (or, while
/// it's on, today's schedule).
struct TripCardView: View {
    let card: Card
    let trip: TripData
    let hero: NSImage?
    let members: [StreamResponse.Member]
    let highlighted: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            banner
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(trip.isActive ? "Day \(trip.day ?? 1)" : "\(trip.daysUntil)")
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                        .monospacedDigit()
                    Text(caption)
                        .font(.caption).foregroundStyle(Color.accentColor).lineLimit(2)
                    if trip.questsTotal > 0 {
                        Text("\(trip.questsDone) of \(trip.questsTotal) quests")
                            .font(.caption2).foregroundStyle(.tertiary).padding(.top, 2)
                    }
                }
                .frame(width: 110, alignment: .leading)
                side
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
            Spacer(minLength: 0)
        }
        .background(Color.primary.opacity(highlighted ? 0.10 : 0.06))
    }

    private var caption: String {
        if trip.isActive { return "of \(trip.days)" }
        if trip.daysUntil <= 0 { return "starts today" }
        return "\(trip.daysUntil == 1 ? "day" : "days") \(trip.countdown ?? "to go")"
    }

    private var name: String { card.glance.emoji.map { "\($0) \(trip.name)" } ?? trip.name }

    @ViewBuilder private var banner: some View {
        if let hero {
            Image(nsImage: hero)
                .resizable()
                .scaledToFill()
                .frame(width: CardRotator.size.width, height: 74)
                .clipped()
                .overlay {
                    LinearGradient(colors: [.clear, .black.opacity(0.65)], startPoint: .top, endPoint: .bottom)
                }
                .overlay(alignment: .bottomLeading) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(name).font(.headline).lineLimit(1)
                        Text(trip.dates).font(.caption).opacity(0.85)
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 6)
                }
        } else {
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.headline).lineLimit(1)
                Text(trip.dates).font(.caption).foregroundStyle(.secondary)
            }
            .padding([.horizontal, .top], 10)
        }
    }

    @ViewBuilder private var side: some View {
        // Without a hero there's more room below the name.
        let rows = hero == nil ? 6 : 5
        if trip.isActive, !trip.today.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                SectionLabel(text: "Today")
                ForEach(Array(trip.today.prefix(rows).enumerated()), id: \.offset) { _, stop in
                    HStack(spacing: 6) {
                        Text(stop.time).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                            .frame(width: 52, alignment: .leading)
                        Text([stop.emoji, stop.title].compactMap { $0 }.joined(separator: " ")).font(.callout).lineLimit(1)
                    }
                }
            }
        } else if !trip.leaderboard.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                SectionLabel(text: "Leaderboard")
                ForEach(Array(trip.leaderboard.prefix(rows).enumerated()), id: \.offset) { _, r in
                    HStack(spacing: 6) {
                        Circle().fill(Color(hex: r.color)).frame(width: 7, height: 7)
                        Text(r.name).font(.callout).lineLimit(1)
                        Spacer(minLength: 4)
                        Text("\(r.points)").font(.callout.weight(.semibold)).monospacedDigit()
                    }
                }
            }
        } else if !trip.who.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                SectionLabel(text: "Going")
                ForEach(Array(trip.who.prefix(rows).enumerated()), id: \.offset) { _, id in
                    let m = members.first { $0.id == id }
                    HStack(spacing: 6) {
                        Circle().fill(m.map { Color(hex: $0.color) } ?? .secondary).frame(width: 7, height: 7)
                        Text(m?.name ?? id).font(.callout).lineLimit(1)
                    }
                }
            }
        }
    }
}

/// The shopping list: what's left to buy, in two columns when it's long.
struct GroceryCardView: View {
    let card: Card
    let grocery: GroceryData
    let highlighted: Bool

    private let perColumn = 7

    var body: some View {
        let items = grocery.toBuy
        let columns = items.count > perColumn ? 2 : 1
        let shown = Array(items.prefix(perColumn * columns - (items.count > perColumn * 2 ? 1 : 0)))
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text([card.glance.emoji, card.title.isEmpty ? "Grocery list" : card.title].compactMap { $0 }.joined(separator: " "))
                    .font(.headline)
                Spacer()
                Text(items.count == 1 ? "1 to buy" : "\(items.count) to buy").font(.caption).foregroundStyle(.secondary)
            }
            if items.isEmpty {
                Text("Nothing to buy").font(.callout).foregroundStyle(.secondary)
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .leading), count: columns),
                          alignment: .leading, spacing: 4) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { _, item in row(item) }
                    if shown.count < items.count {
                        Text("+\(items.count - shown.count) more").font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.primary.opacity(highlighted ? 0.10 : 0.06))
    }

    private func row(_ item: GroceryData.Item) -> some View {
        HStack(spacing: 5) {
            Circle().strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1).frame(width: 9, height: 9)
            Text(item.name).font(.callout).lineLimit(1)
            if item.quantity > 1 {
                Text("×\(item.quantity)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
        }
        .help(item.store.map { "\(item.name) · \($0)" } ?? item.name)
    }
}

/// Any card, from its glance alone: headline, detail, and an image, emoji, or member
/// colors when it has them. Every component the panel doesn't know draws this way.
struct GlanceCardView: View {
    let card: Card
    let image: NSImage?
    let highlighted: Bool

    var body: some View {
        if let image {
            Image(nsImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: CardRotator.size.width, height: CardRotator.size.height)
                .clipped()
                .overlay {
                    LinearGradient(colors: [.clear, .clear, .black.opacity(0.7)], startPoint: .top, endPoint: .bottom)
                }
                .overlay(alignment: .bottomLeading) {
                    text.foregroundStyle(.white).padding(12)
                }
                .environment(\.colorScheme, .dark)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    SectionLabel(text: label)
                    Spacer()
                    ForEach(Array(card.glance.colors.prefix(6).enumerated()), id: \.offset) { _, hex in
                        Circle().fill(Color(hex: hex)).frame(width: 8, height: 8)
                    }
                }
                Spacer(minLength: 8)
                HStack(alignment: .center, spacing: 12) {
                    if let emoji = card.glance.emoji {
                        Text(emoji).font(.system(size: 38))
                    }
                    text
                }
                Spacer(minLength: 8)
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.primary.opacity(highlighted ? 0.10 : 0.06))
        }
    }

    /// The card's title, or its component ("past-trips" → "Past trips") when the title just repeats the headline.
    private var label: String {
        if !card.title.isEmpty && card.title != card.glance.headline { return card.title }
        let name = card.component.replacingOccurrences(of: "-", with: " ")
        return name.prefix(1).uppercased() + name.dropFirst()
    }

    private var text: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(card.glance.headline.isEmpty ? card.title : card.glance.headline)
                .font(.title3.weight(.semibold))
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            if !card.glance.detail.isEmpty {
                Text(card.glance.detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// ─── shared pieces ──────────────────────────────────────────────────────────

/// The small capitals used over each group: "TODAY", "LEADERBOARD".
struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }
}

/// One stripe per person, stacked, in their hub colors.
struct ColorBar: View {
    let colors: [String]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array((colors.isEmpty ? ["#888888"] : colors).prefix(4).enumerated()), id: \.offset) { _, hex in
                Rectangle().fill(Color(hex: hex))
            }
        }
        .clipShape(Capsule())
    }
}

extension Color {
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&value)
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
