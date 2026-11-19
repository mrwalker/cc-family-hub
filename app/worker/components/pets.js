/**
 * pets: what the pets need soon. One card per vaccination, medication, grooming
 * or vet visit that's overdue or coming up, overdue first. Edited at /household/.
 *
 * No household database, or nothing due: no cards.
 *
 *   data: { task: { id, kind, title, pet, assignee, dueDate, dueTime, daysUntil,
 *                   overdue, repeats, provider, phone } }
 */

import { taskCards } from "./tasks.js";

export const id = "pets";

export const cards = ctx => taskCards(ctx, "pets");
