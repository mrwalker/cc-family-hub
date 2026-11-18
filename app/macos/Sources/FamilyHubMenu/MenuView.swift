import AppKit
import SwiftUI

/// The panel that opens from the menu bar.
struct MenuView: View {
    @EnvironmentObject var store: HubStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if !store.isConfigured {
                setupPrompt
            } else {
                if let problem = store.problem { banner(problem) }
                if let photo = store.photo { PhotoCard(image: photo) }
                if let data = store.data {
                    EventList(events: store.events, data: data, now: store.now)
                    if !store.trips.isEmpty {
                        TripCarousel(trips: store.trips)
                    } else if let trip = data.nextTrip {
                        TripCard(trip: trip)
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
        // A new photo every 10 seconds while the panel is open.
        .onReceive(Timer.publish(every: 10, on: .main, in: .common).autoconnect()) { _ in
            if isOpen { Task { await store.nextPhoto() } }
        }
        .onAppear { isOpen = true }
        .onDisappear { isOpen = false }
    }

    @State private var isOpen = false

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
            Text("Connect to your hub to see upcoming events and the next trip.")
                .foregroundStyle(.secondary)
            Button("Set Up…") { SettingsWindow.show(store) }
        }
    }

    private func banner(_ problem: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: store.isOffline ? "wifi.slash" : "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                if store.isOffline, let at = store.data.flatMap({ Dates.parse($0.generatedAt) }) {
                    Text("Offline · as of \(Dates.shortTime(at))").font(.caption.weight(.semibold))
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
            if store.problem == nil, let at = store.data.flatMap({ Dates.parse($0.generatedAt) }) {
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

/// Events under Today / Tomorrow headings.
struct EventList: View {
    let events: [WidgetData.Event]
    let data: WidgetData
    let now: Date

    private var groups: [(day: String, events: [WidgetData.Event])] {
        var out: [(day: String, events: [WidgetData.Event])] = []
        for e in events {
            if out.last?.day == e.day { out[out.count - 1].events.append(e) } else { out.append((e.day, [e])) }
        }
        return out
    }

    var body: some View {
        if let error = data.eventsError, events.isEmpty {
            Text("Calendars didn't load: \(error)").font(.callout).foregroundStyle(.secondary)
        } else if events.isEmpty {
            Text("Nothing else today or tomorrow").font(.callout).foregroundStyle(.secondary)
        } else if events.count > 9 {
            ScrollView { list }.frame(height: 380)
        } else {
            list
        }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(groups, id: \.day) { group in
                Text(group.day.uppercased())
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.top, group.day == groups.first?.day ? 0 : 8)
                    .padding(.bottom, 2)
                ForEach(Array(group.events.enumerated()), id: \.offset) { _, event in
                    EventRow(event: event, names: names(event), now: now) { openURL(data.hubUrl) }
                }
            }
            if let more = data.moreEvents, more > 0 {
                Text("+\(more) more").font(.caption).foregroundStyle(.secondary).padding(.top, 4)
            }
        }
    }

    private func names(_ e: WidgetData.Event) -> String {
        e.members.compactMap { id in data.members.first { $0.id == id }?.name }.joined(separator: ", ")
    }
}

struct EventRow: View {
    let event: WidgetData.Event
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

struct TripCard: View {
    let trip: WidgetData.Trip
    @State private var hovering = false

    var body: some View {
        Button { openURL(trip.url) } label: {
            HStack(spacing: 12) {
                Text(trip.isActive ? "\(trip.day ?? 1)" : "\(trip.daysUntil)")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .frame(minWidth: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(caption.uppercased())
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color.accentColor)
                    Text(trip.displayName).font(.headline).lineLimit(1)
                    Text(Dates.range(trip.startDate, trip.endDate)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(hovering ? 0.10 : 0.06)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Open the trip app")
    }

    private var caption: String {
        if trip.isActive { return "On the trip · day of \(trip.days)" }
        return trip.daysUntil == 1 ? "Day to go" : "Days to go"
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

/// A photo from the family album, cropped to a fixed height.
struct PhotoCard: View {
    let image: NSImage

    var body: some View {
        Image(nsImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: 312, height: 190)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .id(ObjectIdentifier(image))
            .transition(.opacity)
            .animation(.easeInOut(duration: 0.8), value: ObjectIdentifier(image))
    }
}

/// Every upcoming trip app, one at a time: countdown and leaderboard. Advances
/// every 8 seconds; click the dots to pick one, or the card to open the trip app.
struct TripCarousel: View {
    let trips: [TripSummary]
    @State private var index = 0
    @State private var hovering = false

    var body: some View {
        let trip = trips[min(index, trips.count - 1)]
        VStack(spacing: 6) {
            Button { openURL(trip.url) } label: { card(trip) }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
                .help("Open the trip app")
            if trips.count > 1 {
                HStack(spacing: 6) {
                    ForEach(trips.indices, id: \.self) { i in
                        Circle()
                            .fill(i == index ? Color.accentColor : Color.secondary.opacity(0.35))
                            .frame(width: 6, height: 6)
                            .onTapGesture { index = i }
                    }
                }
            }
        }
        .onReceive(Timer.publish(every: 8, on: .main, in: .common).autoconnect()) { _ in
            if !hovering, trips.count > 1 { withAnimation { index = (index + 1) % trips.count } }
        }
    }

    private func card(_ t: TripSummary) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(t.fullTitle).font(.headline).lineLimit(1)
                Text(t.dates).font(.caption).foregroundStyle(.secondary)
                Text(t.isActive ? "Day \(t.day ?? 1)" : "\(t.daysUntil)")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .padding(.top, 4)
                Text(t.isActive ? "of \(t.days)" : "\(t.daysUntil == 1 ? "day" : "days") \(t.countdown ?? "to go")")
                    .font(.caption).foregroundStyle(Color.accentColor).lineLimit(2)
            }
            .frame(width: 120, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text((t.team ?? "Leaderboard").uppercased())
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                ForEach(Array(t.leaderboard.prefix(5).enumerated()), id: \.offset) { _, r in
                    HStack(spacing: 6) {
                        Circle().fill(Color(hex: r.color)).frame(width: 7, height: 7)
                        Text(r.name).font(.callout).lineLimit(1)
                        Spacer(minLength: 4)
                        Text("\(r.points)").font(.callout.weight(.semibold)).monospacedDigit()
                    }
                }
                Text("\(t.questsDone) of \(t.questsTotal) quests").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(hovering ? 0.10 : 0.06)))
        .contentShape(Rectangle())
        .id(t.id)
        .transition(.opacity)
    }
}
