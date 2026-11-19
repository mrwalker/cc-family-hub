# Roadmap

The other docs describe the hub as designed for v1.0. This page lists what they describe
that the current release doesn't do yet, in the order to build it. When an item ships, delete it here.

## Where v0.7.0 stands

**What each screen shows today.** The target is in [outputs.md](outputs.md#what-each-screen-shows).

| Component | Hub page | iPhone widget | Mac | Roku |
|-----------|----------|---------------|-----|------|
| `today` | yes | yes | yes | yes |
| `week` | yes (3-Day and 14-day tabs) | no | no | no |
| `plan` | yes | no | no | no |
| `photos` | yes | yes | yes | yes |
| `trips` | **outdated** | yes | yes | yes |
| `past-trips` | a list of rows inside Trips | no | no | no |
| `grocery` | yes, but saved on that device only | no | no | no |
| `escape-rooms` | yes | no | no | no |
| `movies` | yes | no | no | no |
| `workouts` | yes | no | no | no |

**The hub page doesn't rotate through everything.** Its tabs are in two rows
(`category: "calendar"` and `"info"` in `MODULES`, `app/public/index.html`), and
`restartTimer()` rotates only within the row that was last tapped. Left alone, a wall tablet
loops Today, Photos, 3-Day, Calendar, Weekly Plan and never reaches Trips, Escape Rooms,
Movies, or Grocery.

**The hub page's Trips view predates trip apps.** `buildTrips()` shows one `featured: true`
trip as a large panel, then rows for the others, then past trips. It doesn't use the per-trip
summaries (countdown, hero, leaderboard, today's schedule) that `app/worker/trips.js` builds
for the other screens.

**The stream exists, but no screen reads it yet.** v0.7.0 serves `GET /api/stream` with all
ten components. The page still rotates its own tabs, and the widget, Mac app, and Roku still
read `/api/widget`, `/api/widget/trips`, and `/api/widget/photos`, each with its own rotation.

**The pipeline runs from a clone of this repo.** The package has no `bin`. A family runs
`npm run plan` in a cc-family-hub checkout with `HUB_WORKSPACE` pointing at its hub repo.
Only the Worker is consumed as a dependency.

## To build

### 3. The hub page on the stream

- Replace the two tab rows with one rotation through `/api/stream` cards.
- Rebuild the Trips view as one card per trip from the `trips` component, and add `past-trips`.
  Drop `featured`.
- Tapping stops rotation, and two idle minutes resume it.
- Keep the 3-Day and 14-day calendars as the interactive full view of `week`.
- It must still run on Chrome 80 to 86: no CSS `inset`, no flexbox `gap`.

### 4. A shared grocery list

The Worker side shipped in v0.7.0 (`/api/grocery`, and the plan's shopping items merge in
on publish). Left: the hub page.

- Read and write `/api/grocery` in place of `localStorage` (`hub-grocery-list`), so the
  wall tablet and a phone agree.
- Migrate a device's existing local list on first load.

### 5. Every screen on the stream

For each of the Scriptable widget, the Mac app, and the Roku channel:

- Read `/api/stream?output=<id>` in place of the `/api/widget*` endpoints.
- Draw any card from its `glance`. Keep the native layouts that exist for `today`, `photos`,
  and `trips`, and add `grocery` and `past-trips` where [outputs.md](outputs.md#what-each-screen-shows) says full.
- Move rotation rules out of the clients: the Roku's "anchor, then three photos" becomes
  `photosBetween: 3`, and the widget's `mix` parameter becomes the default. The widget
  Parameter becomes a view followed by component ids (`alex today`, `family photos trips`).
  Keep reading `mix`, `photos`, and `trips` as before.
- Document the move from the `/api/widget` Access application to `/api/stream`.

### 6. The `family-hub` command

- Add a `bin` to `package.json` with `init`, `check`, `sync`, `render`, `plan`, `publish`,
  `summary`, `run`, `build`, and `setup calendars|strava`. Most are the existing
  `hub/index.ts` commands. `build` is `app/build.mjs`. `run` is sync, plan, publish.
- Move `tsx` to `dependencies`, or compile, so the command works when installed.
- `init` copies `app/template/` and `workspace.example/`, and adds a `CLAUDE.md` and
  `.claude/commands/` to the new hub repo. Today the slash commands exist only in this repo,
  and they call `npm run …`. The copies should call `npx family-hub …`. They also still
  mention the web portal.
- `check` joins `app/build.mjs`'s validation with `scripts/check-secrets.js`.
- Load a family's own inputs from `integrations/inputs/<id>/` in its hub repo.
  `hub/integrations/registry.ts` only looks inside this package.

### 7. Clear out what's been replaced

- Remove the `web-portal`, `github-pages`, and `wall-display` outputs, `outputs/web-portal/`,
  `scripts/build-family-data.ts`, and the `setup:portal` script. The hub app replaced them.
  The `wall-display` output pushes to an Android app that was never written.
- Remove `mobile-app` from `workspace.example/family.yaml`. No such output exists.
- Remove `/api/widget*` at v1.0.

## Later

Ideas, not commitments:

- More inputs: weather, school and sports calendars by ICS link, a chores list, Todoist.
- More outputs: a morning summary by email or text, an Apple TV screensaver, an e-ink frame.
- A family's own components, loaded from its hub repo the way its own inputs are.
- Photos from Google Photos or a folder, for families that aren't on iCloud.
