# /daily-plan

Run the full Family Hub planning routine.

## What this does

1. Loads all family context from `workspace/` (members, calendars, notes, todos, shopping items)
2. Calls the AI planner to generate an enriched weekly plan for the next 7–14 days
3. Saves the plan to `workspace/state/last-plan.yaml`
4. Pushes the plan to all active output integrations (web portal, wall display, etc.)
5. Prints a summary of flags and action items

## Steps

First, sync the latest calendar data:
```bash
npm run sync
```

Then run the planner:
```bash
npm run plan
```

Review the output for any urgent flags. If there are warnings or conflicts, address them in the relevant member profiles or context notes, then re-run.

## After the plan runs

- Check `workspace/state/last-plan.yaml` for the full structured output
- The web portal at `outputs/web-portal/` will have updated data files
- High-priority action items with due dates were added to Google Calendar (if that output integration is active)

## Troubleshooting

**"workspace/family.yaml not found"** — run `npm run setup` first.

**"No events found"** — run `npm run sync` to pull calendar data before planning.

**Integration errors** — run `npm run check-secrets` to verify all credentials are configured.
