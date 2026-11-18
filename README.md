# Claude Code Family Hub

A family coordination hub powered by Claude Code. It pulls from scattered inputs — calendars, notes, photos, to-do lists, flagged links — applies AI-powered planning and enrichment, and pushes the results to wherever your family needs them.

## What It Does

```
  INPUTS                    HUB                        OUTPUTS
  ──────                    ───                        ───────
  Google Calendar  ──┐                        ┌──  Annotated Calendar
  Apple Reminders  ──┤                        ├──  Weekly Plan (web portal)
  Family Bios      ──┤   Claude Code Engine   ├──  Wall Display (Android)
  Flagged Links    ──┤   ─────────────────    ├──  Menu Bar Notifications
  Shopping Items   ──┤   • Context Assembly   ├──  Shopping List
  Photos           ──┤   • AI Planning        ├──  Photo Reel
  Free-form Notes  ──┘   • Enrichment         └──  Mobile App Push
                         • Scheduling
```

On a configurable schedule (typically daily), the hub:
1. Loads all family context and upcoming calendar events
2. Runs a Claude-powered planning pass over the next 7–14 days
3. Enriches events with notes, weather considerations, driving info, cross-schedule conflicts
4. Updates all output integrations with the refreshed plan

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Git

### Setup

```bash
# Clone the repo
git clone https://github.com/your-family/cc-family-hub.git
cd cc-family-hub

# Install dependencies
npm install

# Bootstrap your family workspace
npm run setup

# Follow the prompts — it will create workspace/ from workspace.example/
# and walk you through configuring family.yaml
```

### Configure Your Family

Edit `workspace/family.yaml` to set your family name, timezone, and member list. Then run:

```bash
# Add each family member interactively
claude /add-member
```

### Connect Integrations

Each integration has its own setup guide in `integrations/inputs/<name>/README.md` or `integrations/outputs/<name>/README.md`. At minimum, connect at least one calendar input and one output.

```bash
# See which integrations are available
ls integrations/inputs/
ls integrations/outputs/

# Activate an integration by adding it to workspace/family.yaml
# then configure its credentials in workspace/state/secrets.yaml
```

### Run the Hub

```bash
# One-off planning run
npm run plan

# Or interactively via Claude Code
claude /daily-plan
```

## The Hub App

`app/` is the family-facing side: a Cloudflare Worker that serves a wall-tablet/phone
hub page, offline trip apps, live calendars, and a data API that the pipeline publishes to
(the `hub-api` output). Your family runs it from a small private repo that holds only
your config and content and pins a version of this one. See [app/README.md](app/README.md).

```
  cc-family-hub pipeline ──publish──►  your hub (Cloudflare Worker)  ◄── tablet, phones
  (planning, daily)                    app/ code + your family.yaml
```

## Repository Structure

```
cc-family-hub/
├── CLAUDE.md                   # Claude Code project instructions
├── workspace/                  # YOUR family's data (gitignored)
│   ├── family.yaml             # Family config
│   ├── members/                # Member profiles
│   ├── context/                # Notes, links, shopping items, photos
│   ├── calendars/              # Cached calendar data
│   └── state/                  # Runtime state and secrets
├── workspace.example/          # Reference workspace with fake data
├── hub/                        # Core planning engine
│   ├── planner/                # AI planning logic + prompts
│   ├── context/                # Context assembly
│   └── scheduler/              # Scheduling and triggers
├── integrations/
│   ├── _base/                  # Shared types and interfaces
│   ├── inputs/                 # Input integrations
│   │   ├── google-calendar/
│   │   └── apple-reminders/
│   └── outputs/
│       ├── google-calendar/
│       ├── web-portal/
│       └── wall-display/
├── app/                        # The hub app (Cloudflare Worker + pages)
│   ├── worker/                 # createHub(config): calendars, data API, trip APIs
│   ├── public/                 # Hub page and the shared trip-app engine
│   ├── build.mjs               # Validates family.yaml, assembles a family's site
│   ├── template/               # Starting point for your family's hub repo
│   ├── widgets/                # iPhone home/lock screen widgets (Scriptable)
│   └── extras/                 # Optional add-ons (grocery email)
├── docs/                       # Architecture, trip apps, wall tablet
├── scripts/                    # Utility scripts
└── .claude/
    └── commands/               # Custom slash commands
```

## Custom Claude Code Commands

| Command | Description |
|---------|-------------|
| `/daily-plan` | Run the full planning routine |
| `/add-member` | Add a new family member |
| `/add-integration` | Scaffold a new integration |
| `/sync-calendars` | Pull latest calendar data |
| `/context` | Review and manage accumulated context |
| `/weekly-summary` | Generate a human-readable weekly summary |

## Design Principles

- **Pluggable everything** — integrations are self-contained modules with a common interface
- **Workspace separation** — family data never touches the source tree
- **AI-first planning** — Claude assembles rich context and generates plans, not just raw data dumps
- **Per-member granularity** — outputs can be filtered and personalized per family member
- **Incremental** — the hub tracks state between runs so it only re-plans what changed

## Contributing

See [docs/contributing.md](docs/contributing.md). The core interfaces in `integrations/_base/types.ts` are the stable API surface — integrations depend on those, not on each other.

## Privacy

Your family's data stays local. Nothing in `workspace/` is ever committed. API calls go only to services you explicitly configure. Claude Code runs locally against your own Anthropic API key.
