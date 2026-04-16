# /sync-calendars

Pull the latest calendar events from all active input integrations.

## Steps

Run the sync command:
```bash
npm run sync
```

This will:
1. Load `workspace/family.yaml` to find active integrations
2. For each input integration that implements `fetchEvents()`, pull events for the next 30 days
3. Write the results to `workspace/calendars/<integration-id>.yaml`

## After syncing

Calendar data is now ready for the planner. Run `/daily-plan` to generate a fresh plan using the updated events.

## Troubleshooting

**No events returned from Google Calendar** — check that `calendarIds` are set in the member profiles and that the OAuth token is valid. Run `npm run check-secrets`.

**Auth errors** — re-run the auth setup script for the affected integration. See the integration's README for instructions.
