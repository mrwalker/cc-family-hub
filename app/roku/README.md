# Roku Channel

The hub on your TV. It rotates through [the stream](../../docs/stream.md) one card at a
time, with crossfades: today and tomorrow beside a big clock, each upcoming trip with its
hero photo and leaderboard, trips you've taken, the grocery list, each pet over its photo,
and photos from the family album.

The same screen works as a Roku **screensaver**, and as a screensaver it drifts slowly so
nothing burns in. The channel and the screensaver show the same stream: by default, three
album photos between every other card, each with a strip along the bottom showing the clock,
the next event, and the trip countdown. Add a photo to the album on your phone and it joins
within about 15 minutes.

- **Left and right** on the remote switch between the whole family and each person. The Roku remembers your choice.
- **OK** refreshes. The channel also refreshes every 5 minutes on its own.

To change what it shows, set `outputs.roku.stream` in your `family.yaml`:

```yaml
outputs:
  roku:
    stream:
      components: [today, trips, past-trips, grocery]
      photosBetween: 3
      dwell: 10
```

The channel is installed in Roku's developer mode ("sideloaded"), so it never goes through
the Roku Channel Store. It's private to your Roku.

## 1. Turn on developer mode on the Roku

1. On the remote, press **Home ×3, Up ×2, Right, Left, Right, Left, Right**.
2. Note the IP address shown, choose **Enable installer and restart**, accept the agreement, and set
   a developer password.
3. After the restart, `http://<roku-ip>` in a browser asks for the user `rokudev` and that password.

## 2. Give the Roku its own key

If your hub is behind Cloudflare Access, create a service token for the TV (e.g. `hub-roku`)
and add it to the **Hub Screens** policy. See
[Giving a screen its key](../../docs/outputs.md#giving-a-screen-its-key).

## 3. Write `roku.env`

Put this file outside every repo, at `~/.config/family-hub/roku.env`. To use another path,
set `FAMILY_HUB_ROKU_ENV`.

```bash
ROKU_HOST=192.168.1.50            # the Roku's IP
ROKU_DEV_PASSWORD=…               # the developer-mode password
HUB_URL=https://hub.example.com
HUB_VIEW=family                   # or a member id; left/right changes it on the TV
CF_ACCESS_CLIENT_ID=….access
CF_ACCESS_CLIENT_SECRET=…
```

`build.sh` puts the hub URL and token inside the package, so keep `build/` private. It's
gitignored.

## 4. Build and install

A Roku holds one sideloaded package at a time, so choose one. From your hub repo:

```bash
cd node_modules/cc-family-hub/app/roku
./build.sh --screensaver --install   # the screensaver (recommended)
./build.sh --install                 # the channel: a Home screen tile you open
```

Roku lists a sideloaded screensaver only when the package is screensaver-only, so build the
screensaver with `--screensaver`. Then go to Settings → Theme → Screensavers, choose **Family
Hub**, and use **Preview** to check it.

`./build.sh --preview --install` installs a channel that runs as the screensaver does: it drifts,
and it leaves out the remote hint.
You can launch it from the Home screen, or with `curl -X POST http://<roku-ip>:8060/launch/dev`,
to check the rotation without waiting for the screensaver.

## Troubleshooting

| Screen says | Fix |
|-------------|-----|
| "The hub didn't accept this channel's service token" | Check the token in `roku.env`, that it's in the **Hub Screens** policy, and that the policy is attached to the `/api/stream` application. Then run `./build.sh --install` again. |
| "No hub is set up" | `HUB_URL` was empty at build time. |
| "Unknown view …" | Press left or right to pick someone else. |
| "This hub has no /api/stream" | The hub runs a cc-family-hub older than v0.9.0. Upgrade it and deploy. |
| "Offline since …" | The Roku couldn't reach the hub, so it keeps showing the last stream and retries every minute. |

## Developing

- `components/HubScene.brs`: rotation, a layout for each kind of card, and remote keys.
  `today`, `photos`, `trips`, `past-trips`, `grocery`, and `pet-portraits` have their own
  layouts. Any other card is drawn from its glance.
- `components/FetchTask.brs`: the HTTP requests: `/api/stream?output=roku`, and card images,
  which it downloads to `tmp:/` with the same token.
- `source/`: entry points for the channel and the screensaver.

To check the layout from your computer, run `./build.sh --screenshot shot.jpg`. To send remote
keys over the network (`curl -X POST http://<roku-ip>:8060/keypress/Right`), set Settings → System →
Advanced system settings → Control by mobile apps → Network access to **Permissive**. The default,
**Limited**, refuses them with 403. You can also
watch the debug console with `nc <roku-ip> 8085`. To check syntax without a Roku, run
[BrighterScript](https://github.com/rokucommunity/brighterscript):
`npx -p brighterscript bsc --rootDir build/stage --createPackage false`.
