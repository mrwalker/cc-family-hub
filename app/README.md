# Hub App

The part of cc-family-hub that runs on Cloudflare and on your family's screens.

| Path | What |
|------|------|
| `worker/` | The hub Worker. `createHub(config)` stores published data, reads live inputs, composes [the stream](../docs/stream.md), and serves the pages. |
| `public/` | The hub page, and the trip-app engine every trip shares |
| `build.mjs` | Validates a family's workspace and assembles its site. Runs as the `wrangler` build command (`family-hub build`). |
| `template/` | What `family-hub init` copies into a new hub repo |
| `widgets/` | [iPhone widgets](widgets/README.md) (Scriptable) |
| `macos/` | [Mac menu bar app](macos/README.md) (SwiftUI) |
| `roku/` | [Roku channel and screensaver](roku/README.md) (BrightScript) |
| `extras/` | Grocery email (Google Apps Script) |

To set up a hub, follow [docs/getting-started.md](../docs/getting-started.md). This page is
about how the app is built.

## How a family's hub is assembled

A family's hub repo holds no app code. Its `worker.js` is three lines:

```js
import { createHub } from "cc-family-hub/app/worker/index.js";
import config from "./.generated/hub-config.json";
export default createHub(config);
```

and its `wrangler.jsonc` runs `build.mjs` before every `dev` and `deploy`:

```
your hub repo                                   build.mjs writes
─────────────                                   ────────────────
workspace/family.yaml, members/*.yaml   ──►     .generated/hub-config.json   imported by worker.js, never served
cc-family-hub/app/public/               ──►     .generated/site/             the Worker's static assets
<trip>/ for each trip app               ──►       /<trip>/
public/ (optional overrides)            ──►       /
```

The build fails with `<file>: <path>: <problem>` lines when the workspace doesn't add up: a
member without a color, a trip app without a folder, a guest nobody listed. A failed build
leaves the live hub as it was.

## The Worker's routes

| Route | Who calls it | What |
|-------|--------------|------|
| `GET /api/stream` | Every screen | The stream, for a view and an output. See [docs/stream.md](../docs/stream.md#the-stream-api). |
| `GET /api/stream/image/<card id>` | Every screen | A card's photo |
| `GET /api/page/stream…` | The hub page | The same stream and images, under the hub's sign-in rather than the screens' Access application |
| `GET /api/events?days=N` | The hub page | Live calendar events, for the interactive calendar. Checks `X-Api-Token`. |
| `GET /api/config.js` | The hub page | Names, colors, timezone, title, trip-app links, and the events token |
| `GET /api/data.js` | The hub page | Everything published, for the page's full views (the whole movie list, every escape room) |
| `PUT /api/data/:kind` | The pipeline | Publish `plan`, `family`, or `strava`. Validated, then stored. |
| `GET /api/data/:kind` | You, when debugging | What's published, and when |
| `/api/grocery` | The hub page | The shared grocery list |
| `/api/household…` | The household page | Household records: read them, add and change pets, places and tasks (one or several at once), mark a task or a group done, undo it, add pets' photos, set up chores and tick them off, add escape rooms (and their pictures, fetched once and cached), add and change trips, mark movies, and take the month's movie picks from the pipeline. Writes check the Access sign-in. `GET /api/household/export` is the pipeline's, with the publish token. See [docs/architecture.md](../docs/architecture.md#household-records). |
| `/api/trip/:appId/checkins`, `/packing` | Trip apps | Quest check-ins and packing lists |
| Everything else | Browsers | Static assets: the hub page and trip apps |

Bindings: `ASSETS`, `HUB_DATA` (KV: published data and the grocery list), `TRIP_KV` (KV:
trip check-ins and packing), `HUB_DB` (D1: household records; optional). Secrets: `SA_CLIENT_EMAIL`, `SA_PRIVATE_KEY`, `API_TOKEN`,
`PUBLISH_TOKEN`.

## What the page is allowed to know

`/api/config.js` and the stream carry names, colors, the timezone, and formatted content.
They never carry email addresses or calendar ids. Those stay in `hub-config.json`, inside
the Worker. `/api/config.js` does carry the events token, so it must stay behind your sign-in.

## Rules for this folder

- **No family data.** This repo is public. Everything family-specific arrives through
  `build.mjs` or the Worker's secrets.
- **Old WebViews.** The hub page and trip apps are plain HTML, CSS, and JS with no build
  step, and they must run on Chrome 80 to 86. No CSS `inset`, no flexbox `gap`.
- **Keep `template/` working.** It's every new family's first experience.
- **Screens draw, the Worker decides.** What's in the stream and in what order is decided
  in `worker/stream.js` from the family's config. Don't put that logic in a client.

See [docs/contributing.md](../docs/contributing.md) to add a component or a screen.
