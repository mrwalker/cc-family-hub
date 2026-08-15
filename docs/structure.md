# Repository Structure

## Core Hub (`hub/`)

- **[hub/index.ts](../hub/index.ts)** — entry point, dispatches `plan` / `sync` / `summary` commands
- **[hub/context/loader.ts](../hub/context/loader.ts)** — reads all workspace files (family config, members, calendars, context items, last plan)
- **[hub/context/builder.ts](../hub/context/builder.ts)** — assembles a `PlanningContext` and renders it as Markdown for prompts
- **[hub/planner/engine.ts](../hub/planner/engine.ts)** — calls Claude (`claude-opus-4-6`) with prompt caching on the context block
- **[hub/planner/prompts/daily-plan.md](../hub/planner/prompts/daily-plan.md)** — the planning prompt template
- **[hub/planner/prompts/weekly-summary.md](../hub/planner/prompts/weekly-summary.md)** — friendly summary prompt
- **[hub/integrations/registry.ts](../hub/integrations/registry.ts)** — dynamically loads active integrations at runtime

## Integration Base (`integrations/_base/`)

- **[types.ts](../integrations/_base/types.ts)** — the complete type system: `FamilyConfig`, `MemberProfile`, `CalendarEvent`, `WeeklyPlan`, `InputIntegration`, `OutputIntegration` interfaces
- **[schemas.ts](../integrations/_base/schemas.ts)** — Zod validators for YAML config files
- **[BaseIntegration.ts](../integrations/_base/BaseIntegration.ts)** — abstract base with `loadSecrets()` helper

## Integrations

- **Inputs:** `google-calendar` (OAuth2, full event fetch), `apple-reminders` (AppleScript, macOS)
- **Outputs:** `google-calendar` (enriched descriptions + action item events), `web-portal` (static JSON), `wall-display` (HTTP push to Android tablet)
- Each has a `README.md` with setup instructions

## Workspace

- **[workspace.example/](../workspace.example/)** — committed reference with fake "Walker family" data (4 members, context notes, shopping items, secrets template)
- **`workspace/`** — gitignored; your real family data goes here

## Custom Claude Code Commands (`.claude/commands/`)

| Command | File | Description |
|---------|------|-------------|
| `/daily-plan` | [daily-plan.md](../.claude/commands/daily-plan.md) | Run the full planning routine |
| `/add-member` | [add-member.md](../.claude/commands/add-member.md) | Add a new family member |
| `/add-integration` | [add-integration.md](../.claude/commands/add-integration.md) | Scaffold a new integration |
| `/sync-calendars` | [sync-calendars.md](../.claude/commands/sync-calendars.md) | Pull latest calendar data |
| `/context` | [context.md](../.claude/commands/context.md) | Review and manage accumulated context |
| `/weekly-summary` | [weekly-summary.md](../.claude/commands/weekly-summary.md) | Generate a human-readable weekly summary |

## Scripts

| Command | Script | Description |
|---------|--------|-------------|
| `npm run setup` | [scripts/setup.js](../scripts/setup.js) | Bootstrap `workspace/` from the example template |
| `npm run sync` | — | Pull all calendar data from active input integrations |
| `npm run render` | — | Render the daily-plan prompt to `workspace/state/pending-prompt.md` |
| `npm run publish` | — | Validate + publish an assistant-written plan to output integrations |
| `npm run plan` | — | Run the full planning pass and push to output integrations (requires Anthropic API key) |
| `npm run summary` | — | Print a human-readable weekly summary |
| `npm run auth:google-calendar` | [scripts/auth/google-calendar.js](../scripts/auth/google-calendar.js) | Interactive OAuth2 flow for Google Calendar |
| `npm run check-secrets` | [scripts/check-secrets.js](../scripts/check-secrets.js) | Validate credentials for all active integrations |

## Docs

- **[docs/architecture.md](architecture.md)** — data flow diagrams, Claude API usage, state management
- **[docs/contributing.md](contributing.md)** — how to add integrations with skeleton code
- **[docs/structure.md](structure.md)** — this file
