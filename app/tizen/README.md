# Samsung TV App

The hub on a Samsung TV. It rotates through [the stream](../../docs/stream.md) like the Roku
channel:
- **today:** a big clock with today and tomorrow, and the next trip's countdown.
- **photos:** full screen, with a strip showing the clock, the next event and the countdown.
- **trips and past trips:** the hero or album photo, the countdown or highlights, and the
  leaderboard.
- **grocery:** the list.
- **everything else:** its glance.

By default it shows three album photos between every other card (`outputs.tizen-tv.stream`
in `family.yaml` changes that).

- **Left and right** on the remote switch between the whole family and each person.
- **OK** refreshes, and **Back** closes the app. It also refreshes every 5 minutes.
- **Offline:** it keeps showing the last stream it got.

It's a Tizen web app installed in the TV's developer mode, so it's private to your TVs and
never goes through Samsung's store. Tizen doesn't let apps replace the TV's screensaver, so
it runs as an app you open. The app keeps the TV's own screensaver from covering it.

## Before you start: one-time setup on your computer

1. **Settings file.** Create `~/.config/family-hub/tizen.env` (or set `FAMILY_HUB_TIZEN_ENV`):
   ```bash
   HUB_URL=https://hub.example.com
   HUB_VIEW=family                   # or a member id
   CF_ACCESS_CLIENT_ID=….access      # a service token for the TVs, in the Hub Screens policy
   CF_ACCESS_CLIENT_SECRET=…
   TIZEN_TVS="192.168.1.40 192.168.1.41"   # every TV to install on
   ```
   Give the TVs their own service token, as with any screen. See
   [Giving a screen its key](../../docs/outputs.md#giving-a-screen-its-key).
2. **Tizen Studio's command-line tools.** Download the CLI installer for your OS from
   [download.tizen.org/sdk/Installer](https://download.tizen.org/sdk/Installer/)
   (`web-cli_Tizen_Studio_<version>_<os>.bin`) and install it to `~/tizen-studio`
   (`./web-cli_….bin --accept-license ~/tizen-studio`). Then install Samsung's packages:
   ```bash
   cd ~/tizen-studio/package-manager
   ./package-manager-cli.bin install --accept-license Certificate-Manager cert-add-on \
     TV-SAMSUNG-Extension-Tools TV-SAMSUNG-Public-WebAppDevelopment
   ```
   If it says Java wasn't found, add `JDK_PATH=$HOME/tizen-studio/jdk` to
   `~/tizen-studio/sdk.info`. If that isn't enough, make sure `~/.package-manager/jdk` is a
   full copy of `~/tizen-studio/jdk`, not an empty folder.

## Each TV: developer mode

On each TV:
1. Open the **Apps** tab and scroll to the bottom.
2. Open **App Settings**, press **123** on the remote, and type **1 2 3 4 5**. On older
   models, type it on the Apps screen itself.
3. Turn **Developer Mode** on, and enter your computer's IP address as the host.
4. Unplug the TV for a minute, then plug it back in. If it installs a software update, let
   it finish, then check that Developer Mode is still on: updates can turn it off.
5. Note its IP address: Settings → Connection → Network → Network Status → IP Settings.

## The certificate (once for all your TVs)

A TV only installs apps signed with a Samsung certificate that lists that TV's unique id
(DUID). Ids can't be added to a certificate later, so collect every TV's id first:

```bash
./build.sh --duid 192.168.1.40     # repeat for each TV
```

In **Certificate Manager** (`~/tizen-studio/tools/certificate-manager/`):
1. Create a **Samsung** certificate profile for **TV**, named `family-hub` (or set `TIZEN_PROFILE`).
2. Create an author certificate. You'll sign in with a Samsung account.
3. In the distributor certificate step, keep the **Public** privilege and add every DUID.

To add a TV later, create a new profile that **reuses the existing author certificate** and
lists every TV's id, point `TIZEN_PROFILE` at it, and reinstall everywhere. With the same
author, installed apps update in place.

## TVs in more than one place

A certificate only has to list the TVs it installs on, so give each location its own. In
`~/.config/family-hub/`, next to `tizen.env`, add `tizen-<site>.env`:

```bash
# tizen-home.env
TIZEN_TVS="192.168.1.40 192.168.1.41"
TIZEN_PROFILE=family-hub-home
```

For each site, create a certificate profile in Certificate Manager that **reuses the same
author certificate** and lists that site's TVs. Then, on that site's network:

```bash
./build.sh --my-ip                      # what to enter as each TV's Developer Mode host
./build.sh --find                       # the TVs on this network in Developer Mode
./build.sh --site home --duid 192.168.1.40
./build.sh --site home --install
```

Every site's builds share the author, so any TV can take an update from any of them.

## Install

```bash
./build.sh --install                 # every TV in TIZEN_TVS
./build.sh --install 192.168.1.40    # just this one
```

This builds, signs, installs and starts the app on each TV, one line per TV. Family Hub then
appears in the TV's apps. Build with `./build.sh` alone to stage `build/stage/` without
signing; opening its `index.html` in a browser previews the app.

`build.sh` puts the hub URL and token inside the package, so keep `build/` private. It's
gitignored.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `couldn't connect` | Developer Mode must be on with this computer's IP as the host, and the TV restarted since. The TV and computer must be on the same network. |
| The app installs but doesn't appear | The certificate doesn't include that TV's DUID. |
| "The hub didn't accept this TV's service token" | Check the token in `tizen.env`, that it's in the Hub Screens policy, and rebuild. |
| The app is gone after the TV restarts | On a 2025 TV it survived restarts. Samsung's documentation says SDK-installed apps can be removed on reboot on some models: run `./build.sh --install` again. |

## Developing

`src/` is the app: `config.xml` (the Tizen manifest), `index.html`, `app.js`, `app.css`.
`build.sh` stages it with a generated `config.js` (the hub URL, view and token). The layout
is fixed at 1920×1080.
