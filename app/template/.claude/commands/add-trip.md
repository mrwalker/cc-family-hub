# /add-trip

Add a trip to `workspace/trips.yaml`, or update one.

Ask for anything you can't infer: the name, where, the dates, who's going, and an emoji.
Then add an entry like the others in `workspace/trips.yaml`:

- `id`: kebab-case and unique, e.g. `beach-jul-2027`. Never change an existing trip's id: trip apps refer to it.
- `startDate`, `endDate`: `YYYY-MM-DD`
- `who`: member ids from `workspace/family.yaml`
- `type`: `family` (shown everywhere) or `work` (left out of the stream)
- optional: `destination`, `emoji`, `description`, `highlights` (`emoji`, `label`, `caption`)
- optional: `album`, the trip's iCloud shared album link (Public Website on). Add it as soon
  as the trip's album exists: the trip's card on every screen then shows its photos.

Run `npx family-hub check`. The trip reaches the hub on the next pipeline run, or right
away with `npx family-hub publish` if a plan has been written.

For a trip app (quests, a leaderboard, packing lists), see cc-family-hub's docs/trip-apps.md.
