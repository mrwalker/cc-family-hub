# Hub App

The family-facing side of cc-family-hub: a Cloudflare Worker and the pages it
serves.

- **The hub page** is built for a wall tablet and phones. It shows the week's plan, live
  calendars, trips, shopping, and more.
- **Trip apps** are offline-capable phone pages for family trips, with quests, a
  leaderboard, and packing lists.
- **The data API** receives what the planning pipeline publishes, through the `hub-api` output.
- **Phone widgets** put upcoming events and a trip countdown on the iPhone home and lock
  screens, via Scriptable. See [widgets/README.md](widgets/README.md).
- **A Mac menu bar app** shows the next event and the trip countdown next to the clock.
  See [macos/README.md](macos/README.md).
- **A Roku channel** puts the day and the trip countdown on the TV, and doubles as a screensaver.
  See [roku/README.md](roku/README.md).

```
cc-family-hub (this repo)                   your family's hub repo (private)
─────────────────────────                   ───────────────────────────────
app/worker/      the Worker      ◄─import── worker.js       createHub(config)
app/public/      hub page,       ◄─copied── wrangler.jsonc  build.command runs app/build.mjs
                 trip-app engine            workspace/      family.yaml, members/, trips.yaml, …
app/build.mjs    validates + assembles      <trip>/         each trip app's content
                                            public/         optional extra/override static files
                                              │
                                              ▼ build
                                            .generated/hub-config.json  +  .generated/site/
```

Your family's repo contains no app code. It pins a version of cc-family-hub,
holds your config and trip content, and deploys. To upgrade, bump the version.

## Set up your family's hub

You need a Cloudflare account with a domain on it, and a Google service account
that can read your family's calendars (`npm run setup:calendars` walks you through that).

1. **Create a private repo** from [`app/template/`](template/). Rename `gitignore` to
   `.gitignore`, and set `name` and the domain in `wrangler.jsonc`.
2. **Move your workspace into it.** Put your `workspace/` (family.yaml, members/,
   trips.yaml, …) at the repo root. Point the pipeline at it with `HUB_WORKSPACE` in
   cc-family-hub's `.env`, and keep secrets outside both repos with `HUB_SECRETS_DIR`.
   The template's `.gitignore` already excludes the runtime state.
3. **Add the hub settings to `family.yaml`.** Give each member a `color` (and optionally a
   `shortName`), then add a `hub:` section. [`workspace.example/family.yaml`](../workspace.example/family.yaml)
   shows every field. Calendar ids and sign-in emails come from `members/<id>.yaml`.
4. **Create the KV namespaces** and put their ids in `wrangler.jsonc`:
   ```bash
   npx wrangler kv namespace create HUB_DATA
   npx wrangler kv namespace create TRIP_KV
   ```
5. **Set the Worker secrets:**
   ```bash
   npx wrangler secret put SA_CLIENT_EMAIL     # service account email
   npx wrangler secret put SA_PRIVATE_KEY      # its private key (PEM)
   openssl rand -hex 32 | npx wrangler secret put API_TOKEN
   openssl rand -hex 32 | npx wrangler secret put PUBLISH_TOKEN   # also goes in secrets.yaml → hub-api
   ```
6. **Put it behind Cloudflare Access** (Zero Trust → Access → Applications → Self-hosted, your domain):
   - Add an **Allow** policy listing your family's emails. Use a 30-day session so a wall tablet stays signed in.
   - Exclude the path `/api/events`. It checks its own `X-Api-Token`, and the
     page gets that token from `/api/config.js`, which stays behind Access.
   - Add a **Service Auth** policy with a service token for the pipeline, and attach it
     to this application. See [`integrations/outputs/hub-api/README.md`](../integrations/outputs/hub-api/README.md).
7. **Deploy.** Run `npm install && npm run deploy`, or connect the repo to Workers Builds so
   every push to main deploys. Use `npm run dev` for a local preview.
8. **Publish data.** Add `hub-api` to `integrations.active` and run the pipeline.

## How the config flows

- **At deploy:** `app/build.mjs` reads `family.yaml` and `members/*.yaml`. It fails with
  `<file>: <path>: <problem>` lines if something doesn't match up, such as an unknown guest or a
  trip app without a folder. Otherwise it writes `.generated/hub-config.json`.
- **In the Worker:** `createHub(config)` uses the config to choose which calendars to fetch,
  which trips exist, who can score, and which sign-in belongs to whom.
- **In the page:** the page loads `/api/config.js`, which contains only names, colors, the
  timezone, the title, trip-app links, the `/api/events` token, and the grocery-email URL.
  It never contains email addresses or calendar ids.

Because `/api/config.js` carries the events token and the grocery URL, it must stay behind
your auth.

Content that changes day to day, such as the plan, trips, escape rooms, and movies, doesn't
need a deploy. The pipeline publishes it to `/api/data/:kind` (see [`worker/data-api.js`](worker/data-api.js)).

## Optional extras

- **Grocery email.** The Shopping module can email the list. Deploy
  [`extras/grocery-email.gs`](extras/grocery-email.gs) as a Google Apps Script web app and set
  `hub.groceryEmailUrl`.
- **Phone widgets.** See [`widgets/README.md`](widgets/README.md).
- **Mac menu bar app.** See [`macos/README.md`](macos/README.md).
- **Roku channel.** See [`roku/README.md`](roku/README.md).
- **Trip apps.** See [`docs/trip-apps.md`](../docs/trip-apps.md).
- **Wall tablet.** See [`docs/wall-tablet.md`](../docs/wall-tablet.md).

## Developing the app

The page and trip apps are plain HTML, CSS, and JS with no build step, and they must keep
working on an old Android WebView (Chrome ~80–86). Avoid CSS `inset` and flexbox `gap`,
and use grid with `gap` or margins instead.

To test a change against a real family repo, point that repo's dependency at your
checkout (`"cc-family-hub": "file:../cc-family-hub"`), run `npm install`, and then run `npm run dev`.

Release by tagging `vX.Y.Z` on main. Family repos pin the tag.
