import Foundation
import Security

/// What the menu bar shows next to the icon.
enum MenuBarText: String, CaseIterable, Identifiable {
    case auto, rotate, nextEvent, trip, iconOnly

    var id: String { rawValue }
    var label: String {
        switch self {
        case .auto: "Next event today, else the trip"
        case .rotate: "Rotate: next event, then each trip"
        case .nextEvent: "Next event"
        case .trip: "Trip countdown"
        case .iconOnly: "Icon only"
        }
    }
}

/// The hub URL, view, and menu bar choice live in UserDefaults; the
/// Cloudflare Access service token lives in the Keychain.
struct HubSettings: Equatable {
    var url = ""
    var view = "family"
    var menuBarText = MenuBarText.auto
    var clientId = ""
    var clientSecret = ""

    private static let defaults = UserDefaults.standard
    private static let tokenAccount = "service-token"

    static func load() -> HubSettings {
        var s = HubSettings()
        s.url = defaults.string(forKey: "hubURL") ?? ""
        s.view = defaults.string(forKey: "view") ?? "family"
        s.menuBarText = MenuBarText(rawValue: defaults.string(forKey: "menuBarText") ?? "") ?? .auto
        if let data = Keychain.read(tokenAccount),
           let token = try? JSONDecoder().decode([String: String].self, from: data) {
            s.clientId = token["clientId"] ?? ""
            s.clientSecret = token["clientSecret"] ?? ""
        }
        return s
    }

    func save() {
        Self.defaults.set(url, forKey: "hubURL")
        Self.defaults.set(view, forKey: "view")
        Self.defaults.set(menuBarText.rawValue, forKey: "menuBarText")
        if clientId.isEmpty && clientSecret.isEmpty {
            Keychain.delete(Self.tokenAccount)
        } else if let data = try? JSONEncoder().encode(["clientId": clientId, "clientSecret": clientSecret]) {
            Keychain.write(Self.tokenAccount, data)
        }
    }
}

enum Keychain {
    private static let service = "family-hub"

    private static func base(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    static func read(_ account: String) -> Data? {
        var query = base(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func write(_ account: String, _ data: Data) {
        let status = SecItemUpdate(base(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = base(account)
            add[kSecValueData as String] = data
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    static func delete(_ account: String) {
        SecItemDelete(base(account) as CFDictionary)
    }
}
