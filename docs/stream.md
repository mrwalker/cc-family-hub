# The Stream

The stream is what the brain hands to every output: an ordered list of **cards** to rotate
through. Each card comes from a **component**. A screen asks for the stream, draws the cards
one after another, and asks again.

```
GET /api/stream?view=family

  today ─► photo ─► trip: Beach Week ─► plan ─► grocery ─► photo ─► trip: Ski Cabin ─► …
```

## Components

| Component | Cards | A card shows | Fed by |
|-----------|-------|--------------|--------|
| `today` | 1 | The rest of today and all of tomorrow | Google Calendar, plan flags |
| `week` | 1 | The next several days | Google Calendar |
| `plan` | 1 | The week's summary, flags, and action items | The planner |
| `pets` | 1 per task that's due soon or overdue | What a pet needs and when: a shot, a pill, grooming, a vet visit | Household records |
| `house` | 1 per task that's due soon or overdue | What the house needs and when: a service visit, maintenance, a fix | Household records |
| `chores` | 1 for the family, 1 for a kid in their view, and 1 for the new rotation on the week's first day | Whose chores are done today, and what's next; a kid's own chores; who has which job this week | Household records |
| `pet-portraits` | 1 per pet | The pet over its photo, with its age and what's next for it | Household records |
| `photos` | 1 per photo | A photo from the family album | iCloud album |
| `trips` | 1 per upcoming or active trip | Countdown (or "Day 2 of 5"), hero photo, leaderboard, today's schedule | `trips.yaml`, trip apps |
| `past-trips` | 1 per past trip | Where and when, highlights, final standings | `trips.yaml`, trip apps |
| `grocery` | 1 | The shopping list | The shared list, the planner |
| `escape-rooms` | 1 | Your record, and one room you've played | `escape-rooms.yaml` |
| `movies` | 1 per movie you want to watch | Title, release date, format, who's going | `movies.yaml` |
| `workouts` | 1 | Recent activities for each person | Strava |

A component whose inputs aren't set up, or that has nothing to show right now, adds no cards.
A family with no trips has no trip cards, and nothing needs configuring to make that so.

## Configuring the stream

In `family.yaml`:

```yaml
stream:
  # Which components, in rotation order. Leave this out for every component, in the order above.
  components: [today, photos, trips, plan, grocery, past-trips, escape-rooms, movies]
  dwell: 15             # seconds each card stays up, or per component:
                        #   dwell: { default: 15, today: 60, photos: 10 }
  photosBetween: 0      # also show this many album photos between every other card
  max:                  # most cards one component adds per pass (default 3)
    movies: 1
    past-trips: 1
```

Any screen output can override any of this for itself:

```yaml
outputs:
  roku:
    stream:
      components: [today, trips, past-trips, grocery]
      photosBetween: 3  # a screensaver: mostly photos, with a hub card between each three
      dwell: 10
  phone-widget:
    stream:
      components: [today, photos, trips]
```

## Rotation rules

The Worker applies these when it composes a stream, so every output behaves the same way:

1. **Order** is the order of `components`. A component with several cards adds them
   together, in its place.
2. **Empty components are skipped.**
3. **A trip that's on leads.** While a trip is active, its card moves to the front and
   carries today's schedule.
4. **Urgent things ride on `today`.** `urgent` flags from the plan appear on the `today`
   card, so they're seen even on a screen that shows only one card.
5. **Long components take turns.** When a component has more cards than its `max`, each
   pass includes the next few, so every past trip and every movie gets its turn through the day.
6. **A member's view is theirs.** `?view=<member id>` keeps that person's events (shared
   invites included), the trips they're on, and the action items assigned to them.
   `?view=family` keeps everything.
7. **Photos fill the gaps.** With `photosBetween: N`, N shuffled album photos follow each
   non-photo card, and the `photos` component doesn't also take a place of its own.

Settings layer in this order: the family's `stream`, then the screen's built-in defaults
(the Roku's and Samsung TVs' are `photosBetween: 3` and `dwell: 10`), then `outputs.<id>.stream`.

## The stream API

```
GET /api/stream?view=family|<member id>&output=<output id>
```

`output` selects that output's overrides. Without it, you get the family's default stream.

Two more parameters are for screens that let someone choose:

- `components=today,trips` narrows the stream to those components, in that order.
- `all=1` returns every card, without taking turns and without photos between, for a
  screen's full view of a component.

```json
{
  "title": "Rivera Family Hub",
  "view": null,
  "members": [{ "id": "alex", "name": "Alex", "color": "#2563eb" }],
  "hubUrl": "https://hub.example.com/",
  "generatedAt": "2027-06-21T15:04:00Z",
  "cards": [
    {
      "id": "today",
      "component": "today",
      "title": "Today",
      "dwell": 15,
      "url": "https://hub.example.com/#today",
      "glance": {
        "headline": "Soccer practice",
        "detail": "3:20 PM · in 25 min",
        "colors": ["#db2777"]
      },
      "data": {
        "events": [
          { "title": "Soccer practice", "day": "Today", "time": "3:20 PM",
            "startAt": "2027-06-21T15:20:00-07:00", "endAt": "2027-06-21T16:30:00-07:00",
            "allDay": false, "location": "Field 4", "members": ["sam"], "colors": ["#db2777"] }
        ],
        "moreEvents": 0,
        "flags": []
      }
    },
    {
      "id": "trips:beach-2027",
      "component": "trips",
      "title": "Beach Week",
      "dwell": 15,
      "url": "https://hub.example.com/beach/",
      "glance": {
        "headline": "12 days",
        "detail": "Beach Week · Jul 3–9",
        "emoji": "🏖️",
        "image": "https://hub.example.com/api/stream/image/trips:beach-2027"
      },
      "data": { "status": "upcoming", "daysUntil": 12, "days": 7, "leaderboard": [], "today": [] }
    }
  ]
}
```

Everything is already formatted in the family's timezone and locale, so a screen only has
to lay it out.

If a component fails (the album can't be reached, say), its cards are left out and the
response carries `"errors": [{ "component": "photos", "error": "…" }]`. The rest of the
stream is unaffected.

### The card contract

Every card has the same envelope:

| Field | What |
|-------|------|
| `id` | Stable across refreshes, so a screen can remember where it was |
| `component` | Which component made it |
| `title` | A short label for the card |
| `dwell` | Seconds to stay up |
| `url` | Where a tap should go: the hub page at that component, or a trip app |
| `glance` | A summary any screen can draw (below) |
| `data` | The component's full payload, for screens that draw it natively |

And every card has a `glance`:

| Field | What |
|-------|------|
| `headline` | The one thing to read: "12 days", "Soccer practice", "8 items" |
| `detail` | One supporting line |
| `image` | Optional. A photo that can fill the card. |
| `emoji` | Optional. A single emoji that stands for the card. |
| `colors` | Optional. Member colors that belong on the card. |

**The rule that keeps every output level:** a screen must be able to show any card from its
envelope and `glance` alone. It may draw a component in full from `data` when it knows that
component. So a new component reaches every screen on the day it's added, and screens learn
to draw it more richly over time.

### What's in `data`

| Component | `data` |
|-----------|--------|
| `today` | `events[]`, `moreEvents`, `flags[]` |
| `week` | `days[]`, each with `date`, `label`, `events[]` |
| `plan` | `weekStarting`, `summary`, `flags[]`, `actionItems[]` |
| `photos` | `photo`: `id`, `width`, `height`, `takenAt` |
| `trips` | `trip`, `name`, `destination`, `resort`, `start`, `end`, `dates`, `status`, `daysUntil`, `day`, `days`, `countdown`, `who[]`, `leaderboard[]`, `questsDone`, `questsTotal`, `today[]`, `album` |
| `past-trips` | `trip`, `name`, `destination`, `start`, `end`, `dates`, `who[]`, `highlights[]`, `leaderboard[]`, `album` |
| `pets`, `house` | `task`: `id`, `kind`, `title`, `pet`, `pets[]`, `place`, `assignee`, `dueDate`, `dueTime`, `date`, `daysUntil`, `overdue`, `booked`, `apptDate`, `apptTime`, `endDate`, `needsBooking`, `repeats`, `provider`, `phone` |
| `chores` | `type` (`day` or `week`), `day`, `week`, `jobs[]` each with `id`, `name`, `emoji`, `member`; `people[]`, each with `id`, `name`, `color`, `jobs[]`, and `chores[]`, each with `id`, `title`, `job`, `cadence`, `time`, `timeKind`, `status` (`todo`, `late`, `done`, `missed`), `doneAt`, `count` |
| `pet-portraits` | `pet`: `id`, `name`, `species`, `age`. `photo`: `url`, `width`, `height`, or `null`. `next[]`, each with `title`, `kind`, `emoji`, `when`, `date`, `overdue` |
| `grocery` | `items[]`, each with `id`, `name`, `quantity`, `store`, `addedBy`, `done` |
| `escape-rooms` | `record`: `escaped`, `total`. `room`: `id`, `venue`, `room`, `city`, `date`, `solved`, `escapeTime`, `who[]`, `url`, `image` (the room's picture, or `null`) |
| `movies` | `movie`: `id`, `title`, `kind` (`movie` or `show`), `releaseDate`, `where` (`theaters` or a streaming service), `format`, `blurb`, `url`, `image` (its poster, or `null`), `want[]`, `seen[]`, `who[]` (the same as `want[]`) |
| `workouts` | `members[]`, each with `id` and `activities[]` |

A trip with its own shared album has `album: { count, photos: [image URL…] }` (up to 12,
shuffled each minute), and its `glance.image` is one of them. Without one, `album` is
`null` and the image is the trip app's hero photo, if any.

The exact shapes are documented at the top of each component's file in
`app/worker/components/`.

### Images

Card images are served under the stream, so a screen's key covers them:

```
GET /api/stream/image/<card id>
```

Photos come back as JPEGs about 1536 px on the long side. The album link and the trip
folders stay on the server.

## How screens rotate

| Output | Rotation |
|--------|----------|
| Hub page | One card at a time, full screen, for its `dwell`. Tap to stop and use the full view. It resumes after two idle minutes. |
| Roku | One card at a time with crossfades. Left and right change the view. |
| Mac menu bar | The menu bar text steps through card headlines. The panel rotates the cards. |
| iPhone widget | One card per refresh. iOS decides when that is, usually every 15 to 30 minutes. |
| Lock-screen widget | Always the `today` card. |

A screen that's offline keeps rotating the last stream it got, and says so.
