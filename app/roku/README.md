# Roku Channel

The hub on your TV: a big clock and date, the rest of today and tomorrow with each person's
color, and the next trip's countdown. The same screen works as a Roku **screensaver**, and it
drifts slowly so nothing burns in.

- **Left and right** on the remote switches between the whole family and each person. The Roku remembers your choice.
- **OK** refreshes. The channel also refreshes every 5 minutes on its own.

It reads the same `GET /api/widget` as the [phone widgets](../widgets/README.md). The channel is
installed in Roku's developer mode ("sideloaded"), so it never goes through the Roku Channel
Store. It's private to your Roku.

## 1. Turn on developer mode on the Roku

1. On the remote, press **Home ×3, Up ×2, Right, Left, Right, Left, Right**.
2. Note the IP address shown, choose **Enable installer and restart**, accept the agreement, and set
   a developer password.
3. After the restart, `http://<roku-ip>` in a browser asks for the user `rokudev` and that password.

## 2. Give the Roku its own key

If your hub is behind Cloudflare Access, create a service token for the TV (e.g. `hub-roku`) and
add it to the **Hub Widgets** policy on the `/api/widget` application. See
[the widget setup](../widgets/README.md#1-give-widgets-their-own-key-cloudflare-access).

## 3. Write `roku.env`

Put this file outside the repo, at `~/.config/family-hub/roku.env`. To use another path, set
`FAMILY_HUB_ROKU_ENV`.

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

```bash
cd app/roku
./build.sh --install
```

The channel opens on the TV and stays under **Home → Streaming channels**. It's the only dev
channel; installing again replaces it.

**Screensaver.** Go to Settings → Theme → Screensavers (or Settings → Screensaver) and choose **Family Hub**.

## Troubleshooting

| Screen says | Fix |
|-------------|-----|
| "The hub didn't accept this channel's service token" | Check the token in `roku.env`, that it's in the **Hub Widgets** policy, and that the policy is attached to the `/api/widget` application. Then run `./build.sh --install` again. |
| "No hub is set up" | `HUB_URL` was empty at build time. |
| "Unknown view …" | Press left or right to pick someone else. |
| "Offline since …" | The Roku couldn't reach the hub, so it keeps showing the last data and retries. |

## Developing

- `components/HubScene.brs`: layout and remote keys.
- `components/FetchTask.brs`: the HTTP request.
- `source/main.brs`: entry points for the channel and the screensaver.

To check the layout from your computer, run `./build.sh --screenshot shot.jpg`. To send remote
keys over the network (`curl -X POST http://<roku-ip>:8060/keypress/Right`), set Settings → System →
Advanced system settings → Control by mobile apps → Network access to **Permissive**. The default,
**Limited**, refuses them with 403. You can also
watch the debug console with `nc <roku-ip> 8085`. To check syntax without a Roku, run
[BrighterScript](https://github.com/rokucommunity/brighterscript):
`npx -p brighterscript bsc --rootDir build/stage --createPackage false`.
