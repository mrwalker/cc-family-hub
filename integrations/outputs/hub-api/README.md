# Publishing to the Hub

How the pipeline hands its results to your hub Worker. It publishes the week's plan, your
workspace content (trips, escape rooms, movies), and Strava activities. The Worker validates
each one before storing it, so a malformed plan is rejected with the exact field that's wrong
and never reaches a screen. Publishing is a data write: no git commit, no deploy.

```
family-hub publish
  └─ PUT <url>/api/data/plan     ─┐
  └─ PUT <url>/api/data/family    ├─► the Worker validates, then stores in KV
  └─ PUT <url>/api/data/strava   ─┘        └─► stream components read it
```

The Worker keeps each kind's previous value, so a bad publish can be rolled back by hand.

## Setup

1. On the Worker, set a publish token:
   ```bash
   openssl rand -hex 32 | npx wrangler secret put PUBLISH_TOKEN
   ```
2. Add the same token to your `secrets.yaml` (in `HUB_SECRETS_DIR`):
   ```yaml
   hub-api:
     url: "https://hub.example.com"
     publishToken: "<same value>"
   ```
3. If the hub is behind **Cloudflare Access**, create a service token
   (Zero Trust → Access → Service credentials → Service Tokens), then add a
   policy to the hub's Access application with the action **Service Auth** that
   includes that token. Add its credentials:
   ```yaml
     accessClientId: "<id>.access"
     accessClientSecret: "<secret>"
   ```

The pipeline publishes to your hub whenever `secrets.yaml` has this `hub-api` entry.

## Errors

`family-hub publish` prints one line per destination and ends with `PUBLISH OK` or
`PUBLISH FAILED`, exiting non-zero on failure.

| Error | Meaning |
|-------|---------|
| `plan rejected (400): plan failed validation` + a list | The plan has the listed field problems. Fix them in the plan file. |
| `rejected (401)` | `publishToken` doesn't match the Worker's `PUBLISH_TOKEN`. |
| `was redirected (302 → …cloudflareaccess.com…)` | Access saw no service token. Check that `accessClientId` and `accessClientSecret` are set. |
| `blocked by Cloudflare Access (403)` | Access rejected the token. Re-copy both values, and check that the application has a **Service Auth** policy that includes the token. |
| `could not reach …` | A network or URL problem. |

To see what's published and when, open `GET /api/data/plan` (or `family`, `strava`) while
signed in. It shows `publishedAt`.
