import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var store: HubStore
    let close: () -> Void

    @State private var url = ""
    @State private var clientId = ""
    @State private var clientSecret = ""
    @State private var view = "family"
    @State private var menuBarText = MenuBarText.auto
    @State private var openAtLogin = SMAppService.mainApp.status == .enabled
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Form {
                Section {
                    TextField("Hub URL", text: $url, prompt: Text("https://hub.example.com"))
                    TextField("Client ID", text: $clientId, prompt: Text("….access"))
                    SecureField("Client Secret", text: $clientSecret)
                } header: {
                    Text("Hub")
                } footer: {
                    Text("A Cloudflare Access service token allowed on /api/stream, the same kind the other screens use. Leave both empty if your hub isn't behind Access.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section {
                    if members.isEmpty {
                        TextField("Whose events", text: $view, prompt: Text("family, or a member id"))
                    } else {
                        Picker("Whose events", selection: $view) {
                            Text("Whole family").tag("family")
                            ForEach(members, id: \.id) { Text($0.name).tag($0.id) }
                            if view != "family" && !members.contains(where: { $0.id == view }) {
                                Text(view).tag(view)
                            }
                        }
                    }
                    Picker("Menu bar", selection: $menuBarText) {
                        ForEach(MenuBarText.allCases) { Text($0.label).tag($0) }
                    }
                } header: {
                    Text("Show")
                } footer: {
                    Text("Can't see Family Hub in the menu bar? macOS hides items that don't fit, especially beside the notch. Hold ⌘ and drag it to the right, or choose shorter text here. Opening Family Hub again always brings you back to Settings.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section {
                    Toggle("Open at login", isOn: $openAtLogin)
                }
            }
            .formStyle(.grouped)
            // A grouped Form scrolls, so it has no height of its own in an auto-sized window.
            .frame(height: 410)
            .scrollDisabled(true)

            if let error {
                Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal, 20)
            }
            HStack {
                Spacer()
                Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                Button("Save", action: save).keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 16)
        }
        .frame(width: 460)
        .onAppear(perform: load)
    }

    private var members: [StreamResponse.Member] { store.data?.members ?? [] }

    private func load() {
        let s = store.settings
        url = s.url
        clientId = s.clientId
        clientSecret = s.clientSecret
        view = s.view
        menuBarText = s.menuBarText
    }

    private func save() {
        var cleaned = url.trimmingCharacters(in: .whitespacesAndNewlines)
        while cleaned.hasSuffix("/") { cleaned.removeLast() }
        guard cleaned.hasPrefix("https://") || cleaned.hasPrefix("http://") else {
            error = "The hub URL must start with https://"
            return
        }
        var s = store.settings
        s.url = cleaned
        s.clientId = clientId.trimmingCharacters(in: .whitespacesAndNewlines)
        s.clientSecret = clientSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        s.view = view.trimmingCharacters(in: .whitespaces).lowercased().isEmpty ? "family" : view.trimmingCharacters(in: .whitespaces).lowercased()
        s.menuBarText = menuBarText

        do {
            let service = SMAppService.mainApp
            if openAtLogin, service.status != .enabled { try service.register() }
            if !openAtLogin, service.status == .enabled { try service.unregister() }
        } catch {
            self.error = "Couldn't change Open at login: \(error.localizedDescription)"
            store.update(s)
            return
        }
        store.update(s)
        close()
    }
}
