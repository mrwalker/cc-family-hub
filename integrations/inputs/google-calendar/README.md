# Google Calendar Input

Reads events from each family member's Google Calendar using a service account. The pipeline
uses it to give the planner a snapshot of the next two weeks. The hub Worker reads the same
calendars live for the screens, with the same service account. See
[docs/inputs.md](../../../docs/inputs.md#google-calendar).

## Setup

See [tools/calendar-setup/README.md](../../../tools/calendar-setup/README.md) for the full setup guide.

**Short version:**
1. Create a Google Cloud project + service account
2. Download the service account JSON key to `google-service-account.json` in your `HUB_SECRETS_DIR`
3. Run `npx family-hub setup calendars`. It prints the service account email.
4. Each family member shares their Google Calendar with that email ("Make changes to events")
5. Add `calendarIds` to each member's profile in `workspace/members/<id>.yaml`
6. Run `npx family-hub sync`

## No secrets.yaml entry needed

Google Calendar uses a standalone key file, not an entry in `secrets.yaml`. The file is
`google-service-account.json` in `HUB_SECRETS_DIR` (or `workspace/state/`, which is gitignored,
if you haven't set one). The Worker needs the same key as its `SA_CLIENT_EMAIL` and
`SA_PRIVATE_KEY` secrets.

## Calendar IDs

Add calendar IDs to each member's profile:

```yaml
# workspace/members/alex.yaml
calendarIds:
  - "primary"                                      # main Google calendar
  - "family@group.calendar.google.com"             # shared family calendar
```

To find a calendar ID: Google Calendar → Settings → click the calendar → "Calendar ID".

## Scopes

The input uses `calendar.readonly`. If you also turn on the
[`google-calendar` output](../../../docs/outputs.md#google-calendar) to write the planner's notes
back, grant "Make changes to events" when sharing. That covers both.
