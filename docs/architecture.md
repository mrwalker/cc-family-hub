# Architecture

A family hub has three parts. **Inputs** bring in what the family already keeps elsewhere.
The **brain** integrates it, has Claude plan the week, and composes one **stream** of cards.
**Outputs** show the stream, or push parts of it somewhere useful.

```
INPUTS                          BRAIN                                 OUTPUTS

synced ─────────► pipeline (scheduled, Node)
  Google Calendar   sync ─► plan (Claude) ─► publish ──┐        ┌──► pushes
  Reminders, Strava                                    │        │      Google Calendar notes
                                                       ▼        │      grocery email
workspace files ─► trips, escape rooms,          hub Worker ────┤
  movies, notes     published by the pipeline   (Cloudflare)    │
                                                 store (KV)     └──► screens (pull the stream)
live ───────────────────────────────────────►    live inputs           wall tablet / browser
  Google Calendar, iCloud album                  stream composer       iPhone widgets
                                                       ▲               Mac menu bar
interactive ───────────────────────────────────────────┘               Roku
  trip check-ins, grocery list                                         trip apps
```

## Two repos

| Repo | Holds | Who has one |
|------|-------|-------------|
| **cc-family-hub** (this one, public) | All code: the pipeline, the Worker, the pages, the screens | Everyone shares it |
| **Your hub repo** (private) | `workspace/`, trip folders, a three-line `worker.js`, `wrangler.jsonc`, `package.json` | One per family |

Your hub repo depends on cc-family-hub, pinned to a release tag. Everything runs from your
repo: the `family-hub` command runs the pipeline against `./workspace`, and `wrangler deploy`
builds the Worker from `createHub(config)`. You only clone cc-family-hub to contribute to it.

## Inputs

An input is one source of family data. Inputs differ in how their data reaches the brain:

| Mode | How it arrives | Examples |
|------|----------------|----------|
| **Synced** | The pipeline pulls it on a schedule | Google Calendar (for planning), Apple Reminders, Strava |
| **Workspace** | You edit a YAML file in your hub repo, and the pipeline publishes it | Trips, escape rooms, movies, notes |
| **Live** | The Worker reads it when a screen asks, and caches it for a few minutes | Google Calendar (for display), the iCloud album |
| **Interactive** | People change it on a screen, and the Worker stores it | Trip check-ins and packing lists, the grocery list, household records |

Google Calendar is both synced and live. The planner needs a snapshot to reason over, and
the screens need events that are current to within five minutes.

Every input is listed in [inputs.md](inputs.md).

## The brain

The brain is the part that's the same for every family. It runs in two places.

### The pipeline

A Node process that runs on a schedule, does its work, and exits. `family-hub run` is:

1. **Sync.** Each synced input writes a snapshot to `workspace/calendars/` or `workspace/state/`.
2. **Plan.** The context builder assembles the family config, member profiles, the next 14
   days of events, notes, and the previous plan. Claude turns that into a `WeeklyPlan`: a
   summary, notes for each day, action items, flags for conflicts, and shopping items.
3. **Publish.** The plan and the workspace content (trips, escape rooms, movies) go to the
   hub Worker as validated `PUT /api/data/:kind` writes. Push outputs run here too.

Claude can do step 2 in two ways:

- `family-hub plan` calls the Claude API directly. It needs an Anthropic API key.
- `family-hub render` writes the full prompt to `workspace/state/pending-prompt.md`. An
  assistant such as Claude Code reads it, writes the plan to `workspace/state/last-plan.yaml`,
  and runs `family-hub publish`. The `/daily-plan` command does all three.

The planner prompt uses prompt caching on the context block, which is large and changes
slowly. The model is set by `brain.model` in `family.yaml`.

Publishing is a data write. It never commits or deploys. The pipeline prints one line per
destination and ends with `PUBLISH OK` or `PUBLISH FAILED`, exiting non-zero on failure.

### The hub Worker

A Cloudflare Worker built from `createHub(config)`. It does four jobs:

- **Stores** what the pipeline publishes in KV. Each kind is validated on the way in, so a
  malformed plan is rejected with `<path>: <problem>` errors and the screens keep the last
  good one. The previous value of each kind is kept for rollback.
- **Reads live inputs:** calendars through a Google service account, and the photo album.
- **Composes the stream.** For each component in the family's stream config, it builds
  cards from stored and live data, filtered for whoever is asking. See [stream.md](stream.md).
- **Serves** the hub page, the trip apps, and the interactive APIs (check-ins, packing,
  grocery, household records).

### Config flow

`family.yaml` reaches each part of the brain a different way:

- **The pipeline** reads the workspace directly on each run.
- **The Worker** gets it at deploy. `family-hub build` (the `wrangler` build command)
  validates the workspace and writes `.generated/hub-config.json`, which `worker.js` imports.
  If the workspace is inconsistent, the build fails with `<file>: <path>: <problem>` lines
  and the live hub stays as it was.
- **Screens** get only what they need from the Worker: names, colors, the timezone, and the
  stream. Email addresses and calendar ids never leave the Worker.

So a change to *content* (a new trip, a movie) needs a pipeline run, and a change to
*config* (a new member, a different stream order) needs a deploy. If your hub repo deploys on
push, both happen without you thinking about it.

## Outputs

| Kind | How it gets data | Examples |
|------|------------------|----------|
| **Screens** | Pull `GET /api/stream` from the Worker and draw the cards | Hub page, iPhone widgets, Mac menu bar, Roku |
| **Apps** | Served by the Worker, with their own interactive APIs | Trip apps |
| **Pushes** | The pipeline writes to another service after planning | Google Calendar notes, grocery email |

Screens hold no logic about what to show. The Worker decides the cards and their order, and
the screen decides only how to draw them at its size. That's what keeps a 1-inch lock-screen
widget and a 55-inch TV showing the same hub.

Every output is listed in [outputs.md](outputs.md).

## Who can reach what

The hub sits behind Cloudflare Access on your own domain. The default `*.workers.dev`
address is turned off, since it would bypass Access.

| Caller | Proves itself with | Can reach |
|--------|--------------------|-----------|
| Family and trip guests | Sign-in (an Access **Allow** policy listing their emails) | Everything: the hub page, trip apps, the stream, interactive APIs |
| Screens (widget, Mac, Roku) | An Access **service token**, one per device | `GET /api/stream` and its images. Nothing else. |
| The pipeline | An Access service token, plus the `PUBLISH_TOKEN` bearer | `PUT /api/data/:kind` |

Each device has its own token, so you can revoke a lost phone without touching the others.
Secrets live in three places, none of them a repo:

| Secret | Lives in |
|--------|----------|
| Google service account key, publish token, pipeline service token | `secrets.yaml` and `google-service-account.json` in `HUB_SECRETS_DIR` |
| `SA_CLIENT_EMAIL`, `SA_PRIVATE_KEY`, `API_TOKEN`, `PUBLISH_TOKEN` | Worker secrets (`wrangler secret put`) |
| Each screen's service token | That device's keychain, or `roku.env` outside the repo |

## State

| Where | What |
|-------|------|
| `workspace/calendars/` | Event snapshots from the last sync (gitignored) |
| `workspace/state/last-plan.yaml` | The most recent plan (gitignored) |
| `workspace/state/pending-prompt.md` | The rendered prompt, for the assistant route (gitignored) |
| KV `HUB_DATA` | Published data, one key per kind, plus `:prev`. The grocery list. |
| KV `TRIP_KV` | Trip check-ins and packing lists |
| D1 `HUB_DB` | Household records (optional) |

Nothing else is stateful. You can rebuild the Worker and re-run the pipeline at any time.

## Household records

*Pets are built. The house, chores, and the planner's feed are planned;
[roadmap.md](roadmap.md#managing-the-household) has the order.*

Household records are the hub's own data: the pets' care, the kids' chores, the upkeep of
the house. They're an interactive input, like the grocery list, with three differences.
Several people edit them, they keep a history, and who may change what depends on who's
signed in.

### Storage

Records live in Cloudflare D1, bound as `HUB_DB`. The binding is optional. Without it there
are no household cards, the page says it isn't set up, and nothing else changes.

| Table | Holds |
|-------|-------|
| `pets` | Each pet: name, species, birthday, notes |
| `tasks` | Anything due on a date: its area (`pets`, `house`, `kids`), kind, title, who or which pet it's for, when it's next due, how it repeats, how early its card appears, and a provider, phone number and link |
| `task_log` | One row each time a task is done: when, by whom, and the due date it replaced |

A task repeats in one of two ways. A filter is due three months after you change it, so
its next date counts from the day it was done. A monthly medication is due on the 1st
whenever you gave the last one, so its next date counts from the day it was due.

Marking a repeating task done adds a log row and moves its due date. A one-off is
archived. Undo removes the row and restores the date. Nothing is deleted, only archived.

The Worker applies its own migrations. The first time it uses the database after a
release, it runs any that are new, in one transaction. You create the database once and
never run a migration by hand.

### Reading and writing

| Method | Path | Who | Does |
|--------|------|-----|------|
| GET | `/api/household` | Family | Everything the page needs, and who's asking |
| POST | `/api/household/pets` | Adults | Add or change a pet |
| POST | `/api/household/tasks` | Adults | Add or change a task |
| POST | `/api/household/tasks/:id/done` | Adults, and a kid for their own chore | Mark it done |
| POST | `/api/household/tasks/:id/undo` | The same | Take back the last time it was done |
| POST | `/api/household/tasks/:id/archive` | Adults | Archive or restore it |
| GET | `/api/household/export` | The pipeline | What's due, overdue and lately done *(planned)* |

Every write is validated in the Worker and answers with the fresh list.

### Who may write

Access decides who reaches the hub. For household writes the Worker also checks the
sign-in itself: it verifies the token Access attaches to each request (its signature,
audience and expiry), finds the member with that email, and reads their role.

| Caller | May |
|--------|-----|
| Adults | Add, change, complete and archive anything |
| Kids | Mark their own chores done, and undo that |
| Trip guests | Read |
| Screens | Read the stream. Their tokens carry no identity. |
| The pipeline | Read the export |

To verify a token the Worker needs your Access team domain and the hub application's
audience tag, set as `hub.access` in `family.yaml`. Neither is a secret. Until they're set,
the Worker refuses household writes and says why. Who made each change is taken from the
sign-in, never from the request.

### Where you write

`/household/` is one small page with a tab for each area. It's made for a phone and works
on the wall tablet. Each task can be marked done, edited, and shows its history. Adults
can add and archive. Kids see their own chores.

The other screens don't write. A widget, the Mac app and the TVs show the cards, and the
hub page links each one to `/household/`.

### Cards and the planner

Each area is a component: `pets` today, then `house` and `chores`. A task becomes a card when it's
overdue or close enough to its due date, with overdue tasks first. A member's view shows
what's assigned to them. With nothing due, a component adds no cards.

The stream reads the database once per request, with one indexed query.

Planned: the pipeline fetches `/api/household/export` when it builds the planner's
context, so the plan can work around a vet visit or remind someone of a chore. If the
fetch fails, the plan is made without it.

## Scheduling

The pipeline has no scheduler of its own. Use whatever the machine has: cron, launchd, or a
scheduled assistant session. It runs one of:

- `family-hub run`, which syncs, plans through the Claude API, and publishes.
- An assistant running `/daily-plan`, which does the same with the assistant as the planner.

Screens refresh themselves. The hub page reloads the stream as it rotates, widgets refresh
when iOS lets them, and the Mac app and Roku refresh every five minutes.
