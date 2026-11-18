import AppKit
import SwiftUI

/// Developer aid: `FAMILY_HUB_SNAPSHOT=<dir> "Family Hub.app/Contents/MacOS/Family Hub"`
/// fetches once with the saved settings, writes the panel as menu-light.png and
/// menu-dark.png and the Settings window as settings.png into <dir>, prints the menu bar text, and quits.
@MainActor
enum Snapshot {
    static func runIfRequested() {
        guard let dir = ProcessInfo.processInfo.environment["FAMILY_HUB_SNAPSHOT"] else { return }
        Task { @MainActor in
            let store = HubStore()
            await store.refresh()
            for (name, scheme) in [("light", ColorScheme.light), ("dark", .dark)] {
                let view = MenuView()
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
            if let problem = store.problem { print("problem: \(problem)") }
            exit(0)
        }
    }
}
