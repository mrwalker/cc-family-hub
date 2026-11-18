# Hub API Output Integration

Publishes the weekly plan, family data (trips, escape rooms, movies), and Strava
activities to a hub Worker's data API. Every payload is validated by the Worker
before it's stored, so a malformed plan is rejected with field-level errors and
never reaches the display. Publishing is a data write: no git commit, no deploy.

```
npm run publish
  └─ PUT <url>/api/data/plan     ─┐
  └─ PUT <url>/api/data/family    ├─► Worker validates → KV
  └─ PUT <url>/api/data/strava   ─┘
                                       page loads <script src="/api/data.js">
```

## Setup

1. On the Worker, set a publish token:
   ```bash
   openssl rand -hex 32 | wrangler secret put PUBLISH_TOKEN
   ```
2. Add the same token to your `secrets.yaml` (`workspace/state/`, or `HUB_SECRETS_DIR`):
   ```yaml
   hub-api:
     url: "https://hub.example.com"
     publishToken: "<same value>"
   ```
3. If the hub is behind **Cloudflare Access**, create a service token
   (Zero Trust → Access → Service credentials → Service Tokens), then add a
   policy to the hub's Access application with action **Service Auth** that
   includes that token. Add its credentials:
   ```yaml
     accessClientId: "<id>.access"
     accessClientSecret: "<secret>"
   ```
4. Add `hub-api` to `integrations.active` in `workspace/family.yaml`.

## Errors

`npm run publish` prints one line per output and ends with `PUBLISH OK` or
`PUBLISH FAILED`, exiting non-zero on failure. Typical hub-api errors:

| Error | Meaning |
|-------|---------|
| `plan rejected (400): plan failed validation` + a list | The plan has the listed field problems. Fix them in the plan file. |
| `rejected (401)` | `publishToken` doesn't match the Worker's `PUBLISH_TOKEN`. |
| `was redirected (302 → …cloudflareaccess.com…)` | Access saw no service token. Check `accessClientId`/`accessClientSecret` are set. |
| `blocked by Cloudflare Access (403)` | Access rejected the token. Re-copy both values, and check the app has a **Service Auth** policy that includes the token. |
| `could not reach …` | Network or URL problem. |
