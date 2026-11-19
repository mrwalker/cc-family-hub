# /daily-plan

Plan the family's week with you, the assistant, as the planner, and publish it to the hub.
No Anthropic API key is needed.

## Steps

1. **Sync** the latest calendars and other synced inputs:
   ```bash
   npx family-hub sync
   ```
   A ✗ line means one input failed. Carry on with what synced, and mention it at the end.

2. **Render** the planning prompt:
   ```bash
   npx family-hub render
   ```
   This writes the whole prompt (instructions and the family's context) to `workspace/state/pending-prompt.md`.

3. **Write the plan.** Read `workspace/state/pending-prompt.md` and write the weekly plan it
   asks for, as one JSON object, to `workspace/state/last-plan.yaml`. It must have:
   - `weekStarting`: the Monday of this week, `YYYY-MM-DD`
   - `summary`: two or three sentences
   - `days`: `date`, `notes`, `logistics`
   - `actionItems`: `description`, `priority` (`high`/`medium`/`low`), optional `assignedTo` (a member id) and `dueDate`
   - `flags`: `severity` (`info`/`warning`/`urgent`), `message`, optional `relatedMemberIds`
   - `shoppingList`: `name`, optional `quantity`, `store`

   If a conflict can't be resolved or the context is thin, say so in a `warning` or `urgent`
   flag rather than guessing. Urgent flags show on every screen's Today card.

4. **Publish:**
   ```bash
   npx family-hub publish
   ```
   It validates the plan and sends it to the hub. It ends with `PUBLISH OK` or
   `PUBLISH FAILED`. On a validation error, fix exactly the fields it names in
   `last-plan.yaml` and publish again. On any other failure, report the error; don't edit code.

5. **Report** the summary, any urgent flags, and anything that failed.

The plan's shopping items join the hub's shared grocery list (once each).
