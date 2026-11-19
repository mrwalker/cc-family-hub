# Trip Apps

Trip apps are phone-first, offline-capable companion pages for family trips. Each one has a
schedule, quests with a family leaderboard, packing lists, and tips. The hub serves each app
at `/<trip>/`.

A trip app is an output and an input at once. People use it on their phones during the
trip, and what they log feeds [the stream](stream.md): every screen's card for that trip
shows the hero photo, the countdown, the leaderboard, and today's schedule while the trip is
on. Tapping a trip card opens its app. After the trip, the final standings stay on its
`past-trips` card.

## Layout

| Where | What |
|-------|------|
| `app/public/trip-app/app.js` (this repo) | **Shared engine**: tabs, scoring, offline-first sync. |
| `app/public/trip-app/app.css` | Shared styles. A trip overrides the palette with CSS variables in its own `index.html`. |
| `app/public/trip-app/sw-core.js` | Shared service worker: precache, then cache-first with a background refresh. |
| `<trip>/index.html` (your hub repo) | Page shell: title, icons, palette overrides. Loads `trip-data.js`, then `../trip-app/app.js`. |
| `<trip>/trip-data.js` | **All content** (`window.TRIP`): dates, people, schedule, quests, packing, tips. Hand-edited; the pipeline doesn't touch it. |
| `<trip>/sw.js` | Cache version and file list, then `importScripts("../trip-app/sw-core.js")`. |
| `<trip>/img/` | Hero photo and home-screen icons. |
| `hub.tripApps` in `family.yaml` | Registers the app: the trip it belongs to, its path, its `appId`, and its guests. |

The Worker stores check-ins and packing lists in the `TRIP_KV` namespace
(`/api/trip/:appId/checkins`, `/api/trip/:appId/packing`). Without that namespace, the apps still work
but stay local to each phone.

## Adding a trip

1. **Create the folder.** Copy an existing trip folder to `<trip>/` in your hub repo and edit it:
   - `index.html`: title and palette
   - `manifest.webmanifest`
   - `sw.js`: give it a new version, such as `<family>-trip-<trip>-v1`
   - `trip-data.js`: a new `id`
   - `img/`
2. **Register it.** In `family.yaml`, add any new people under `hub.guests`, with an `email`
   for anyone who will sign in. Then add an entry under `hub.tripApps`:
   - `trip`: its id in `trips.yaml`
   - `path`: `/<trip>/`
   - `appId`: the `id` in `trip-data.js`
   - `guests`: who can score besides the family

   The build checks all of these.
3. **Deploy.** The trip's card joins the stream on every screen.

`window.TRIP.storagePrefix` sets the localStorage key prefix (default `family-trip`). Once a
trip is in use, don't change it, or phones lose check-ins they haven't synced yet.

## Editing

- **Bump the `version` in each affected `<trip>/sw.js`** after any change to a trip folder or
  to the shared engine. Otherwise phones keep serving their cached copy.
- **Keep quest and packing `id`s stable.** They're stored in check-ins: change the text
  freely, but never rename an id after someone has logged it.
- **Preview any day** with `?date=2027-07-04`, and add `&time=14:30` to move the "now" marker.
- **Schedule items** take a 24-hour `time` (`"08:30"`) or a free-text `when` (`"Morning"`). A
  tag starting with `!` renders as a yellow warning.

## Design language

The trip apps and the hub page share one look:
- dark ink, with translucent glass panels and hairline borders
- monospace uppercase micro-labels and big thin display type
- one accent color per trip (`--sea-300`)
- no emoji in the interface

Keep it compatible with old Android WebViews (Chrome ~80–86): no CSS `inset` and no flexbox `gap`.

## Installing on iPhone

1. Open the trip URL in Safari and sign in.
2. Tap Share, then **Add to Home Screen**.
3. **Open it from the new icon** and sign in again. Home-screen apps keep their own cookies and storage.
4. Wait for **✓ Offline-ready** in the top bar. The app now works in airplane mode.

Quests logged offline show "N waiting for Wi-Fi" and sync when the phone is back online.

## Scoring

- Each quest's points count once per person.
- **+5 First Finder** goes to the first person to log a quest. Ties share it.
- **+20 Variety** goes to anyone who logs at least one quest in every category.
- Anyone can undo any entry (honor system).
