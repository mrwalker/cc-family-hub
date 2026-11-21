# Roadmap

What's next for the hub, roughly in order. The other docs describe what's built.

## Next

### Managing the household

So far the hub shows what the family already keeps elsewhere. Next it helps run the house,
which means writing as well as reading:

- **Pets:** vet visits, vaccinations, medications, grooming.
- **Kids:** chores, activities and their schedules.
- **The house:** services (lawn, cleaning, pest control), maintenance (filters, gutters,
  smoke detectors), and routine fixes.

Each is a component, so it shows on every screen as cards ("Rabies shot due in 9 days",
"Dishes: Sam, tonight", "HVAC filter overdue"), and the planner reads it when it plans
the week. What's new is a place to write: small edit views on the hub page and phones, and
storage that suits records several people edit. That's Cloudflare D1 (SQLite) rather than
KV, which suits data that's written rarely and read constantly.

The design is in [architecture.md](architecture.md#household-records). In short:

- **Tasks.** A task is something due on a date that waits until it's done. It may repeat,
  and it keeps a history. A vaccination and a filter change are tasks.
- **Chores are different.** A chore comes round on a schedule (every evening at 4:30, every
  other Tuesday) and doesn't pile up: a feed nobody did on Tuesday is missed, not owed twice
  on Wednesday. Who does it comes from a weekly rotation of jobs among the kids, as on a
  fridge whiteboard. So chores have their own small model, beside tasks.
- **Who can write.** Adults manage everything. Anyone in the family can tick a chore done,
  for anyone, which suits a shared wall tablet: the hub records whose chore it was and who
  ticked it. Guests and screens can't write. The Worker checks the Access sign-in itself
  before any write.
- **Where you write.** One small page, `/household/`, made for phones and safe for the wall
  tablet. Cards on the hub page link to it.
- **Nothing to turn off.** A hub without a D1 database gets no cards and no changes.

Built so far:

- **v2.0.0:** the base (D1, the write API, sign-in checks, the `/household/` page) and **pets**.
- **v2.1.0:** the planner reads household records.
- **v2.2.0:** **the house:** services, maintenance and fixes.
- **v2.3.0:** a family's **places** (more than one house), the same task for **several pets**
  at once, **booking** an appointment, and **stays** such as boarding.
- **v2.4.0:** booked appointments on a family **Google Calendar**, both ways.
- **v2.5.0:** a **photo** for each pet, added on `/household/`, and **pet portraits**: each pet
  full screen over its photo on the hub page, with what's next for it.
- **v2.5.2:** pet portraits full screen on the TV apps (Samsung and Roku) too.
- **v2.6.0:** **chores:** jobs that rotate weekly among the kids, each with its chores on a
  clear schedule, ticked off on `/household/` by anyone in the family and shown on every screen.
- **v2.6.1:** the **chore board** on the hub page: a column per kid, each chore a tile to tap,
  for the wall tablet.
- **v2.7.0:** **escape rooms** kept by the hub: added on `/household/` after a game, each with
  its room's picture, found on its link.
- **v2.8.0:** **movies** picked monthly by the family's assistant, in theaters and streaming,
  with posters; everyone marks what they want to see and what they've seen.
- **v2.9.0:** **trips** kept by the hub: added and changed on `/household/`, each with its map
  found from the destination, so a new trip no longer needs an edit to `trips.yaml`.
- **v2.9.2:** an escape room can name the **trip** it was played on; its tile links to that
  trip's card, and the hub page opens any trip from a `/#trip:<id>` link.
- **v2.10.0:** the hub works as a **phone app**: added to the home screen it opens full
  screen with its own icon and name (`hub.shortTitle`), and its clock fits a phone.
- **v2.10.1:** the home-screen icon is the house the TV apps use, and an album photo that
  iCloud keeps only as a small original (no medium or full JPEG) now shows.
- **v2.11.0:** **house portraits**: each house full screen over its photos (added on
  `/household/` like a pet's), with what's next there. A portrait's tasks carry what the
  task's own card says (booking, time, provider, a stay's end), so a family can show the
  portraits instead of the `pets` and `house` lists. Pet portraits are titled "Dogs".
- **v2.11.1:** a slow iCloud album never holds up the stream: album lists are kept in KV
  and loaded by a cron trigger (add `triggers` to `wrangler.jsonc`, as in the template).
- **v2.12.0:** **the assistant** ([assistant.md](assistant.md)): an agent in the family's
  chat adds to a trip's lists and the grocery list with `family-hub trip …` and
  `grocery …`. Each chat channel is mapped to what it may touch (`hub.agent.channels`),
  every change is logged and can be undone, `trip brief` gives the facts for a briefing,
  and `family-hub doctor` checks the live hub.
- **v2.12.1:** the assistant can say who asked by name when it doesn't have their chat id.
- **v2.13.0:** **the assistant, confirmed changes**: removing from a trip or the grocery
  list, re-dating a trip and archiving a task wait for an adult's yes on `/household/` ›
  Assistant (or from an ops channel), which also shows what the assistant did, with undo.
  Tasks, chores and movie marks from chat, by the household's own rules; channels for the
  pets, one house, or movies. Saving a trip on `/household/` no longer quietly undoes what
  the assistant added since the form was opened.
- **v2.14.0:** **ask the assistant from the hub**: an Ask button on the hub page and an
  Ask panel in every trip app (offline-first), whose questions reach the assistant in the
  family's chat and whose answers come back; notes from the assistant on those panels.
  Bump each trip's `sw.js`.
- **v2.15.0:** the assistant reads the family's **calendar** (`family-hub calendar`): any
  range from a household channel, only a trip's days from its channel. `trip brief`
  includes the trip app's departure note and quick facts.
- **v2.15.1:** a trip's channel sees only the calendar events about the trip, not family
  members' own appointments.
- **v2.15.2:** the trip apps' Ask panel is nearly solid, so it reads over the trip photo.
  Bump each trip's `sw.js`.
- **v2.15.3:** the hub page's pop-ups (a day's details, Ask) are solid in dark mode.

The rest ships in steps:

| Release | What it adds |
|---------|--------------|
| v2.10.0 | **Activities:** completing what the calendar leaves out |

Activities stay in the calendar, where families already put them. But a practice typed in
a hurry is often missing its address, a phone number or a link. The hub keeps what it
knows about each activity, fills those gaps on the Today and Week cards, and asks on a
card when it can't ("Where is Saturday's recital?"). An answer is kept and used again.

Escape rooms and movies were YAML lists published once. They move to the hub's database:
rooms because the family adds one after every game, and movies because a list of what's
coming out goes stale within weeks. A picture for each comes from its link: the Worker
reads the page's preview image (`og:image`), or one whose description names the room.
Movies are refreshed once a month by the family's assistant (the OpenClaw agent on the
pipeline's machine), which picks what's worth seeing in the next couple of months and
hands it to the hub through the pipeline.

### Samsung TVs

The app is in `app/tizen/`. It runs on four Samsung TVs at two sites, and survives
restarts. Still to learn: whether SmartThings routines can open it on a schedule.

## Later

Ideas, not commitments:

- More inputs: weather, school and sports calendars by ICS link, Todoist.
- More outputs: a morning summary by email or text, an Apple TV screensaver, an e-ink frame.
- A family's own components, loaded from its hub repo the way its own inputs are.
- Photos from Google Photos or a folder, for families that aren't on iCloud.
- Trip check-ins in D1 or a Durable Object, so phones on a trip never contend over KV.
