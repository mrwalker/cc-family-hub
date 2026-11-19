import AppKit
import SwiftUI

@main
struct FamilyHubApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    // A snapshot run draws its own store (Snapshot.swift); this one stays idle.
    @StateObject private var store = HubStore.shared

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
            MenuBarLabel(model: store.label)
        }
        .menuBarExtraStyle(.window)
    }
}

struct MenuBarLabel: View {
    @ObservedObject var model: MenuBarLabelModel

    /// Always one Text with the icon inside it. A MenuBarExtra's label that switches
    /// between different views (an icon alone, then an icon and text) can leave the
    /// menu bar item empty and invisible.
    var body: some View {
        let icon = Text(Image(systemName: model.icon))
        model.text.isEmpty ? icon : icon + Text(" " + model.text)
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

/// Opening the app while it's running (from Spotlight, Finder or Launchpad) shows
/// Settings. macOS hides menu bar items that don't fit, notably beside a MacBook's
/// notch, so this is the way back in when the item is out of sight.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        Task { @MainActor in SettingsWindow.show(HubStore.shared) }
        return false
    }
}
