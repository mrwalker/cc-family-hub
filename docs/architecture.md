# Architecture

## Overview

The hub runs as a local Node.js process (invoked on a cron or manually via Claude Code). It has no persistent server — it's a pipeline that wakes up, does its work, and exits.

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

Every family forks the repo and has their own `workspace/` directory. The workspace is gitignored — it contains PII. The `workspace.example/` directory is committed and serves as both documentation and a template for new setups.

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
| `secrets.yaml` | Credentials (gitignored) |

## Scheduling

The hub doesn't run a persistent scheduler. Instead, it relies on:
- **cron** (macOS launchd or Linux crontab) for production scheduling
- **Claude Code** (`/daily-plan`, `/sync-calendars`) for manual runs
- `workspace/family.yaml` documents the intended cron schedule

See `docs/scheduling.md` for crontab setup instructions.
