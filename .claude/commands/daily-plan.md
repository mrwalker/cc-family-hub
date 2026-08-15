# /daily-plan

Run the full Family Hub planning routine with the assistant acting as the planner (no Anthropic API key required).

## What this does

1. Syncs the latest calendar data (`npm run sync`)
2. Renders the daily-plan prompt with full family context to `workspace/state/pending-prompt.md` (`npm run render`)
3. The assistant reads the rendered prompt and generates the weekly plan JSON
4. The plan is saved to `workspace/state/last-plan.yaml`
5. The plan is validated and pushed to all active output integrations (`npm run publish`)

## Steps

1. **Sync** the latest calendar data:
   ```bash
   npm run sync
   ```

2. **Render** the planning prompt:
   ```bash
   npm run render
   ```
   This writes the complete prompt (template + family context) to `workspace/state/pending-prompt.md`.

3. **Assistant generates the plan** — read `workspace/state/pending-prompt.md`, then produce the weekly plan as a JSON object matching the output format described in that prompt. Write the result to `workspace/state/last-plan.yaml`. The YAML must include at minimum:
   - `weekStarting` — ISO date of the Monday of this week
   - `summary` — 2–3 sentence narrative
   - `days` — array with `date`, `notes`, `logistics`
   - `actionItems` — array with `description`, `assignedTo?`, `dueDate?`, `priority` (`high`/`medium`/`low`)
   - `flags` — array with `severity` (`info`/`warning`/`urgent`), `message`, optional related IDs
   - `shoppingList` — array of `name`, `quantity?`, `store?`, `addedBy?`

   If you cannot resolve a scheduling conflict or the context is insufficient, record it as an `urgent` or `warning` flag rather than guessing.

4. **Publish** the plan to output integrations:
   ```bash
   npm run publish
   ```
   This validates the plan against the Zod schema, assigns action-item IDs and statuses, and pushes to the web portal / GitHub Pages / Google Calendar.

5. Review the printed summary for any urgent flags. If there are warnings or conflicts, address them in the relevant member profiles or context notes, then re-run.

## After the plan runs

- Check `workspace/state/last-plan.yaml` for the full structured output
- The web portal at `outputs/web-portal/` will have updated data files
- High-priority action items with due dates were added to Google Calendar (if that output integration is active)

## Troubleshooting

**"workspace/family.yaml not found"** — run `npm run setup` first.

**"No events found"** — run `npm run sync` to pull calendar data before planning.

**"workspace/state/last-plan.yaml not found"** on publish — the assistant must write the plan file after `npm run render` and before `npm run publish`.

**Plan fails validation** — `npm run publish` reports the exact Zod errors. Fix the plan's structure in `last-plan.yaml` (missing fields, wrong priority/severity values, etc.) and re-run.

**Integration errors** — run `npm run check-secrets` to verify all credentials are configured.