# Inputs

An input is one source of family data. Turn inputs on in `family.yaml`, or by adding the
workspace file they read. Each input feeds one or more [stream components](stream.md).

| Input | Source | Mode | Feeds |
|-------|--------|------|-------|
| [`google-calendar`](#google-calendar) | Each member's Google calendars | Synced and live | `today`, `week`, `plan` |
| [`icloud-album`](#icloud-album) | An iCloud shared album | Live | `photos` |
| [`trips`](#trips) | `workspace/trips.yaml` | Workspace | `trips`, `past-trips` |
| [`trip-apps`](#trip-apps) | Trip folders in your hub repo, and check-ins | Deploy and interactive | `trips`, `past-trips` |
| [`grocery`](#grocery) | The hub's shared list | Interactive | `grocery` |
| [`household`](#household) | The hub's household records | Interactive | `pets`, `house`, `chores`, `pet-portraits`, `plan` |
| [`escape-rooms`](#escape-rooms-and-movies) | The hub's records (`workspace/escape-rooms.yaml` before v2.7) | Interactive | `escape-rooms` |
| [`movies`](#escape-rooms-and-movies) | The hub's records, picked monthly by your assistant (`workspace/movies.yaml` before v2.8) | Interactive | `movies` |
| [`notes`](#notes) | `workspace/context/` | Workspace | `plan` |
| [`apple-reminders`](#apple-reminders) | Apple Reminders (macOS) | Synced | `plan` |
| [`strava`](#strava) | Strava | Synced | `workouts` |

The modes are explained in [architecture.md](architecture.md#inputs). In short: *synced*
inputs are pulled by the pipeline, *workspace* inputs are files you edit, *live* inputs are
read by the Worker when a screen asks, and *interactive* inputs are changed by people on a screen.

```yaml
# family.yaml
inputs:
  google-calendar: {}
  icloud-album:
    album: "https://photos.icloud.com/shared/album/…"
  apple-reminders: {}
```

Workspace inputs need no entry here. They're on when their file exists.

`family-hub check` lists every input, whether it's on, and what it's missing.

## google-calendar

Reads each member's calendars through a Google service account that you create. Each
person shares their calendar with the service account's email.

- **Set up:** run `npx family-hub setup calendars`. It walks you through creating the
  service account and prints the email to share calendars with. The full guide is in
  [`tools/calendar-setup/README.md`](../tools/calendar-setup/README.md).
- **Calendars** go in each member's profile, `workspace/members/<id>.yaml`, under `calendarIds`.
- **The key** goes in two places, because the brain runs in two places: the JSON key file
  in `HUB_SECRETS_DIR` for the pipeline, and the `SA_CLIENT_EMAIL` and `SA_PRIVATE_KEY`
  Worker secrets for live reads.
- **Shared invites** appear once, with every attending member's color. Events a person
  declined are left out of their day.

## icloud-album

Shows photos from an iCloud shared album. Add a photo on your phone and it joins the stream
within about 15 minutes.

- **Set up:** in Apple Photos, open the shared album's settings and turn on **Public
  Website**. Put the link in `inputs.icloud-album.album`. Both kinds of iCloud link work:
  `https://photos.icloud.com/shared/album/…` and `https://www.icloud.com/sharedalbum/#…`.
- **Keep your hub repo private.** Anyone with the link can view the album. The link stays
  on the server; screens get photos through the hub.
- The Worker reads the album the way icloud.com's own album page does. This isn't a
  documented Apple API, so it may need updating if Apple changes that page.

## trips

`workspace/trips.yaml` lists your trips: upcoming ones, and the ones you've taken.

```yaml
- id: beach-jul-2027
  name: Beach Week
  destination: Outer Banks, NC
  emoji: "🏖️"
  startDate: "2027-07-03"
  endDate: "2027-07-09"
  who: [alex, jordan, sam, riley]
  type: family            # work trips are left out of the stream
  description: A week on the sound side.
  highlights:
    - { emoji: "🪁", label: Kite day, caption: Jockey's Ridge at sunset }
  album: "https://photos.icloud.com/shared/album/…"   # optional: the trip's shared album
```

A trip is upcoming, active, or past according to its dates.

**Trip albums.** Most trips get a shared photo album. Add its link as `album:` once the
trip starts (turn on Public Website for the album, as for the family album). Both kinds
of iCloud link work: `https://photos.icloud.com/shared/album/…` and
`https://www.icloud.com/sharedalbum/#…`. The
trip's card on every screen shows its photos: a new one each minute, and a slideshow on
the hub page's spotlight. After the trip, its past-trip card keeps them. The link stays
on the server, so keep your hub repo private. `family-hub check` makes sure it's an
album link. Upcoming and active trips make
`trips` cards, and past ones make `past-trips` cards. `who` decides whose view a trip appears in.

## trip-apps

A trip app is a folder in your hub repo with the trip's schedule, quests, and packing lists.
Registering it under `hub.tripApps` gives the trip's card a hero photo, a quest leaderboard,
and today's schedule while the trip is on. After the trip, the final standings stay on its
`past-trips` card. See [trip-apps.md](trip-apps.md).

## grocery

One shared list that every screen sees. Add and check off items on the hub page. The
planner adds what it finds in the week ahead (a birthday needs candles) and anything you've
put in `workspace/context/shopping/`. The list is stored by the Worker, so the wall tablet
and your phone agree.

## household

What it takes to run the house, kept by the hub itself:

- **Pets:** vaccinations, medications, teeth cleanings, grooming, vet visits and boarding.
  One task can cover several pets: add it once and tick which ones.
- **The house:** services that come to the house (lawn, cleaning, pest control),
  maintenance on a schedule (filters, gutters, smoke detectors), and fixes. A family with
  more than one house lists its places, and each task says which.
- **Chores:** the kids' jobs (trash, dishes, the dogs), which rotate among them each week,
  and what each job involves and when: every evening at 4:30, Tuesdays, every other week,
  as needed, or when an adult asks.

Pets and the house are tasks, each with a due date. It can repeat, and it keeps a record of every time it was
done. An appointment can be booked, with its own date and time, and a stay has an end
date. A fix can go without a date: it waits on the page, with no card, until it's done.
Booked appointments can also go on a Google Calendar, and edits made there come back.
Each pet can have up to ten photos, added from a phone on `/household/` (several at once); the
`pet-portraits` cards show each pet over one of them.

You add and change them at `/household/` on your hub, on a phone or the hub page. Adults
can change anything. Everyone else can look. A task shows on every screen as a `pets` or
`house` card when it's close to due, and stays there, marked overdue, until someone marks it done.
A chore isn't a task: it comes round on its schedule, is done or missed, and never piles
up. Anyone in the family can tick a chore done, on a phone or the wall tablet, and the hub
keeps who ticked it. The `chores` cards show each kid what's theirs today.
The planner reads them too, so the week's plan can work around a vet visit.

**Set up:** it needs a D1 database and your Access details. See
[getting-started.md](getting-started.md#household-records). Without them this input is
off, and nothing else changes.

## escape-rooms and movies

**Escape rooms** are the rooms you've played: where, when, who, whether you got out and how
fast. Anyone in the family adds one on `/household/` after a game, with the room's link. The
hub finds the room's picture from that link (the page's preview image, or a picture whose
description names the room) and shows it on the hub page and the TVs. A hub that kept
`escape-rooms.yaml` imports it once, from the Escape rooms tab.

**Movies** are what's coming out that's worth seeing: in theaters, with IMAX and 70mm noted,
and the big new movies and shows on streaming services. Once a month your assistant picks
them and hands them to the hub with `npx family-hub movies <file>`; each gets a poster from
its link. Everyone can mark which ones they want to see, and which they've seen, by tapping
their dot on the hub page. `movies.yaml` is no longer read.

Both need the household database (`HUB_DB`).

Before v2.7 these were plain YAML lists in the workspace. They're still the pattern for a family's own lists. If your family tracks hikes, restaurants,
or board games, [add a component](contributing.md#adding-a-component) that reads another YAML file.

## notes

Free-form context for the planner, one YAML file per note in `workspace/context/notes/`:
"Sam's friend Lee is visiting the week of the 12th", "Riley can't have dairy". The planner
reads them when it writes the week's plan. Notes don't appear on screens themselves. The
`/context` command reviews and retires them.

## apple-reminders

Reads incomplete reminders on a Mac and gives them to the planner as to-dos. It only works
when the pipeline runs on macOS. See
[`integrations/inputs/apple-reminders/README.md`](../integrations/inputs/apple-reminders/README.md).

## strava

Reads each member's recent activities. Run `npx family-hub setup strava` to connect
accounts. Strava's API terms and pricing have changed more than once, so check that your
account still has API access before relying on it.

## Adding an input

An input is a small module. See [contributing.md](contributing.md#adding-an-input). You can
also keep an input in your own hub repo, under `integrations/inputs/<id>/`, without
contributing it here.
