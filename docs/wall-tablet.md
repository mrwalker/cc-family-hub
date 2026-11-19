# Wall Tablet

The hub page is designed for a wall-mounted Android tablet running a kiosk browser
such as [FreeKiosk](https://freekiosk.app). Left alone, the page rotates through
[the stream](stream.md), one card at a time. Tap it and rotation stops, so you can scroll
the calendar or add to the grocery list. It resumes after two idle minutes.

## Normal operation

- The page loads `/api/config.js` (names, colors, trip apps) and `/api/stream` (the cards
  to rotate through), and reloads the stream as it rotates.
- Calendar events are live and refresh every 5 minutes, so no sync step is needed.
- New plans arrive whenever the pipeline publishes. Publishing writes data. It doesn't redeploy.
- To give the wall a different mix from the phones, set `outputs.hub-page.stream` in
  `family.yaml`. See [stream.md](stream.md#configuring-the-stream).

## Kiosk setup and Google sign-in

With Cloudflare Access in front of the hub, the tablet's first visit redirects to Google
sign-in. In an embedded Android WebView, Google blocks this with *"Couldn't sign you in: This
browser or app may not be secure"* (`disallowed_useragent`).

To get past it:

1. **Update the kiosk app.** For FreeKiosk, use v1.2.19 or later. Older versions send a stale user-agent.
2. **Set a custom user agent** with no WebView (`; wv`) marker. In FreeKiosk this is under
   Settings → Display → Custom User Agent:
   ```
   Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36
   ```
3. **Sign in once.** Temporarily allow `<team>.cloudflareaccess.com` in the kiosk, sign in, then
   remove the exception. With a 30-day Access session, the tablet rarely needs to sign in again.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Google sign-in blocked ("browser or app may not be secure") | Set the custom user agent (above). |
| Calendar section empty | Check `/api/events` in the Network tab. A 401 means the page's token from `/api/config.js` doesn't match the `API_TOKEN` secret. A 502 means a service-account or calendar-sharing problem. |
| Page shows old data | Check that the pipeline's last run printed `PUBLISH OK`. `GET /api/data/plan` shows `publishedAt`. |
| A component never comes up | It has nothing to show, or it isn't in your `stream.components`. `npx family-hub check` lists the stream. |
| Page won't load | The Access session may have expired. Sign in again using the steps above. |
