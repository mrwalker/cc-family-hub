import AppKit
import SwiftUI

/// Developer aid: `FAMILY_HUB_SNAPSHOT=<dir> "Family Hub.app/Contents/MacOS/Family Hub"`
/// fetches once with the saved settings, writes the panel as menu-light.png and
/// menu-dark.png and the Settings window as settings.png into <dir>, prints the menu
/// bar text, and quits.
///
/// In snapshot mode only, these override the saved settings for that run (nothing is saved):
///   FAMILY_HUB_URL, FAMILY_HUB_VIEW, FAMILY_HUB_CLIENT_ID, FAMILY_HUB_CLIENT_SECRET,
///   FAMILY_HUB_MENU_BAR (auto, rotate, nextEvent, trip, iconOnly)
/// and FAMILY_HUB_CARD picks the card the rotation shows: a card id ("grocery",
/// "trips:beach-2027"), a component ("movies"), or a position in the rotation ("0").
@MainActor
enum Snapshot {
    static var isRequested: Bool { ProcessInfo.processInfo.environment["FAMILY_HUB_SNAPSHOT"] != nil }

    static func runIfRequested() {
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["FAMILY_HUB_SNAPSHOT"] else { return }
        Task { @MainActor in
            var settings = HubSettings.load()
            if let v = env["FAMILY_HUB_URL"] { settings.url = v.hasSuffix("/") ? String(v.dropLast()) : v }
            if let v = env["FAMILY_HUB_VIEW"] { settings.view = v }
            if let v = env["FAMILY_HUB_CLIENT_ID"] { settings.clientId = v }
            if let v = env["FAMILY_HUB_CLIENT_SECRET"] { settings.clientSecret = v }
            if let v = env["FAMILY_HUB_MENU_BAR"].flatMap(MenuBarText.init(rawValue:)) { settings.menuBarText = v }

            let store = HubStore(settings: settings, live: false)
            await store.refresh()
            let start = env["FAMILY_HUB_CARD"]
            // Load the images the panel will show before drawing it.
            let cards = store.panelCards
            let shown = cards.isEmpty ? nil : cards[CardRotator.startIndex(cards, start)]
            if let shown { await store.loadImage(for: shown) }

            for (name, scheme) in [("light", ColorScheme.light), ("dark", .dark)] {
                let view = MenuView(startCard: start)
                    .environmentObject(store)
                    .environment(\.colorScheme, scheme)
                    .background(scheme == .dark ? Color(white: 0.16) : Color(white: 0.96))
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                if let tiff = renderer.nsImage?.tiffRepresentation,
                   let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("menu-\(name).png"))
                }
            }
            // Settings uses AppKit-backed controls, which ImageRenderer can't draw,
            // so render the real window's view instead.
            let host = NSHostingController(rootView: SettingsView(close: {}).environmentObject(store))
            let window = NSWindow(contentViewController: host)
            window.styleMask = [.titled, .closable]
            window.setContentSize(host.view.fittingSize)
            window.layoutIfNeeded()
            if let view = window.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?
                    .write(to: URL(fileURLWithPath: dir).appendingPathComponent("settings.png"))
                print("settings: \(Int(view.bounds.width))×\(Int(view.bounds.height))")
            }
            print("menu bar: \(store.menuBarText)")
            for mode in MenuBarText.allCases where mode != settings.menuBarText {
                print("  \(mode.rawValue): \(store.menuBarText(mode))")
            }
            print("rotate steps: \(store.rotateItems.joined(separator: " | "))")
            print("panel: \(store.todayCard == nil ? "no today anchor" : "today anchor"), rotating \(store.panelCards.count) cards, showing \(shown.map { "\($0.component) (\($0.id))" } ?? "none")")
            if let problem = store.problem { print("problem: \(problem)") }
            if store.isOffline { print("offline, as of \(store.generatedAt.map(Dates.asOf) ?? "?")") }
            exit(0)
        }
    }
}
