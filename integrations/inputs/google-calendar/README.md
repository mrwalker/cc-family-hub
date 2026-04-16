# Google Calendar — Input Integration

Reads events from each family member's Google Calendar using a service account.

## Setup

See [tools/calendar-setup/README.md](../../../tools/calendar-setup/README.md) for the full setup guide.

**Short version:**
1. Create a Google Cloud project + service account
2. Download the service account JSON key → `workspace/state/google-service-account.json`
3. Run `npm run setup:calendars` — it prints the service account email
4. Each family member shares their Google Calendar with that email ("Make changes to events")
5. Add `calendarIds` to each member's profile in `workspace/members/<id>.yaml`
6. Run `npm run sync`

## No secrets.yaml entry needed

Unlike most integrations, Google Calendar uses a standalone key file rather than an entry in `secrets.yaml`. The file lives at `workspace/state/google-service-account.json` (gitignored along with the rest of `workspace/`).

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

The input integration uses `calendar.readonly`. If you also use the Google Calendar output integration to write enriched notes back, grant "Make changes to events" when sharing (which covers both read and write).
