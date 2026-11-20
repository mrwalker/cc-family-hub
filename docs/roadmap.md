# Roadmap

What's next for the hub, roughly in order. The other docs describe what's built.

## Next

### Managing the household

So far the hub shows what the family already keeps elsewhere. Next it helps run the house,
which means writing as well as reading:

- **Pets:** vet visits, vaccinations, medications, grooming.
- **Kids:** chores and allowances, activities and their schedules.
- **The house:** services (lawn, cleaning, pest control), maintenance (filters, gutters,
  smoke detectors), and routine fixes.

Each is a component, so it shows on every screen as cards ("Rabies shot due in 9 days",
"Dishes: Sam, tonight", "HVAC filter overdue"), and the planner reads it when it plans
the week. What's new is a place to write: small edit views on the hub page and phones, and
storage that suits records several people edit. That's Cloudflare D1 (SQLite) rather than
KV, which suits data that's written rarely and read constantly.

The design is in [architecture.md](architecture.md#household-records). In short:

- **One kind of record.** A task is something due on a date. It may repeat, and it keeps a
  history. A vaccination, a filter change and a chore are all tasks.
- **Who can write.** Adults manage everything. Kids can mark their own chores done. Guests
  and screens can't write. The Worker checks the Access sign-in itself before any write.
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

The rest ships in steps:

| Release | What it adds |
|---------|--------------|
| v2.5.0 | A photo for each pet, uploaded on `/household/`, and a **pet panel**: each pet full screen over its photo, with what's next for it. Then the same panel on the TV apps. |
| v2.6.0 | **Chores:** assigned to kids, daily and weekly, taking turns |
| v2.7.0 | **Activities:** completing what the calendar leaves out |

Activities stay in the calendar, where families already put them. But a practice typed in
a hurry is often missing its address, a phone number or a link. The hub keeps what it
knows about each activity, fills those gaps on the Today and Week cards, and asks on a
card when it can't ("Where is Saturday's recital?"). An answer is kept and used again.

Allowances come after chores, built on the record of what each kid has done.

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
