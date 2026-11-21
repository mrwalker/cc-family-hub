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
workspace files ─► notes, published by          hub Worker ────┤
                    the pipeline                (Cloudflare)    │
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
| **Workspace** | You edit a YAML file in your hub repo, and the pipeline publishes it | Notes; trips, escape rooms and movies before the hub kept them |
| **Live** | The Worker reads it when a screen asks, and caches it for a few minutes | Google Calendar (for display), the iCloud album |
| **Interactive** | People change it on a screen, and the Worker stores it | Trip check-ins and packing lists, the grocery list, household records, trips, escape rooms |

Google Calendar is both synced and live. The planner needs a snapshot to reason over, and
the screens need events that are current to within five minutes.

Every input is listed in [inputs.md](inputs.md).

## The brain

The brain is the part that's the same for every family. It runs in two places.

### The pipeline

A Node process that runs on a schedule, does its work, and exits. `family-hub run` is:

1. **Sync.** Each synced input writes a snapshot to `workspace/calendars/` or `workspace/state/`.
2. **Plan.** The context builder assembles the family config, member profiles, the next 14
   days of events, notes, household records from the hub, and the previous plan. Claude turns that into a `WeeklyPlan`: a
   summary, notes for each day, action items, flags for conflicts, and shopping items.
3. **Publish.** The plan and any workspace lists still in YAML (trips, escape rooms, movies) go to the
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

*Pets, the house, the planner's feed, the calendar and chores are built. Activities are next;
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
| `places` | Each house a family keeps: name, address, notes |
| `tasks` | Anything due on a date: its area (`pets`, `house`, `kids`), kind, title, which pet or place it's for and whose job it is, when it's next due, how it repeats, how early its card appears, its booking (date, time, and for a stay its last day), its group, and a provider, phone number and link |
| `task_log` | One row each time a task is done: when, by whom, what the task was before, and the action it was part of |
| `pet_photos` | Photos of the pets, already shrunk by the page (at most 1 MB each, ten a pet) |
| `calendar_events` | For each event the hub made on the household calendar: its id and what the hub last wrote |
| `chore_jobs` | The jobs that rotate among the kids (Trash, Dogs, Dishes, Yard), in order |
| `chores` | What each job (or a named person) does, and when: its schedule, time, season, and for a chore done on request, when it was asked for |
| `chore_log` | One row each time a chore is ticked: the day or week it was for, whose chore it was, who ticked it, and the action it was part of |
| `chore_swaps` | One-week changes to the rotation ("Riley takes the trash this week") |
| `escape_rooms` | The rooms the family has played: where, when, who, the result, the room's link and its picture's address, and the trip it was played on |
| `movies`, `movie_marks` | Movies and shows worth seeing, most picked monthly by the assistant, and who wants to see or has seen each |
| `trips` | The family's trips: where, when, who, the album, a description, the map's area, and the lists a trip shows (highlights, things to do, restaurants, tips) |

A task repeats in one of two ways. A filter is due three months after you change it, so
its next date counts from the day it was done. A monthly medication is due on the 1st
whenever you gave the last one, so its next date counts from the day it was due.

Marking a repeating task done adds a log row and moves its due date, and uses up its
booking: next time's isn't booked yet. A one-off is archived. Undo removes the row and puts
the task back as it was. Nothing is deleted, only archived.

**Several pets.** The same thing for several pets (a monthly pill for all four dogs) is a
task for each, sharing a group. Each pet keeps its own dates and history, so one can be
done early. While they fall on the same day they share a card, and can be done, booked or
undone together. Done for the group means the group's tasks on that day.

**Booking.** A vet visit, a vaccination, a cleaning, grooming or a stay has an appointment
to book. Until it's booked, its card shows when it's due and "not booked yet". Once booked,
the appointment's date and time are what the card shows. A stay, such as boarding, runs
from its first day to its last, and its card shows until the pets are home.

**Places.** A family with more than one house lists them, and each house task says which.

**On a calendar.** With `hub.householdCalendar` set, the Worker keeps a Google Calendar
in step with the records, through the same service account that reads the family's
calendars. After every change it writes an event for each booked appointment, each stay
and each service visit (one event for several pets on the same day), and deletes the ones
it no longer wants. Every few minutes it reads back the events it made: one moved in
Google Calendar moves the booking, and one deleted there leaves the appointment not
booked. Its events are marked as the hub's, and `calendar_events` remembers what it last
wrote, so it can tell an edit made in Google Calendar from its own. A calendar that can't
be reached never stops a save; the page says what went wrong.

**Chores.** A chore isn't a task. A task waits until it's done; a chore comes round on a
schedule, and a time it wasn't done is missed rather than owed. Each chore belongs to a job,
or to named people:

- **Jobs rotate.** The rotation (kept in `household_meta`) lists the kids in order and a
  starting week, when the first kid holds the first job, the second the second, and so on.
  Each week, on the day the family's week starts, everyone moves one job along. A swap
  changes one job's holder for one week. A chore shared by two jobs (picking up the yard
  together) belongs to both holders.
- **Schedules.** A chore is one of:
  - **daily**, on every day or some days, at or by a time if it has one;
  - **weekly**, on a set day (bins to the curb on Tuesday) or any day that week;
  - **every few weeks**, counted from a starting week (the recycling goes out every other
    Tuesday);
  - **as needed**, always listed and never missed, and each tick counted;
  - **when asked**, shown from the day an adult asks for it until it's done.
  
  A chore can also have a season (watering, June to September) and shows only in it.
- **No pile-up.** Whether a chore is done is worked out from its schedule and the log:
  done, still to do, or missed. Nothing is written when a chore is missed, so the log stays
  a plain record of what was done and what was missed.

**Pictures from links.** A room or a movie has a link to its page. When the link is saved,
the Worker reads that page for a picture: one whose description or file name names the
room, then the page's preview image (`og:image`, `twitter:image`), then a large one. It
keeps the picture's address and serves the picture through the hub, cached for a week, so
the TVs can show it with their own token. Only public pictures from those pages pass
through; a picture can also be set by hand.

The Worker applies its own migrations. The first time it uses the database after a
release, it runs any that are new, in one transaction. You create the database once and
never run a migration by hand.

### Reading and writing

| Method | Path | Who | Does |
|--------|------|-----|------|
| GET | `/api/household` | Family | Everything the page needs, and who's asking |
| POST | `/api/household/pets` | Adults | Add or change a pet |
| POST | `/api/household/tasks` | Adults | Add or change a task, or several at once |
| POST | `/api/household/tasks/:id/done` | Adults | Mark it done |
| POST | `/api/household/tasks/:id/undo` | Adults | Take back the last time it was done |
| POST | `/api/household/places` | Adults | Add or change a place |
| POST | `/api/household/undo` | Adults; anyone in the family for a chore they ticked | Take back one action, such as a group's done or a chore's tick |
| POST | `/api/household/tasks/:id/archive` | Adults | Archive or restore it |
| GET | `/api/household/chores?day=` | Family | The jobs, chores, rotation and swaps, who holds each job that week, and each kid's chores for the day |
| POST | `/api/household/chores` | Adults | Add or change a chore, or several at once |
| POST | `/api/household/chores/jobs` | Adults | Add, change or reorder the jobs |
| POST | `/api/household/chores/rotation` | Adults | Set who's in the rotation, its starting week and direction |
| POST | `/api/household/chores/swap` | Adults | Change one job's holder for one week, or put it back |
| POST | `/api/household/chores/:id/ask` | Adults | Ask for a chore done on request, by a day |
| POST | `/api/household/chores/:id/done` | Family | Tick a chore for a day, for whoever's chore it is |
| POST | `/api/household/chores/:id/archive` | Adults | Archive or restore a chore |
| GET | `/api/household/rooms` | Family | The escape rooms |
| POST | `/api/household/rooms` | Family | Add or change a room; finds its picture when the link changes |
| POST | `/api/household/rooms/:id/image` | Family | Find the room's picture again, or use a given one |
| POST | `/api/household/rooms/import` | Adults | Once: copy the published `escape-rooms.yaml` list into the database |
| GET | `/api/household/movies` | Family | The movies and everyone's marks |
| POST | `/api/household/movies/:id/mark` | Family | Mark that someone wants to see it, or has seen it (or neither) |
| POST | `/api/household/movies` | Adults | Add or change a movie by hand |
| POST | `/api/household/movies/picks` | The pipeline (`PUBLISH_TOKEN`) | The month's picks from the assistant |
| GET | `/api/household/movies/history` | The pipeline (`PUBLISH_TOKEN`) | Past picks and marks, so the next picks suit the family |
| GET | `/api/household/trips` | Family | The trips (only adults see album links) |
| POST | `/api/household/trips` | Adults | Add (`isNew: true`) or change a trip; looks up its map when the destination changes |
| POST | `/api/household/trips/:id/archive` | Adults | Archive or restore a trip |
| POST | `/api/household/trips/import` | Adults | Once: copy the published `trips.yaml` list into the database |
| GET | `/api/household/image/:kind/:id` | Family | A room's or movie's picture, fetched from its site once and cached |
| GET | `/api/household/export` | The pipeline (`PUBLISH_TOKEN`) | What's due, overdue and lately done, by name |

Every write is validated in the Worker and answers with the fresh list. A write has to be
a JSON request, which a form on another website can't send.

A family's assistant has its own routes under `/api/agent`, with its own token
(`AGENT_TOKEN`): it reads trips and the grocery list and makes one small, logged change at
a time, within what its chat channel is mapped to. [assistant.md](assistant.md) has the
routes and the rules.

### Who may write

Access decides who reaches the hub. For household writes the Worker also checks the
sign-in itself: it verifies the token Access attaches to each request (its signature,
audience and expiry), finds the member with that email, and reads their role.

| Caller | May |
|--------|-----|
| Adults | Add, change, complete and archive anything |
| Kids | Tick any chore done, for anyone, and undo their own ticks that day |
| Trip guests | Read |
| Screens | Read the stream. Their tokens carry no identity. |
| The pipeline | Read the export, with its publish token |

To verify a token the Worker needs your Access team domain and the hub application's
audience tag, set as `hub.access` in `family.yaml`. Neither is a secret. Until they're set,
the Worker refuses household writes and says why. Who made each change is taken from the
sign-in, never from the request.

Chores are the exception that lets anyone tick. A wall tablet is signed in once, as one
person, and the whole family uses it, so the hub can't know which kid is tapping. It works
like the whiteboard it replaces: anyone in the family may tick any chore. The log keeps
whose chore it was and which sign-in ticked it, and adults can undo any tick.

### Where you write

`/household/` is one small page with a tab for each area. It's made for a phone and works
on the wall tablet. Each task can be marked done, edited, and shows its history. Adults
can add and archive. The Chores tab shows each kid's chores for today with a Done button,
the week's rotation, and for adults, the setup. A kid signed in on their own phone sees
their own chores first.

The hub page has a chore board too, so chores can be ticked on the wall tablet: a column per
kid, each of today's chores a tile. Tap one to tick it; tap a done one to take it back.

The other screens don't write. A widget, the Mac app and the TVs show the cards, and the
hub page links each one to `/household/`.

### Cards and the planner

Each area is a component: `pets`, `house` and `chores`. A task becomes a card when it's
overdue or close enough to its due date, with overdue tasks first. A member's view shows
what's assigned to them. With nothing due, a component adds no cards.

`chores` adds one card for the family ("Chores today: 5 of 9 done", with who's next), and
one for each kid in their own view, listing their chores for the day. A chore with a time
moves to the top of its card a couple of hours before it, and reads "late" after it. On
the first day of the week, a card shows the new rotation.

The stream reads the database once per request, with one indexed query.

The pipeline fetches `/api/household/export` when it builds the planner's context, with
the same hub address, publish token and service token it publishes with. It gets every
pet, each task that's overdue or due within the planner's `brain.daysAhead` (at most 60
days), what was done in the last 30 days, and the chores: who holds which job this week,
each kid's chores today, and what was missed this week. The plan can then fit a vet visit around the
calendar or say who could take it. If the fetch fails, the pipeline prints why and makes
the plan without it.

## Scheduling

The pipeline has no scheduler of its own. Use whatever the machine has: cron, launchd, or a
scheduled assistant session. It runs one of:

- `family-hub run`, which syncs, plans through the Claude API, and publishes.
- An assistant running `/daily-plan`, which does the same with the assistant as the planner.

Once a month, an assistant with web search can also pick the movies:

1. `family-hub movies history` prints what was picked before, and who wanted or saw each.
2. The assistant writes the month's picks: in theaters and on streaming, about two months
   ahead, each with a page link, and a poster link when it has one. The file's shape is at
   the top of `hub/movies.ts`.
3. `family-hub movies publish <file>` checks the file and hands it to the hub. Its last line
   is `MOVIES OK` or `MOVIES FAILED`.

Screens refresh themselves. The hub page reloads the stream as it rotates, widgets refresh
when iOS lets them, and the Mac app and Roku refresh every five minutes.
