# Repository Structure

This repo is the toolkit. A family's own repo looks different: see
[getting-started.md](getting-started.md#1-create-your-hub-repo).

```
cc-family-hub/
├── hub/                    the pipeline
├── integrations/           inputs, and the outputs the pipeline pushes to
├── app/                    the hub Worker, its pages, and the screens
├── workspace.example/      a complete workspace for a made-up family
├── scripts/, tools/        setup helpers
├── bin/family-hub.mjs      the family-hub command
├── docs/
└── .claude/commands/       slash commands for working on this repo
```

## The pipeline (`hub/`)

| File | What |
|------|------|
| [`hub/index.ts`](../hub/index.ts) | The commands: `sync`, `render`, `plan`, `publish`, `summary` |
| [`hub/paths.ts`](../hub/paths.ts) | Where the workspace and secrets are. All code resolves paths through this. |
| [`hub/context/loader.ts`](../hub/context/loader.ts) | Reads the workspace: config, members, events, notes, the last plan |
| [`hub/context/builder.ts`](../hub/context/builder.ts) | Assembles the planner's context and renders it as Markdown |
| [`hub/planner/engine.ts`](../hub/planner/engine.ts) | Calls Claude, with prompt caching on the context |
| [`hub/planner/prompts/`](../hub/planner/prompts/) | The planning and summary prompts |
| [`hub/published-data.ts`](../hub/published-data.ts) | Gathers workspace content (trips, escape rooms, movies) for publishing |
| [`hub/integrations/registry.ts`](../hub/integrations/registry.ts) | Loads the family's active inputs and outputs |

## Inputs and pushes (`integrations/`)

| Path | What |
|------|------|
| [`_base/types.ts`](../integrations/_base/types.ts) | The types everything shares: `FamilyConfig`, `MemberProfile`, `CalendarEvent`, `WeeklyPlan`, and the `InputIntegration` and `OutputIntegration` interfaces |
| [`_base/schemas.ts`](../integrations/_base/schemas.ts) | Validators for workspace files and the plan |
| [`_base/BaseIntegration.ts`](../integrations/_base/BaseIntegration.ts) | Base class with `loadSecrets()` |
| [`_base/google-auth.ts`](../integrations/_base/google-auth.ts) | Service-account tokens |
| `inputs/google-calendar/`, `inputs/apple-reminders/`, `inputs/strava/` | Synced inputs |
| `outputs/hub-api/` | Publishes to the hub Worker |
| `outputs/google-calendar/` | Writes the planner's notes into events |

## The hub app (`app/`)

| Path | What |
|------|------|
| [`app/worker/index.js`](../app/worker/index.js) | `createHub(config)`: routing, live calendar reads, trip check-ins |
| `app/worker/stream.js` | Composes the stream and serves `/api/stream` |
| `app/worker/components/` | One file per stream component |
| [`app/worker/data-api.js`](../app/worker/data-api.js) | Validates and stores what the pipeline publishes |
| [`app/worker/photos.js`](../app/worker/photos.js) | Reads the iCloud shared album |
| [`app/public/index.html`](../app/public/index.html) | The hub page |
| `app/public/trip-app/` | The trip-app engine that every trip shares |
| [`app/build.mjs`](../app/build.mjs) | Validates a workspace and assembles a family's site. Runs as the `wrangler` build command. |
| `app/template/` | What `family-hub init` copies into a new hub repo, with its `CLAUDE.md` and slash commands |
| `app/widgets/` | iPhone widgets (Scriptable) |
| `app/macos/` | Mac menu bar app (SwiftUI) |
| `app/roku/` | Roku channel and screensaver (BrightScript) |
| `app/extras/` | Grocery email (Google Apps Script) |

## Commands

In a hub repo, `npx family-hub <command>`:

| Command | What |
|---------|------|
| `init <dir>` | Scaffold a new hub repo |
| `check` | Validate the workspace and secrets, and list inputs, outputs, and the stream |
| `sync` | Pull every synced input |
| `plan` | Plan through the Claude API, and publish |
| `render` | Write the planner prompt to `workspace/state/pending-prompt.md`, for an assistant |
| `publish` | Validate `workspace/state/last-plan.yaml` and publish it |
| `run` | `sync`, `plan`, `publish` |
| `summary` | Print a readable summary of the week |
| `build` | Validate the workspace and assemble the Worker's site |
| `setup calendars`, `setup strava` | Guided setup for those inputs |

In this repo, the same commands are npm scripts (`npm run sync`, `npm run plan`, …), and
`npm run typecheck` checks the TypeScript.

## Slash commands

A hub repo gets these from `app/template/.claude/commands/`:

| Command | What |
|---------|------|
| `/daily-plan` | Sync, plan with the assistant as the planner, and publish |
| `/add-member` | Add or update a member profile |
| `/add-trip` | Add or update a trip in `trips.yaml` |
| `/context` | Review and retire notes |
| `/weekly-summary` | A readable summary of the week |

This repo's own `.claude/commands/` has `/add-integration`, to scaffold a new input or output.
