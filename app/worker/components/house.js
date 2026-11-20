/**
 * house: what the house needs soon. One card per service visit, maintenance job
 * or fix that's overdue or coming up, overdue first. Edited at /household/.
 * A fix with no date has no card; it waits on the household page.
 *
 * No household database, or nothing due: no cards.
 *
 *   data: { task: { id, kind, title, pet, assignee, dueDate, dueTime, daysUntil,
 *                   overdue, repeats, provider, phone } }
 */

import { taskCards } from "./tasks.js";

export const id = "house";

export const cards = ctx => taskCards(ctx, "house");
