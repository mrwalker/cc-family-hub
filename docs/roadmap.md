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
"Dishes: Oliver, tonight", "HVAC filter overdue"), and the planner reads it when it plans
the week. What's new is a place to write: small edit views on the hub page and phones, and
storage that suits records several people edit. That's Cloudflare D1 (SQLite) rather than
KV, which suits data that's written rarely and read constantly.

### Samsung TVs

The app is in `app/tizen/` and runs on a 2025 Samsung TV. Still to learn: whether it
survives a restart, and whether SmartThings routines can open it on a schedule.

## Later

Ideas, not commitments:

- More inputs: weather, school and sports calendars by ICS link, Todoist.
- More outputs: a morning summary by email or text, an Apple TV screensaver, an e-ink frame.
- A family's own components, loaded from its hub repo the way its own inputs are.
- Photos from Google Photos or a folder, for families that aren't on iCloud.
- Trip check-ins in D1 or a Durable Object, so phones on a trip never contend over KV.
