# Phone Widgets

The hub on the iPhone home screen and lock screen. A widget shows one card from
[the stream](../../docs/stream.md) and moves to the next each time iOS refreshes it.

| Size | Shows |
|------|-------|
| Small | A card's glance: its headline, detail line, and photo. For `today`, the next event and its people's colors. |
| Medium | A card in full where the widget knows the component (`today`, `photos`, `trips`, `grocery`), and its glance otherwise |
| Large | The same with more room: up to 10 events, a longer grocery list, a trip's whole leaderboard |
| Lock screen | Always `today`. Rectangular: the next event and the trip countdown. Inline: the next event. Circular: days to the trip. |

Tapping a widget opens what the card is about: the hub, or a trip's app.

The widgets run in [Scriptable](https://scriptable.app), a free iOS app, so you don't need
Xcode or an Apple Developer account. If the phone is offline, a widget shows the last
stream it fetched, marked "Offline".

## 1. Give the phone its own key

If your hub is behind Cloudflare Access, a widget can't sign in the way a browser does. It
sends a service token that can read the stream and nothing else. Create one for this phone
and add it to the **Hub Screens** policy. See
[Giving a screen its key](../../docs/outputs.md#giving-a-screen-its-key).

## 2. Install the script

1. Install **Scriptable** from the App Store.
2. In Scriptable, tap **+**, name the script `Family Hub`, and paste in
   [`scriptable/family-hub.js`](scriptable/family-hub.js).
3. Run it once (▶). Enter your hub URL (`https://hub.example.com`) and the token's Client ID
   and Client Secret. They're stored in the iOS Keychain.
4. Choose **Preview Medium** to check that it works.

## 3. Add widgets

1. Long-press the home screen → **+** → **Scriptable**, then pick a size and add it.
2. Long-press the new widget → **Edit Widget**:
   - **Script**: Family Hub
   - **When Interacting**: Run Script
   - **Parameter**: whose hub to show, and optionally which components
3. For the lock screen, customize the Lock Screen → add a **Scriptable** widget, and set it
   up the same way.

| Parameter | Shows |
|-----------|-------|
| `family` | The whole family's stream |
| `alex` | Alex's stream: their events, their trips, their to-dos |
| `alex today` | Only the `today` card. It never rotates. |
| `family photos trips` | Only those components, taking turns |

With no components named, the widget shows the stream set for `phone-widget` in your
`family.yaml`, or the family's default stream.

iOS decides when widgets refresh, usually every 15 to 30 minutes. The hub caches calendar
data for 5 minutes, so many widgets don't mean many Google API calls.

## Troubleshooting

| Widget says | Fix |
|-------------|-----|
| "Open this script in Scriptable to sign in" | Run the script in the app, and enter the URL and token. |
| "The hub didn't accept this widget's service token" | Check the token values (Run → Change hub sign-in), that the **Hub Screens** policy is **Service Auth** and includes the token, and that it's attached to the `/api/stream` application. |
| "Unknown view …" | Start the Parameter with a member id from your `family.yaml`, or `family`. |
| "Offline · as of …" | The phone couldn't reach the hub, so the widget shows the last stream it got. |

## Developing

`scriptable/family-hub.js` is one file. Each component it draws in full has a layout
function per size, and everything else goes through the glance layout. Run it in the
Scriptable app to preview any size with any parameter.
