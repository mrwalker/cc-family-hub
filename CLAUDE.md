# Claude Code Family Hub

## What this is

A toolkit that families use to build their own hub. It has three parts:

- **Inputs** bring in a family's data: calendars, a photo album, trips, lists.
- **The brain** integrates it, has Claude plan the week, and composes one **stream** of cards.
- **Outputs** show the stream: a wall tablet, phone widgets, the Mac menu bar, a Roku.

The principle to protect: **one stream, every screen.** A component is built once, in the
Worker, and appears on every output. No screen gets its own data path or its own rules
about what to show.

Read `docs/architecture.md` and `docs/stream.md` before changing anything structural.

## The docs describe v1.0

The docs are written for the target design. `docs/roadmap.md` lists what they describe that
isn't built yet. Before relying on something a doc mentions (`/api/stream`, the
`family-hub` command, `inputs:` in `family.yaml`), check the roadmap and the code. When you
build a roadmap item, delete it from the roadmap in the same change.

## Two repos

- **This repo is public and is a dependency.** It holds all code and no family data.
- **A family's hub repo is private.** It holds `workspace/`, trip folders, a three-line
  `worker.js`, and a `package.json` that pins a tag of this repo. Families don't work in
  this repo.

Never put family data here: no names, emails, calendar ids, tokens, or URLs, in code,
comments, tests, examples, or commit messages. Examples use the made-up Rivera family in
`workspace.example/`.

## Layout

```
hub/                 the pipeline: sync, plan, publish (TypeScript, run with tsx)
integrations/        synced inputs, and outputs the pipeline pushes to
  _base/             shared types, validators, base class
app/
  worker/            the hub Worker: createHub(config), stream, components, data API
  public/            the hub page and the shared trip-app engine (plain JS, no build)
  build.mjs          validates a workspace, assembles a family's site
  template/          a new family's hub repo, with its CLAUDE.md and slash commands
  widgets/ macos/ roku/   the screens
workspace.example/   a complete example workspace
bin/family-hub.mjs   the family-hub command families run
docs/
.claude/commands/    /add-integration, for working on this repo
```

`docs/structure.md` has the file-by-file version.

## Rules

### Paths
- All pipeline code resolves workspace and secrets paths through `hub/paths.ts`
  (`scripts/workspace-path.js` for plain-JS scripts). Never build a `workspace/…` path from
  `process.cwd()` yourself.
- `HUB_WORKSPACE` and `HUB_SECRETS_DIR` override the defaults. Secrets must be able to
  live outside every repo.

### The Worker and the stream
- Decide what's in the stream, and its order, in the Worker from the family's config.
  Never in a client.
- Every card has a complete `glance`. A screen must be able to draw any card from it.
- A component with nothing to show returns no cards.
- A failing input skips its cards. It never fails the stream.
- Never remove or repurpose a field in the card envelope. Installed screens update slowly.
- Validate published data in `app/worker/data-api.js`. Errors read `<path>: <problem>`.

### The hub page and trip apps
- Plain HTML, CSS, and JS with no build step.
- Must run on an old Android WebView (Chrome 80 to 86): no CSS `inset`, no flexbox `gap`.
- A change to `app/public/trip-app/` reaches phones only after a family bumps its trips'
  `sw.js` versions. Never change a `localStorage` key or a check-in id format without a migration.

### Config
- Keep `app/template/` and `workspace.example/` working and current. They're what a new
  family starts from.
- When you rename a `family.yaml` key, keep accepting the old one and list it in
  `docs/workspace.md`.
- `app/build.mjs` errors read `<file>: <path>: <problem>`.

### Errors
- Say what's wrong and what to do next. The pipeline is often run by an assistant that acts
  on the message.
- The pipeline ends with `PUBLISH OK` or `PUBLISH FAILED` and exits non-zero on failure.

## Conventions

- TypeScript for the pipeline and integrations. Plain JavaScript for the Worker and pages.
- YAML for everything a family edits. Markdown for prompts and docs.
- Ids are kebab-case: `google-calendar`, `past-trips`. A member's profile filename matches their `id`.
- Dates and times are ISO 8601. Times carry an offset. Screens show the family's timezone.

## Checking your work

- `npm run typecheck` for the pipeline.
- For the app, run a hub repo against this checkout: set its dependency to
  `"cc-family-hub": "file:../cc-family-hub"`, `npm install`, `npm run dev`.
- Screens: `app/macos` has `FAMILY_HUB_SNAPSHOT`, and `app/roku/build.sh` has `--screenshot`.

## Releasing

Tag `vX.Y.Z` on `main`. Hub repos pin the tag. Update the tag in `app/template/package.json`.
