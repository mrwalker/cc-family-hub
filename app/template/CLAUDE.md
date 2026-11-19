# Our Family Hub

This is our family's hub repo, built with [cc-family-hub](https://github.com/mrwalker/cc-family-hub).
It holds our config and content. All the code comes from the cc-family-hub version pinned in
`package.json`. Its docs are in `node_modules/cc-family-hub/docs/`: start with
`architecture.md` and `stream.md`.

## What's here

| Path | What |
|------|------|
| `workspace/family.yaml` | The family, members and their colors, inputs, the stream, outputs, trip apps |
| `workspace/members/<id>.yaml` | One profile per person: calendars, email, school or work, interests |
| `workspace/trips.yaml`, `escape-rooms.yaml`, `movies.yaml` | Content lists |
| `workspace/context/notes/` | Things the planner should know |
| `workspace/state/`, `workspace/calendars/` | Runtime state. Gitignored. |
| `<trip>/` | A trip app's content, if we have any |
| `worker.js`, `wrangler.jsonc` | The hub Worker: `createHub(config)`, and its Cloudflare settings |

## Commands

```bash
npx family-hub check     # validate everything; run after any change to workspace/
npx family-hub run       # sync, plan through the Claude API, publish
npx family-hub sync      # pull calendars and other synced inputs
npm run dev              # the hub locally
npm run deploy           # deploy (or push to main, if Workers Builds deploys on push)
```

Slash commands: `/daily-plan`, `/add-member`, `/add-trip`, `/context`, `/weekly-summary`.

## Rules

- **No secrets in this repo.** Tokens and keys go in `secrets.yaml` and
  `google-service-account.json` in `HUB_SECRETS_DIR` (set in `.env`), and in Worker secrets.
  This repo still holds personal data, so keep it private.
- **Config needs a deploy; content needs a publish.** A change to `family.yaml`, a member, or
  a trip folder reaches the hub when the Worker deploys. A change to `trips.yaml`,
  `movies.yaml`, `escape-rooms.yaml` or the notes reaches it on the next pipeline run.
- **Ids are forever.** Don't rename a member id, trip id, or a trip app's `appId`, quest
  ids or packing ids once in use: other things refer to them.
- **Trip apps:** after changing a trip folder, or upgrading cc-family-hub past a release that
  touches the trip-app engine, bump the `version` in that trip's `sw.js`. Never change a
  trip's `storagePrefix`.
- **Upgrading:** change the cc-family-hub tag in `package.json`, `npm install`, then
  `npx family-hub check` before deploying.
