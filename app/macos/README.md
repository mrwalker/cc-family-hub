# Mac Menu Bar App

A small menu bar app that shows your family's day at a glance, next to the clock.

- **In the menu bar:** the next event today ("in 25m · Soccer practice"). When nothing timed
  is left today, it shows the trip countdown instead ("🏖️ 6d").
- **Click it:** a photo from the family album (a new one every 10 seconds while the panel is open),
  the rest of today and tomorrow with each person's color, and a card for each upcoming trip app
  with its countdown and quest leaderboard. The trip cards take turns every 8 seconds. Click an
  event to open the hub, or a trip card to open its trip app.
- **Rotate:** set Menu bar to "Rotate" in Settings, and the menu bar takes turns showing your next
  event and each trip's countdown, changing every 30 seconds.
- **Offline:** it keeps showing the last data it got, marked "Offline · as of …".

It reads the same `GET /api/widget` as the [phone widgets](../widgets/README.md) and refreshes
every 5 minutes, after the Mac wakes, and whenever you open it. It needs macOS 14 or later.

## 1. Give the Mac its own key

If your hub is behind Cloudflare Access, create a service token for the Mac (e.g. `hub-mac`)
and add it to the **Hub Widgets** policy on the `/api/widget` application. See
[the widget setup](../widgets/README.md#1-give-widgets-their-own-key-cloudflare-access).
Its own token means you can revoke this Mac without affecting the phones.

## 2. Build and install

You need the Xcode command line tools (`xcode-select --install`).

```bash
cd app/macos
./build-app.sh --install
```

This builds `Family Hub.app`, copies it to `~/Applications`, and opens it. The first time it
opens, Settings asks for:

- **Hub URL**, e.g. `https://hub.example.com`
- **Client ID** and **Client Secret** from the service token. These are stored in the Keychain.
- **Whose events:** the whole family, or one member (shared invites included)
- **Menu bar:** next event today with a trip fallback, rotate (next event, then each trip), next
  event only, trip countdown, or icon only
- **Open at login**

To change them later, click the menu bar icon and then ⚙ (or press ⌘,).

The app is signed only for the Mac that built it. After you rebuild, macOS may ask once
whether Family Hub can use its Keychain item. Choose **Always Allow**.

To upgrade, pull cc-family-hub and run `./build-app.sh --install` again.

## Troubleshooting

| Panel says | Fix |
|------------|-----|
| "The hub didn't accept this app's service token" | Check the token in Settings, that it's in the **Hub Widgets** policy, and that the policy is attached to the `/api/widget` application. |
| "This hub has no /api/widget" | Upgrade your family repo's cc-family-hub pin to v0.3.0 or later. |
| "Unknown view …" | Pick a member in Settings, or Whole family. |
| "Offline · as of …" | The Mac couldn't reach the hub. It retries every minute. |

## Developing

```bash
swift build                    # compile
./build-app.sh                 # build build/Family Hub.app without installing
```

`Sources/FamilyHubMenu/`:

- `HubStore.swift`: fetching, the offline cache, and the menu bar text.
- `MenuView.swift`: the panel.
- `SettingsView.swift`: Settings.
- `Model.swift`: the `/api/widget` response.

To check layout without clicking around, set `FAMILY_HUB_SNAPSHOT` to a folder and run the
binary inside the app. It fetches once with the saved settings, writes `menu-light.png`,
`menu-dark.png` and `settings.png`, prints the menu bar text, and quits:

```bash
FAMILY_HUB_SNAPSHOT=/tmp "build/Family Hub.app/Contents/MacOS/Family Hub"
```

Use `BUNDLE_ID=… ./build-app.sh` to build a test copy with its own settings, separate from
your installed app.
