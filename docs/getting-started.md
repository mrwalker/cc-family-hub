# Getting Started

This takes you from nothing to a hub on the wall. Do the steps in order. The hub is useful
after step 5, and everything after that adds to it.

**You need:**

- Node.js 20 or later, and Git
- A Cloudflare account with a domain on it (the free plan is enough)
- A Google account, to create the service account that reads calendars
- Optional: [Claude Code](https://claude.com/claude-code), which can act as the planner. Without
  it you need an Anthropic API key.

## 1. Create your hub repo

```bash
npx github:mrwalker/cc-family-hub init my-family-hub
cd my-family-hub
npm install
git init && git add -A && git commit -m "Our family hub"
```

Push it to a **private** repo. You now have:

| Path | What |
|------|------|
| `workspace/` | Your family's config and content, starting as a copy of the example family |
| `worker.js`, `wrangler.jsonc` | Your hub Worker: three lines of code, and its Cloudflare settings |
| `package.json` | Pins the cc-family-hub version |
| `CLAUDE.md`, `.claude/commands/` | So Claude Code knows its way around your hub: `/daily-plan`, `/add-member`, `/add-trip` |
| `.env.example` | Copy to `.env` and set `HUB_SECRETS_DIR` |

## 2. Describe your family

Edit `workspace/family.yaml`: the family name, the timezone, and one entry per member with
a color. Then give each member a profile. In Claude Code:

```
/add-member
```

or copy and edit a file in `workspace/members/`. See [workspace.md](workspace.md) for every field.

```bash
npx family-hub check
```

`check` tells you what's valid, what's on, and what's missing. Run it after any step here.

## 3. Connect calendars

```bash
npx family-hub setup calendars
```

This walks you through creating a Google service account and prints its email address.
Each person shares their calendar with that address, and you list their calendar ids in
their member profile. Then:

```bash
npx family-hub sync     # should report events for each member
```

## 4. Deploy the hub

1. **Set your domain** in `wrangler.jsonc` (`name`, and the `routes` pattern).
2. **Create the storage** and put the ids in `wrangler.jsonc`:
   ```bash
   npx wrangler kv namespace create HUB_DATA
   npx wrangler kv namespace create TRIP_KV
   ```
3. **Set the Worker's secrets:**
   ```bash
   npx wrangler secret put SA_CLIENT_EMAIL     # the service account's email
   npx wrangler secret put SA_PRIVATE_KEY      # its private key (PEM)
   openssl rand -hex 32 | npx wrangler secret put API_TOKEN
   openssl rand -hex 32 | npx wrangler secret put PUBLISH_TOKEN
   ```
   Put the same `PUBLISH_TOKEN` value in `secrets.yaml` under `hub-api`, with your hub's URL.
4. **Put it behind Cloudflare Access** (Zero Trust → Access → Applications → Self-hosted,
   your hub's domain):
   - An **Allow** policy listing your family's emails. Use a 30-day session, so a wall
     tablet stays signed in.
   - A **Service Auth** policy with a service token for the pipeline. Put the token's id and
     secret in `secrets.yaml` under `hub-api`.
5. **Deploy:**
   ```bash
   npm run deploy
   ```
   Or connect the repo to Cloudflare Workers Builds, so every push to `main` deploys.

### Household records

Optional. To keep the pets' care on the hub (see [inputs.md](inputs.md#household)):

1. **Create the database** and add it to `wrangler.jsonc`:
   ```bash
   npx wrangler d1 create my-family-hub
   ```
   ```jsonc
   "d1_databases": [
     { "binding": "HUB_DB", "database_name": "my-family-hub", "database_id": "<id>" }
   ]
   ```
   The hub sets up its own tables, and updates them when you upgrade.
2. **Tell the hub how to check a sign-in.** In `family.yaml`:
   ```yaml
   hub:
     access:
       teamDomain: "<team>.cloudflareaccess.com"   # Zero Trust → Settings: your team domain
       aud: "<tag>"                                # your hub's Access application: its Application Audience (AUD) tag
   ```
   Until this is set, everyone can look at household records and nobody can change them.
3. **Mark the kids.** Members with `role: "child"` in `family.yaml` can't change records.
   Everyone else in the family can.
4. Deploy, then open `/household/` on your hub.

To try it with `npm run dev`, where there's no Access, add `DEV_MEMBER=<a member's id>` to
`.dev.vars`. A deployed hub ignores it.

Open your hub's address and sign in. You'll see today's calendar, live. `npm run dev` runs
the hub locally.

## 5. Run the brain

```bash
npx family-hub run
```

This syncs, has Claude plan the week, and publishes to your hub. It ends with `PUBLISH OK`.
Reload the hub and the plan is in the stream.

To use Claude Code as the planner instead of an API key, open your hub repo in Claude Code
and run `/daily-plan`.

Then schedule it. On a Mac or Linux machine that's on in the morning:

```
0 6 * * *  cd ~/my-family-hub && git pull -q && npx family-hub run >> ~/family-hub.log 2>&1
```

## 6. Add more inputs

Each of these adds a component to the stream. Details are in [inputs.md](inputs.md).

| To get | Do |
|--------|-----|
| Photos | Turn on Public Website for an iCloud shared album, and set `inputs.icloud-album.album` |
| Trips | Add your trips to `workspace/trips.yaml` |
| A trip app | Copy a trip folder and register it. See [trip-apps.md](trip-apps.md). |
| Escape rooms, movies | Edit `workspace/escape-rooms.yaml` and `workspace/movies.yaml` |
| Grocery list | Nothing. It's on the hub page. |

Changing `family.yaml` needs a deploy, and changing content files needs a pipeline run. With
deploy-on-push and a daily schedule, committing is all you do.

## 7. Add more screens

| Screen | Guide |
|--------|-------|
| Wall tablet | [wall-tablet.md](wall-tablet.md) |
| iPhone widgets | [app/widgets/README.md](../app/widgets/README.md) |
| Mac menu bar | [app/macos/README.md](../app/macos/README.md) |
| Roku | [app/roku/README.md](../app/roku/README.md) |

Phones, Macs, and Rokus each need their own key first. See
[Giving a screen its key](outputs.md#giving-a-screen-its-key).

## 8. Shape the stream

By default the stream is every component that has something to show. To choose and order
them, or give one screen a different mix, add a `stream:` section. See
[stream.md](stream.md#configuring-the-stream).

## Upgrading

Change the cc-family-hub tag in `package.json`, run `npm install`, and deploy. Release notes
say when a version needs anything more. If a release changes the trip-app engine, also bump
the `version` in each trip's `sw.js`, so phones fetch the new one.

## When something's wrong

| Symptom | Look at |
|---------|---------|
| The deploy fails with `<file>: <path>: <problem>` | The workspace is inconsistent. The message names the field. The live hub is unchanged. |
| `PUBLISH FAILED` | The lines above it. [hub-api's README](../integrations/outputs/hub-api/README.md#errors) explains each error. |
| The calendar is empty | `/api/events` in the browser's Network tab. A 401 is a token mismatch, and a 502 is a service-account or sharing problem. |
| A screen says the hub didn't accept its token | [Giving a screen its key](outputs.md#giving-a-screen-its-key) |
| The hub shows old data | `GET /api/data/plan` shows `publishedAt`. Check the pipeline's log. |
