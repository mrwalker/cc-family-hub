# /weekly-summary

Generate a human-readable weekly summary from the most recent plan.

## Steps

Run:
```bash
npm run summary
```

This reads `workspace/state/last-plan.yaml` and calls Claude to render a friendly, scannable summary of the week — suitable for sharing in a family group chat or displaying on the portal.

## If no plan exists yet

Run `/daily-plan` first to generate the initial plan.

## Options

You can ask for a per-member summary: "show me just Sam's week" — in that case, filter the events and action items to only those assigned to or involving that member.
