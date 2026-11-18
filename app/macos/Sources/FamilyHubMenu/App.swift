import AppKit
import SwiftUI

@main
struct FamilyHubApp: App {
    @StateObject private var store = HubStore()

    init() {
        // Info.plist sets LSUIElement; this covers `swift run` without a bundle.
        NSApplication.shared.setActivationPolicy(.accessory)
        Snapshot.runIfRequested()
    }

    var body: some Scene {
        MenuBarExtra {
            MenuView()
                .environmentObject(store)
                .onAppear { Task { await store.refreshIfOld() } }
        } label: {
            MenuBarLabel(store: store)
        }
        .menuBarExtraStyle(.window)
    }
}

struct MenuBarLabel: View {
    @ObservedObject var store: HubStore

    var body: some View {
        let text = store.menuBarText
        let icon = store.data == nil && store.problem != nil ? "exclamationmark.triangle" : "house.fill"
        if text.isEmpty {
            Image(systemName: icon)
        } else {
            HStack(spacing: 4) {
                Image(systemName: icon)
                Text(text)
            }
        }
    }
}

/// An AppKit window for Settings: SwiftUI's own Settings and Window scenes don't
/// come to the front reliably in a menu-bar-only app.
@MainActor
enum SettingsWindow {
    private static var window: NSWindow?

    static func show(_ store: HubStore) {
        let content = SettingsView(close: { window?.close() }).environmentObject(store)
        let host = NSHostingController(rootView: content)
        if let window {
            window.contentViewController = host
        } else {
            let w = NSWindow(contentViewController: host)
            w.title = "Family Hub Settings"
            w.styleMask = [.titled, .closable]
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

func openURL(_ string: String?) {
    guard let string, let url = URL(string: string) else { return }
    NSWorkspace.shared.open(url)
}
