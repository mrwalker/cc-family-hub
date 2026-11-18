# Phone Widgets

Hub widgets for the iPhone home screen and lock screen. Each widget shows upcoming
events from your family's live calendars (the rest of today and all of tomorrow) and a
countdown to the next trip.

| Size | Shows |
|------|-------|
| Small | The next timed event, its people's colors, and the trip countdown |
| Medium | Up to 4 events under Today/Tomorrow, plus a trip card that opens the trip app |
| Large | Up to 10 events, plus a trip bar |
| Lock screen | Rectangular: next event + trip. Inline: next event. Circular: days to the trip |

Each widget picks its **view**: one member's events (shared invites included) or the whole family.
Tapping a widget opens the hub. Tapping the trip card opens the trip app.

The widgets run in [Scriptable](https://scriptable.app), a free iOS app, so you don't need
Xcode or an Apple Developer account. They read `GET /api/widget?view=<member id>|family`
from your hub (see [`../worker/widget.js`](../worker/widget.js)). If the phone is offline,
a widget shows the last data it fetched, marked "Offline".

The [Mac menu bar app](../macos/README.md) reads the same endpoint, and its token goes in the
same policy.

## 1. Give widgets their own key (Cloudflare Access)

If your hub is behind Cloudflare Access, a widget can't sign in the way a browser does.
Instead it sends a **service token**. Scope that token to `/api/widget`, so a phone that
holds it can't read anything else on the hub:

1. **Create a service token.** Go to Zero Trust → Access → Service credentials → Service Tokens.
   Create one named, e.g., `hub-widget`, and copy its Client ID and Client Secret. One token
   per phone means you can revoke a lost phone on its own.
2. **Create a policy.** Go to Access → Policies → Add a policy. Name it `Hub Widgets`, set the
   action to **Service Auth**, and add an Include rule for **Service Token** with your widget token(s).
3. **Create a path-scoped application.** Go to Access → Applications → Add an application →
   Self-hosted. Use your hub's domain with path `api/widget`, and attach the **Hub Widgets**
   policy. Cloudflare applies the most specific application, so this one governs only
   `/api/widget`. Don't add the widget token to your hub's main application.

If the policy says "Used by applications: 0", it isn't attached to the application yet,
and the widget will report that the hub didn't accept its token.

## 2. Install the script

1. Install **Scriptable** from the App Store.
2. In Scriptable, tap **+**, name the script `Family Hub`, and paste in
   [`scriptable/family-hub.js`](scriptable/family-hub.js).
3. Run it once (▶). Enter your hub URL (`https://hub.example.com`) and the token's Client ID
   and Client Secret. They're stored in the iOS Keychain.
4. Choose **Preview Medium** to check it works.

## 3. Add widgets

1. Long-press the home screen → **+** → **Scriptable**, then pick a size and add it.
2. Long-press the new widget → **Edit Widget**:
   - **Script**: Family Hub
   - **When Interacting**: Run Script (or Open URL; tapping opens the hub either way)
   - **Parameter**: a member id from your `family.yaml` (e.g. `alex`) for that person's events, or `family`
3. For the lock screen, customize the Lock Screen → add a **Scriptable** widget and set it up the same way.

iOS decides when widgets refresh, usually every 15–30 minutes. The hub caches calendar
data for 5 minutes, so many widgets don't mean many Google API calls.

## Troubleshooting

| Widget says | Fix |
|-------------|-----|
| "Open this script in Scriptable to sign in" | Run the script in the app and enter the URL and token. |
| "The hub didn't accept this widget's service token" | Check the token values (Run → Change hub sign-in), that the policy is **Service Auth** and includes the token, and that it's attached to the `/api/widget` application. |
| "Unknown view …" | Set Parameter to one of the listed member ids, or `family`. |
| "Offline · as of …" | The phone couldn't reach the hub, so the widget shows the last data it got. |
