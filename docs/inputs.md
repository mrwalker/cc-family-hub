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
| [`household`](#household) | The hub's household records | Interactive | `pets` |
| [`escape-rooms`](#escape-rooms-and-movies) | `workspace/escape-rooms.yaml` | Workspace | `escape-rooms` |
| [`movies`](#escape-rooms-and-movies) | `workspace/movies.yaml` | Workspace | `movies` |
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

What it takes to run the house, kept by the hub itself. Today that's the pets: their
vaccinations, medications, grooming and vet visits. Each is a task with a due date. It can
repeat, and it keeps a record of every time it was done.

You add and change them at `/household/` on your hub, on a phone or the hub page. Adults
can change anything. Everyone else can look. A task shows on every screen as a `pets` card
when it's close to due, and stays there, marked overdue, until someone marks it done.

**Set up:** it needs a D1 database and your Access details. See
[getting-started.md](getting-started.md#household-records). Without them this input is
off, and nothing else changes.

## escape-rooms and movies

Plain lists you keep in the workspace: `escape-rooms.yaml` is the rooms you've played and
whether you got out, and `movies.yaml` is what you want to watch. The shapes are shown in
[`workspace.example/`](../workspace.example/).

These are the pattern for a family's own lists. If your family tracks hikes, restaurants,
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
