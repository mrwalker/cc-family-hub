# Phone Widgets

The hub on the iPhone home screen and lock screen. A widget shows one card from
[the stream](../../docs/stream.md) and moves to the next each time iOS refreshes it.

| Size | Shows |
|------|-------|
| Small | `today`: the next event, its people's colors, and an urgent flag from the plan if there is one. Name components in the Parameter to rotate through those instead, each drawn as its glance: headline, detail line, emoji, and photo. |
| Medium | A card in full where the widget knows the component (`today`, `photos`, `trips`, `grocery`), and its glance otherwise |
| Large | The same with more room: up to 10 events, up to 24 grocery items, a trip's leaderboard and, while you're on it, today's schedule |
| Lock screen | Always `today`, whatever components the Parameter names. Rectangular: the next event, then an urgent flag or how many more. Inline: the next event. Circular: how many events are left today. |

Any card can be drawn from its glance, so a component added to the hub later shows up on the
widget right away.

Tapping a widget opens what the card is about: the hub at that component, or a trip's app.

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

The Parameter is a view (a member id, or `family`), then any component ids from
[the stream](../../docs/stream.md#components).

| Parameter | Shows |
|-----------|-------|
| `family` | The whole family's stream |
| `alex` | Alex's stream: their events, their trips, their to-dos |
| `alex today` | Only the `today` card. It never rotates. |
| `family photos trips` | Only those components, taking turns |

With no components named, a medium or large widget shows the stream set for `phone-widget`
in your `family.yaml`, or the family's default stream. A small widget shows `today`. An
empty Parameter is `family`.

Parameters from the older widget still work: `mix` is the default stream, `photos` (or
`photo`) is the album, and `trips` (or `trip`) is the trip cards. The first word that isn't
a component is the view, so `photos alex` works too, and a Parameter with no view is
`family`.

Each widget remembers the last card it showed, so it picks up where it left off. If that
card has left the stream, it moves on from the same place in the list. Widgets with the same
Parameter share their place.

iOS decides when widgets refresh, usually every 15 to 30 minutes. The hub caches calendar
data for 5 minutes, so many widgets don't mean many Google API calls.

### Upgrading from a script older than v0.9.0

Earlier versions of this script read `/api/widget`. This one reads `/api/stream`, so the
phone's token has to be on the `/api/stream` application (step 1). If your **Hub Screens**
policy is only attached to an `/api/widget` application, attach it to `/api/stream` too,
then paste in the new script. Your Parameters keep working.

## Troubleshooting

| Widget says | Fix |
|-------------|-----|
| "Open this script in Scriptable to sign in" | Run the script in the app, and enter the URL and token. |
| "The hub didn't accept this widget's service token" | Check the token values (Run → Change hub sign-in), that the **Hub Screens** policy is **Service Auth** and includes the token, and that it's attached to the `/api/stream` application. |
| "Unknown view …" | Start the Parameter with a member id from your `family.yaml`, or `family`. |
| "Unknown component …" | A word after the view isn't a component. The message lists the ones the hub knows. |
| "This hub has no /api/stream" | The hub is older than the stream. Upgrade its cc-family-hub to v0.9.0 or later and deploy it. |
| "Nothing in … right now" | Those components have no cards right now, for example an empty grocery list. |
| "Offline · as of …" | The phone couldn't reach the hub, or the hub turned down the token, so the widget shows the last stream it got. |
| "Couldn't reach the hub" | The same, before this widget has fetched any stream to fall back on. |

## Developing

`scriptable/family-hub.js` is one file. Each component it draws in full has a layout
function per size (the `NATIVE` table), and everything else goes through the glance layout.
Run it in the Scriptable app to preview any size with any parameter. Each preview steps to
the next card, the same as a widget refresh.
