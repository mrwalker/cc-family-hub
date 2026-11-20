# Claude Code Family Hub

A toolkit for building your family's hub. It gathers what your family already keeps in
different places (calendars, a shared photo album, trip plans, the grocery list), has Claude
make sense of the week, and shows the result as one rotating stream on every screen you own:
a wall tablet, phones, the Mac menu bar, and the TV.

```
  INPUTS                        BRAIN                          OUTPUTS
  ──────                        ─────                          ───────
  Google Calendar   ──┐                                  ┌──  Wall tablet / browser
  iCloud album      ──┤    integrate   what's there      ├──  iPhone widgets
  Trips + trip apps ──┤    process     Claude plans      ├──  Mac menu bar
  Grocery list      ──┼──► format      one card format ──┼──► Roku channel + screensaver
  Escape rooms      ──┤    control     what shows where  ├──  Trip apps (phones, offline)
  Movies, notes     ──┤                                  ├──  Google Calendar notes
  Reminders, Strava ──┘         THE STREAM               └──  Grocery email
```


## The stream

Every output shows the same thing: a rotating stream of **cards**. Each card comes from a
**component**, and each component is fed by one or more inputs.

| Component | A card shows | Fed by |
|-----------|--------------|--------|
| `today` | The rest of today and tomorrow, in each person's color | Google Calendar |
| `week` | The days ahead | Google Calendar |
| `plan` | Claude's read on the week: summary, conflicts, things to do | The planner |
| `pets` | What a pet needs soon: a shot, a pill, grooming, a vet visit | Household records, kept on the hub |
| `house` | What the house needs soon: a service visit, a filter, a fix | Household records, kept on the hub |
| `photos` | A photo from the family album | iCloud shared album |
| `trips` | An upcoming trip: countdown, hero photo, quest leaderboard, today's schedule | `trips.yaml`, trip apps |
| `past-trips` | A trip you took: highlights and final standings | `trips.yaml`, trip apps |
| `grocery` | The shopping list | The hub's shared list, the planner |
| `escape-rooms` | Your escape record and rooms you've played | `escape-rooms.yaml` |
| `movies` | What you want to watch next | `movies.yaml` |
| `workouts` | Recent activities | Strava |

You choose which components are in the stream, in what order, and how long each card stays
up. Any output can override that for itself. A component with nothing to show is skipped.

Every card carries a small summary that any screen can draw (a headline, a line of detail,
maybe a photo), so **every output can show every component**. Bigger screens draw the
components they know in full: the wall tablet shows the whole grocery list where a lock-screen
widget shows "8 items · milk, eggs, …". See [docs/stream.md](docs/stream.md).

## How it's put together

You don't work inside this repo. You keep a small private repo of your own, your **hub
repo**, and it installs cc-family-hub as a dependency:

```
your hub repo (private)                      cc-family-hub (this repo, a dependency)
───────────────────────                      ───────────────────────────────────────
workspace/        your family's config  ──►  the pipeline    sync, plan, publish
  family.yaml       and content         ──►  the hub app     the Worker and its pages
  members/, trips.yaml, …                    the screens     widget, Mac app, Roku channel
<trip>/           each trip app's content
worker.js         three lines: createHub(config)
package.json      pins a cc-family-hub version
```

Your repo holds no app code. To upgrade, bump the version. The brain runs in two places:

- **The pipeline** runs on a schedule on any machine with Node (a laptop, a home server).
  It syncs inputs, has Claude write the week's plan, and publishes the results to your hub.
- **The hub Worker** runs on Cloudflare. It stores what the pipeline publishes, reads live
  inputs (calendars, the photo album, trip check-ins), composes the stream, and serves
  every screen.

See [docs/architecture.md](docs/architecture.md).

## Get started

You need Node 20+, a Cloudflare account with a domain, and a Google account for calendars.
[Claude Code](https://claude.com/claude-code) is optional: it can act as the planner, so you
don't need an Anthropic API key.

```bash
npx github:mrwalker/cc-family-hub init my-family-hub   # scaffold your hub repo
cd my-family-hub && npm install
npx family-hub check                                   # what's configured, what's missing
```

Then follow [docs/getting-started.md](docs/getting-started.md): describe your family, connect
calendars, deploy the hub, schedule the pipeline, and add screens.

## Docs

| Doc | What's in it |
|-----|--------------|
| [Getting started](docs/getting-started.md) | From nothing to a hub on the wall |
| [Architecture](docs/architecture.md) | Inputs, brain, outputs; what runs where; who can reach what |
| [The stream](docs/stream.md) | Components, cards, the stream API, rotation rules |
| [Inputs](docs/inputs.md) | Every input and how to turn it on |
| [Outputs](docs/outputs.md) | Every output and what it shows |
| [Workspace](docs/workspace.md) | `family.yaml` and the rest of your workspace, field by field |
| [Trip apps](docs/trip-apps.md) | Offline trip companions with quests and a leaderboard |
| [Wall tablet](docs/wall-tablet.md) | Kiosk setup and the Google sign-in fix |
| [Contributing](docs/contributing.md) | Add an input, a component, or an output |
| [Repository structure](docs/structure.md) | Where things live in this repo |
| [Roadmap](docs/roadmap.md) | What's next |

## Design principles

- **One stream, every screen.** A component is built once and appears on every output.
  No screen has its own private data path.
- **Your data lives in your repo.** This repo is public and holds no family data. Yours
  holds no app code.
- **Configure, don't fork.** Inputs, the stream, and outputs are all set in `family.yaml`.
- **Claude plans, the hub checks.** The planner writes the week's plan, and the hub validates
  it before any screen can show it.
- **Nothing breaks the wall.** A bad config fails the build and leaves the live hub as it
  was. A bad plan is rejected with the exact field that's wrong. A screen that's offline
  shows what it last had.

## Privacy

- Your family's config and content live in your private hub repo. Secrets stay outside
  every repo.
- Published data and trip check-ins are stored in your own Cloudflare account. The hub sits
  behind Cloudflare Access, so only the people you list can open it. Each screen gets its own
  revocable key that can read the stream and nothing else.
- The planner sends your family context (profiles, upcoming events, notes) to Claude, through
  your own Anthropic API key or your own Claude Code session.
- Calendars are read by a Google service account that you create and that each person
  shares their calendar with.
