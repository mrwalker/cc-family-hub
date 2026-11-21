# Workspace

`workspace/` in your hub repo is everything that makes the hub yours. The pipeline reads it
on each run, and the Worker's build reads it at each deploy.

```
workspace/
├── family.yaml            the family, its members, and how the hub is set up
├── members/<id>.yaml      one profile per member
├── trips.yaml             before v2.9: trips (the hub keeps them now)
├── escape-rooms.yaml      optional, before v2.7 (then imported into the hub)
├── movies.yaml            no longer read (v2.8)
├── context/
│   ├── notes/             things the planner should know
│   └── shopping/          things to add to the grocery list
├── calendars/             event snapshots from the last sync   (gitignored)
└── state/                 the last plan, the rendered prompt   (gitignored)
```

Commit everything except `calendars/` and `state/`. The hub repo template's `.gitignore`
already excludes them. [`workspace.example/`](../workspace.example/) is a complete workspace
for a made-up family.

## family.yaml

```yaml
family:
  name: "The Riveras"
  timezone: "America/Los_Angeles"   # every time on every screen is shown in this zone
  locale: "en-US"

# One entry per person, in the order screens list them.
members:
  - id: "alex"                      # lowercase; matches members/alex.yaml
    name: "Alex"
    role: "adult"                   # adult | child | other
    color: "#2563eb"                # their color everywhere
  - id: "sam"
    name: "Samantha"
    shortName: "Sam"                # what screens call them, if different
    role: "child"
    color: "#db2777"

inputs:                             # see inputs.md
  google-calendar: {}
  icloud-album:
    album: "https://photos.icloud.com/shared/album/…"

brain:
  model: "claude-opus-5-5"          # the planner's model
  daysAhead: 14                     # how far the planner looks

stream:                             # see stream.md
  components: [today, photos, trips, plan, grocery, past-trips, escape-rooms, movies]
  dwell: 15

outputs:                            # see outputs.md
  roku:
    stream: { photosBetween: 3, dwell: 10 }
  google-calendar: {}

hub:
  title: "Rivera Family Hub"
  shortTitle: "Rivera Hub"         # optional: the name under its icon on a phone's home screen

  # Lets the hub check who's signed in before anyone changes household records.
  # Both are in Cloudflare Zero Trust; neither is a secret. See getting-started.md.
  access:
    teamDomain: "rivera.cloudflareaccess.com"
    aud: "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2"

  # Optional: the Google Calendar booked household appointments go on, shared with
  # the service account ("Make changes to events"). See getting-started.md.
  householdCalendar: "abc123@group.calendar.google.com"

  # People who join trips but aren't members. An email lets their sign-in pick their
  # player in a trip app. Their calendars are never read.
  guests:
    grandma: { email: "grandma@example.com" }
    cousin-lee: {}

  # Trips that have a phone app. See trip-apps.md.
  tripApps:
    - trip: "beach-jul-2027"        # the trip's id (its edit form on /household/ › Trips shows it)
      path: "/beach/"               # the folder in your hub repo, served at this path
      appId: "beach-2027"           # window.TRIP.id in its trip-data.js
      guests: [grandma]             # who can score besides the family
```

Only `family` and `members` are required. Leave out `stream` for every component in the
default order, and leave out `outputs` for every screen with the default stream.

`family-hub check` validates the whole workspace and reports problems as
`<file>: <path>: <problem>`. The Worker's build runs the same checks, so an inconsistent
workspace can't deploy.

### Older keys

Workspaces written for v0.6 and earlier used `integrations.active` and put the photo album
and grocery email under `hub`. Those still work:

| Older key | Now |
|-----------|-----|
| `integrations.active: [google-calendar, apple-reminders, strava]` | `inputs:` |
| `integrations.active: [hub-api]` | Not needed. The pipeline publishes to your hub whenever `secrets.yaml` has a `hub-api` entry. |
| `hub.photos.icloudAlbum` | `inputs.icloud-album.album` |
| `hub.groceryEmailUrl` | `outputs.grocery-email.url` |
| `integrations.schedule` | Not used. Schedule the pipeline with cron or launchd. |

## members/&lt;id&gt;.yaml

```yaml
id: "sam"
name: "Samantha"
email: "sam@example.com"            # identifies them when they sign in
role: "child"
age: 12
school: { name: "Lincoln Middle", grade: "7" }
hobbies: [soccer, drawing]
primaryFocuses: ["Science fair project"]
calendarIds:
  - "sam@example.com"
  - "abc123@group.calendar.google.com"   # the team calendar
```

`calendarIds` are the calendars that are theirs on the hub. Everything else is context for
the planner: the more it knows about a person's week, the better its notes. The
`/add-member` command creates and updates profiles.

## Content files

The hub keeps trips (since v2.9), escape rooms (v2.7) and movies (v2.8) itself: they're
edited on `/household/`. Before those releases they were `trips.yaml`, `escape-rooms.yaml`
and `movies.yaml`, which the hub imports once and which can then be deleted. Their shapes
are in [inputs.md](inputs.md) and `workspace.example/`. While one is still here, a change to
it reaches the screens on the next pipeline run.

## Secrets

Secrets never go in the workspace. Set `HUB_SECRETS_DIR` in your hub repo's `.env` to a
folder outside every repo:

```bash
mkdir -p ~/.config/family-hub && chmod 700 ~/.config/family-hub
echo 'HUB_SECRETS_DIR=~/.config/family-hub' >> .env
```

| File | Holds |
|------|-------|
| `secrets.yaml` | `hub-api` (your hub's URL, publish token, and the pipeline's Access service token), and any input's credentials |
| `google-service-account.json` | The Google service account key |

Without `HUB_SECRETS_DIR`, they're read from `workspace/state/`, which is gitignored.
`family-hub check` reports any secret an active input or output is missing.

## Where the workspace is

The `family-hub` command uses `./workspace` in the folder you run it from. Set
`HUB_WORKSPACE` (in the environment or `.env`) to point it somewhere else.
