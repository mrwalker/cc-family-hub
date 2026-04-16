# Claude Code Family Hub

## Project Purpose

This is a family coordination hub powered by Claude Code. It ingests inputs from various sources (calendars, notes, photos, todos), applies AI-powered planning and enrichment, and distributes the results to multiple output integrations (displays, apps, notifications).

## Repository Layout

```
cc-family-hub/
├── CLAUDE.md                    # This file — Claude Code project instructions
├── README.md                    # Human-readable project overview
├── workspace/                   # YOUR family's private workspace (gitignored)
│   ├── family.yaml              # Family configuration
│   ├── members/                 # Individual member profiles
│   ├── context/                 # Free-form notes, links, photos
│   ├── calendars/               # Cached calendar data
│   └── state/                   # Runtime state (schedules, last-run, etc.)
├── workspace.example/           # Committed example workspace for reference
├── hub/                         # Core hub engine
│   ├── planner/                 # Claude-powered planning logic
│   ├── context/                 # Context loading and assembly
│   └── scheduler/               # Cron/trigger management
├── integrations/
│   ├── _base/                   # Shared types and base classes
│   ├── inputs/                  # Input integrations
│   └── outputs/                 # Output integrations
├── scripts/                     # Setup, sync, and utility scripts
└── .claude/
    └── commands/                # Custom Claude Code slash commands
```

## Workspace vs. Source

- `workspace/` is **gitignored** and contains real family data. Each family maintains their own.
- `workspace.example/` is committed and shows the expected shape with fake data.
- Never commit anything from `workspace/` — it contains PII.

## Key Concepts

### Family Configuration (`workspace/family.yaml`)
Top-level config: family name, timezone, members list, active integrations, and hub schedule.

### Member Profiles (`workspace/members/<name>.yaml`)
Per-person: name, email, age, school/work info, hobbies, calendar IDs, notification preferences.

### Context (`workspace/context/`)
Free-form supplementary information — notes, flagged links, shopping list items, photos. Organized by type and date.

### State (`workspace/state/`)
Persisted runtime state: last planning run timestamp, pending actions, integration sync cursors.

### Integrations
Each integration lives in `integrations/inputs/<name>/` or `integrations/outputs/<name>/` and exports a class implementing the base `InputIntegration` or `OutputIntegration` interface from `integrations/_base/types.ts`.

## Working With This Project

### Adding a New Family Member
Run: `/add-member`
This will prompt for details and scaffold `workspace/members/<name>.yaml`.

### Running the Daily Planning Routine
Run: `/daily-plan`
Loads all context, runs the planner, updates state, and pushes to output integrations.

### Adding a New Integration
1. Create `integrations/inputs/<name>/` or `integrations/outputs/<name>/`
2. Implement the `InputIntegration` or `OutputIntegration` interface
3. Register it in `workspace/family.yaml` under `integrations.active`
4. Add any required credentials to `workspace/state/secrets.yaml` (gitignored)

### Syncing Calendars
Run: `/sync-calendars`
Pulls latest events from all configured calendar integrations and updates `workspace/calendars/`.

## Planning Prompts

Prompt templates live in `hub/planner/prompts/`. When running the planner, Claude assembles context from:
1. `workspace/family.yaml` — family config and active members
2. `workspace/members/*.yaml` — all member profiles
3. `workspace/context/` — recent notes and flagged items
4. `workspace/calendars/` — upcoming calendar events (next 14 days)
5. `workspace/state/last-plan.yaml` — output of the previous planning run

## Conventions

- **YAML** for all configuration and data files
- **TypeScript** for all hub and integration code
- **Markdown** for prompts, templates, and documentation
- Integration names use kebab-case: `google-calendar`, `apple-reminders`
- Member profile filenames match the member's `id` field in `family.yaml`
- All dates/times stored in ISO 8601; all times include timezone offset
- Never hardcode credentials — use `workspace/state/secrets.yaml`

## Secrets Management

`workspace/state/secrets.yaml` is gitignored. It holds OAuth tokens, API keys, and other credentials. The schema matches what each integration's `README.md` documents. Run `scripts/check-secrets.sh` to validate that all required secrets are present for active integrations.
