# Architecture

## Overview

cc-family-hub has two halves:

- **The pipeline** (`hub/`, `integrations/`) is a Node.js process that runs on a cron or
  manually via Claude Code. It wakes up, plans, publishes, and exits. It has no persistent
  server. It's described below.
- **The hub app** (`app/`) is a Cloudflare Worker and the pages it serves: the wall-tablet
  and phone hub, trip apps, live calendars, and the data API that the pipeline publishes to.
  See [app/README.md](../app/README.md).

A family runs both from its own private **hub repo**. That repo holds `workspace/` (config
and content), its trip folders, and a thin Worker that pins a release of this repo:

```
family hub repo (private)                       cc-family-hub (this repo)
  workspace/ ──── HUB_WORKSPACE ────────────►   pipeline: plan ──► hub-api output
     │                                                                 │ PUT /api/data/:kind
     └── app/build.mjs (at deploy) ──►  Worker = createHub(config) ◄───┘
                                          │
                                          └──► hub page, trip apps (tablet, phones)
```

### Pipeline

```
workspace/          ← family data (gitignored)
    │
    ▼
hub/context/        ← loads and assembles all context
    │
    ▼
hub/planner/        ← calls Claude API with assembled context
    │
    ▼
hub/integrations/   ← dispatches output to active integrations
    │
    ▼
integrations/outputs/  ← writes to web portal, calendar, display, etc.
```

## Data Flow

### Input Path

```
Google Calendar API ──► integrations/inputs/google-calendar/
Apple Reminders     ──► integrations/inputs/apple-reminders/
                              │
                              ▼
                       workspace/calendars/*.yaml    (cached events)
                       workspace/context/**/*.yaml   (context items)
```

### Planning Path

```
workspace/family.yaml
workspace/members/*.yaml
workspace/calendars/*.yaml     ──► hub/context/builder.ts ──► PlanningContext
workspace/context/**/*.yaml
workspace/state/last-plan.yaml

PlanningContext ──► hub/planner/engine.ts ──► Claude API ──► WeeklyPlan

WeeklyPlan ──► workspace/state/last-plan.yaml  (persisted)
```

### Output Path

```
WeeklyPlan ──► hub/integrations/registry.ts ──► integrations/outputs/*/
                                                    ├── hub-api/         (validated PUT to the hub app's data API)
                                                    ├── google-calendar/ (enriched event notes)
                                                    ├── web-portal/      (static JSON)
                                                    ├── wall-display/    (HTTP push to tablet)
                                                    └── mobile-app/      (push notifications)
```

## Claude API Usage

The planner uses Claude with **prompt caching** on the context block. The context (family profiles + calendar events + notes) is large and changes slowly within a session, so caching it saves significant tokens on re-runs.

Model: `claude-opus-4-6` (most capable, handles complex scheduling logic well)

The planning prompt is in `hub/planner/prompts/daily-plan.md`. It's a Markdown file with a `{{CONTEXT}}` placeholder that gets substituted at runtime.

## Workspace Isolation

Family data never lives in this repo. A family's `workspace/` is gitignored here. It
usually lives in the family's private hub repo, where it can be versioned, and the pipeline
finds it through `HUB_WORKSPACE`. Secrets stay outside every repo (`HUB_SECRETS_DIR`).
`workspace.example/` is committed and serves as both documentation and a template for new
setups.

## Integration Contract

Integrations implement `InputIntegration` and/or `OutputIntegration` from `integrations/_base/types.ts`. The hub only ever talks to these interfaces. This means:

- Integrations can be added/removed by editing `workspace/family.yaml`
- No integration needs to know about any other integration
- The hub engine is completely decoupled from specific services

## State

Minimal state is persisted in `workspace/state/`:

| File | Contents |
|------|----------|
| `last-plan.yaml` | The most recent WeeklyPlan output |
| `sync-cursors.yaml` | Per-integration sync cursors (for incremental fetches) |
| `secrets.yaml` | Credentials; lives in `HUB_SECRETS_DIR` when that's set |

## Scheduling

The hub doesn't run a persistent scheduler. Instead, it relies on:
- **cron** (macOS launchd or Linux crontab) for production scheduling
- **Claude Code** (`/daily-plan`, `/sync-calendars`) for manual runs
- `workspace/family.yaml` documents the intended cron schedule

Any scheduler works. It can run either of these:
- `npm run plan`, which calls the Claude API, writes the plan, and publishes it.
- `npm run render`, then an assistant writes `state/last-plan.yaml` from the rendered
  prompt, then `npm run publish`.

Both exit non-zero if publishing fails.
