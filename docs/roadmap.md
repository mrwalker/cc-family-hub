# Roadmap

The other docs describe the hub as designed for v1.0. This page lists what they describe
that the current release doesn't do yet, in the order to build it. When an item ships, delete it here.

## Where v0.8.1 stands

**What each screen shows today.** The target is in [outputs.md](outputs.md#what-each-screen-shows).
The hub page rotates through the stream and draws every component in full. The other
screens don't read the stream yet:

| Component | iPhone widget | Mac | Roku |
|-----------|---------------|-----|------|
| `today` | yes | yes | yes |
| `photos` | yes | yes | yes |
| `trips` | yes | yes | yes |
| everything else | no | no | no |

They read `/api/widget`, `/api/widget/trips`, and `/api/widget/photos`, and each decides its
own rotation.

**The pipeline runs from a clone of this repo.** The package has no `bin`. A family runs
`npm run plan` in a cc-family-hub checkout with `HUB_WORKSPACE` pointing at its hub repo.
Only the Worker is consumed as a dependency.

## To build

### 1. Every screen on the stream

For each of the Scriptable widget, the Mac app, and the Roku channel:

- Read `/api/stream?output=<id>` in place of the `/api/widget*` endpoints.
- Draw any card from its `glance`. Keep the native layouts that exist for `today`, `photos`,
  and `trips`, and add `grocery` and `past-trips` where [outputs.md](outputs.md#what-each-screen-shows) says full.
- Move rotation rules out of the clients: the Roku's "anchor, then three photos" becomes
  `photosBetween: 3`, and the widget's `mix` parameter becomes the default. The widget
  Parameter becomes a view followed by component ids (`alex today`, `family photos trips`).
  Keep reading `mix`, `photos`, and `trips` as before.
- Document the move from the `/api/widget` Access application to `/api/stream`.

### 2. The `family-hub` command

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

### 3. Clear out what's been replaced

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
