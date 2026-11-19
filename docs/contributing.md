# Contributing

The hub grows in three directions: a new **input**, a new **component** in the stream, or a
new **output**. Each is a small, separate piece. Read [architecture.md](architecture.md) first.

Two rules apply to everything:

- **This repo is public and holds no family data.** No names, emails, calendar ids, tokens,
  or URLs, in code, tests, or examples. Everything family-specific comes from a workspace.
  Use the made-up Rivera family from `workspace.example/`.
- **Nothing breaks the wall.** Validate at the edge and fail with a message that names the
  field. A screen must keep showing its last good data when anything upstream goes wrong.

## Setting up

```bash
git clone https://github.com/mrwalker/cc-family-hub && cd cc-family-hub
npm install
npm run typecheck
```

To try a change against a real hub, point that hub repo's dependency at your checkout
(`"cc-family-hub": "file:../cc-family-hub"`), run `npm install` there, and then `npm run dev`.

## Adding an input

Decide how its data arrives. See the modes in [architecture.md](architecture.md#inputs).

**A synced input** is a module the pipeline calls. Create `integrations/inputs/<id>/index.ts`:

```typescript
import { BaseIntegration } from "../../_base/BaseIntegration.js";
import type { InputIntegration, CalendarEvent } from "../../_base/types.js";

export default class MyServiceInput extends BaseIntegration implements InputIntegration {
  readonly id = "my-service";
  readonly displayName = "My Service";

  /** Throw with a message that says what to fix. `family-hub check` prints it. */
  async healthCheck(): Promise<void> {
    const secrets = this.loadSecrets();
    this.requireSecretKeys(secrets, ["apiKey"]);
  }

  async fetchEvents(startDate: string, endDate: string): Promise<CalendarEvent[]> {
    return [];
  }
}
```

It can implement `fetchEvents` (things with a time) or `fetchContextItems` (to-dos, notes,
links, shopping items). Add a `README.md` beside it with setup steps and the keys it needs in
`secrets.yaml`, and add those keys to `workspace.example/state/secrets.example.yaml`.

**A workspace input** is a YAML file. Read it in `hub/published-data.ts`, and validate its
shape in `app/worker/data-api.js`, so a typo is rejected at publish with the field named.

**A live input** is read by the Worker. Put it in `app/worker/`, cache it, and return an
error the component can turn into "skip this card". Never let it fail the whole stream.

Then list it in [inputs.md](inputs.md). If it feeds something new, add a component.

**A family's own input or push** can live in its hub repo instead, at
`integrations/inputs/<id>/index.ts` or `integrations/outputs/<id>/index.ts`. The pipeline
looks there first. Import the base class and types from the package:

```typescript
import { BaseIntegration } from "cc-family-hub/integrations/_base/BaseIntegration.js";
import type { InputIntegration, CalendarEvent } from "cc-family-hub/integrations/_base/types.js";
```

Turn it on under `inputs:` or `outputs:` in `family.yaml` like any other.

## Adding a component

A component turns data into cards. Create `app/worker/components/<id>.js`:

```js
/** Board games: what we've been playing. Fed by workspace/board-games.yaml. */
export const id = "board-games";

export async function cards(ctx) {
  const games = (await ctx.data("family"))?.boardGames ?? [];
  if (!games.length) return [];                    // nothing to show: no cards
  const g = games[0];
  return [{
    id: `board-games:${g.id}`,
    title: "Board games",
    url: `${ctx.hubUrl}#board-games`,
    glance: { headline: g.name, detail: `Last played ${ctx.dayLabel(g.lastPlayed)}`, emoji: "🎲" },
    data: { game: g },
  }];
}
```

- **Fill in `glance` properly.** It's all that most screens will draw. The headline is the
  one thing to read from across the room, and the detail is one line.
- **Respect the view.** `ctx.view` is a member or `null` for the family. Filter what's
  theirs.
- **Return no cards** when there's nothing to show. Don't return a card that says "nothing here".
- **Format on the server.** Use `ctx`'s date helpers, so every screen shows the family's
  timezone and locale.

Register it in `app/worker/stream.js`, and add it to the tables in [stream.md](stream.md).
It now appears on every screen. Give it a full view on the hub page, and on other screens
when the glance isn't enough.

## Adding an output

**A screen** is a client of `GET /api/stream`. It needs to:

1. Hold a hub URL and an Access service token, somewhere safe on the device.
2. Fetch the stream with `?view=` and `?output=<its id>`.
3. Draw any card from `title` and `glance`. This is the minimum, and it's what makes a new
   component appear on the screen without a change to it.
4. Rotate by `dwell`, in the order given. Don't reorder or filter. That's the brain's job,
   and it's configured in `family.yaml`.
5. Keep the last stream, and show it when the hub can't be reached, marked as stale.
6. Draw the components it cares about in full from `data`.

Put it in `app/<name>/` with a README that follows the others: what it shows, its key,
install, troubleshooting, developing. List it in [outputs.md](outputs.md).

**A push** is a module the pipeline calls after planning. Create
`integrations/outputs/<id>/index.ts` implementing `OutputIntegration` (`publishPlan`,
`publishEvents`, `publishShoppingList`, or `sendNotification`). Throw on failure. The
pipeline reports each output on its own line and carries on with the others.

## The hub page and trip apps

- Plain HTML, CSS, and JS, with no build step.
- They must run on an old Android WebView (Chrome 80 to 86). No CSS `inset`, no flexbox
  `gap`. Use grid with `gap`, or margins.
- A change to `app/public/trip-app/` reaches phones only after a family bumps its trips'
  `sw.js` versions. Say so in the release notes.
- Never change a `localStorage` key or a check-in id format without a migration. Phones
  hold check-ins that haven't synced yet.

## Changing shared types and config

`integrations/_base/types.ts`, the `family.yaml` schema, and the card envelope are what
families and screens depend on.

- Add fields as optional.
- Keep accepting an old config key when you rename one, and list it in
  [workspace.md](workspace.md#older-keys).
- Never remove or repurpose a field in the card envelope or `glance`. Installed widgets and
  TV channels update slowly.
- Update `workspace.example/` in the same change.

## Testing

- `npm run typecheck` for the pipeline.
- `npm test` for the stream composer and the validators.
- For the app, run a real hub repo against your checkout, with `npm run dev`.
- For screens, each README has a way to check layout without the device: the Mac app's
  `FAMILY_HUB_SNAPSHOT`, the Roku's `--screenshot`, and Scriptable's in-app preview.

## Releasing

Tag `vX.Y.Z` on `main`. Hub repos pin the tag. In the release notes, say whether a hub needs
to do anything beyond bumping the tag: a new secret, a new Access application, a trip
`sw.js` bump.
