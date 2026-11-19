# Roadmap

The other docs describe the hub as designed for v1.0. This page lists what they describe
that the current release doesn't do yet. When an item ships, delete it here.

## Where v0.11.1 stands

Everything in the docs works except one leftover from before the stream:

- Every screen reads the stream: the hub page, the iPhone widget, the Mac app and the Roku.
- A family runs everything from its hub repo with the `family-hub` command.

## To build

### 1. Retire the old screen endpoints

Once every installed widget, Mac app and Roku has been updated to read `/api/stream`,
remove `/api/widget`, `/api/widget/trips`, `/api/widget/photos` and `/api/photos`
(`app/worker/widget.js`, and the legacy routes in `trips.js`, `photos.js` and `index.js`),
and the `/api/widget` Access application. That's v1.0.

## Later

Ideas, not commitments:

- More inputs: weather, school and sports calendars by ICS link, a chores list, Todoist.
- More outputs: a morning summary by email or text, an Apple TV screensaver, an e-ink frame.
- A family's own components, loaded from its hub repo the way its own inputs are.
- Photos from Google Photos or a folder, for families that aren't on iCloud.
