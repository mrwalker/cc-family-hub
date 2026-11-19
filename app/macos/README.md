# Mac Menu Bar App

The hub next to the clock.

- **In the menu bar:** a card's headline. By default it's the next event today ("in 25m ·
  Soccer practice"), and the next trip's countdown ("🏖️ 6 days") when nothing timed is left today.
- **Click it:** a panel with today and tomorrow at the top, in each person's color, and
  below them [the stream](../../docs/stream.md), one card at a time: a photo from the family
  album, a card for each upcoming trip with its countdown and leaderboard, the grocery list,
  and the rest. Each card stays up for its `dwell`; hover to hold one, or use the arrows and
  dots. Click a card to open the hub, or a trip's app.
- **Rotate:** set Menu bar to "Rotate" in Settings, and the menu bar steps through the
  stream's headlines, changing every 30 seconds.
- **Offline:** it keeps showing the last stream it got, marked "Offline · as of …".

It refreshes every 5 minutes, after the Mac wakes, and whenever you open it. It needs
macOS 14 or later.

## 1. Give the Mac its own key

If your hub is behind Cloudflare Access, create a service token for the Mac (e.g. `hub-mac`)
and add it to the **Hub Screens** policy. See
[Giving a screen its key](../../docs/outputs.md#giving-a-screen-its-key). Its own token
means you can revoke this Mac without affecting the phones.

## 2. Build and install

You need the Xcode command line tools (`xcode-select --install`). From your hub repo:

```bash
cd node_modules/cc-family-hub/app/macos
./build-app.sh --install
```

This builds `Family Hub.app`, copies it to `~/Applications`, and opens it. The first time it
opens, Settings asks for:

- **Hub URL**, e.g. `https://hub.example.com`
- **Client ID** and **Client Secret** from the service token. These are stored in the Keychain.
- **Whose hub:** the whole family, or one member
- **Menu bar:** next event today with a trip fallback, rotate through the stream, next
  event only, trip countdown, or icon only
- **Open at login**

To change them later, click the menu bar icon and then ⚙ (or press ⌘,).

The app is signed only for the Mac that built it. After you rebuild, macOS may ask once
whether Family Hub can use its Keychain item. Choose **Always Allow**.

To upgrade, bump cc-family-hub in your hub repo and run `./build-app.sh --install` again.

## Troubleshooting

| Panel says | Fix |
|------------|-----|
| "The hub didn't accept this app's service token" | Check the token in Settings, that it's in the **Hub Screens** policy, and that the policy is attached to the `/api/stream` application. |
| "This hub has no /api/stream" | Upgrade your hub repo's cc-family-hub version. |
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
- `Model.swift`: the stream response.

To check layout without clicking around, set `FAMILY_HUB_SNAPSHOT` to a folder and run the
binary inside the app. It fetches once with the saved settings, writes `menu-light.png`,
`menu-dark.png` and `settings.png`, prints the menu bar text, and quits:

```bash
FAMILY_HUB_SNAPSHOT=/tmp "build/Family Hub.app/Contents/MacOS/Family Hub"
```

It also prints what each of the other menu bar settings would show. In a snapshot run only,
these environment variables stand in for the saved settings, without saving anything:
`FAMILY_HUB_URL`, `FAMILY_HUB_VIEW`, `FAMILY_HUB_CLIENT_ID`, `FAMILY_HUB_CLIENT_SECRET` and
`FAMILY_HUB_MENU_BAR` (`auto`, `rotate`, `nextEvent`, `trip` or `iconOnly`). `FAMILY_HUB_CARD`
picks the card the panel shows: a card id (`trips:beach-2027`), a component (`grocery`), or a
position in the rotation (`0`).

```bash
FAMILY_HUB_SNAPSHOT=/tmp FAMILY_HUB_URL=http://localhost:8799 FAMILY_HUB_CARD=grocery \
  "build/Family Hub.app/Contents/MacOS/Family Hub"
```

Use `BUNDLE_ID=… ./build-app.sh` to build a test copy with its own settings and its own
Keychain item, separate from your installed app.
