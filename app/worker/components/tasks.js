/**
 * Cards for household tasks (worker/household.js), shared by the components that
 * show them. One card per task that's overdue or close enough to its due date,
 * overdue first.
 *
 *   data: { task: { id, kind, title, pet, assignee, dueDate, dueTime, daysUntil,
 *                   overdue, repeats, provider, phone } }
 */

import { AREAS, leadDays } from "../household.js";
import { daysBetween, dateLabel, dayName } from "../util.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Every 3 months", "Every week", or null. */
export function repeatLabel(task) {
  if (!task.repeatEvery || !task.repeatUnit) return null;
  return task.repeatEvery === 1 ? `Every ${task.repeatUnit}` : `Every ${plural(task.repeatEvery, task.repeatUnit)}`;
}

/** "3:30 PM" from "15:30", in the family's locale. */
function clock(time, locale) {
  const [h, m] = time.split(":").map(Number);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(locale || "en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
}

/** A member's view keeps what's assigned to them; adults also see what's unassigned. */
function inView(ctx, task) {
  if (!ctx.view) return true;
  if (task.assignee) return task.assignee === ctx.view.id;
  return ctx.view.role !== "child";
}

function glanceFor(ctx, task, kind, days) {
  const who = task.petName || ctx.hub.members.find(m => m.id === task.assignee)?.name || null;
  const shortDate = dateLabel(task.dueDate, ctx.locale, { month: "short", day: "numeric" });
  const time = task.dueTime ? clock(task.dueTime, ctx.locale) : null;
  let headline, when;
  if (days < 0) {
    headline = kind.appointment ? `${task.title}: done?` : `${task.title} overdue`;
    when = `${kind.appointment ? "Was" : "Due"} ${shortDate} · ${plural(-days, "day")} ago`;
  } else {
    const due = kind.appointment ? "" : "due ";
    headline = days === 0 ? `${task.title} ${due}today`
      : days === 1 ? `${task.title} ${due}tomorrow`
      : `${task.title} ${due}in ${days} days`;
    when = [days > 1 ? dayName(task.dueDate, ctx.today, ctx.locale) : null, time].filter(Boolean).join(" · ");
  }
  return { headline, detail: [who, when].filter(Boolean).join(" · "), emoji: kind.emoji };
}

/** The cards for one area's tasks. No database, or nothing due: no cards. */
export async function taskCards(ctx, area) {
  const tasks = await ctx.household();
  if (!tasks) return [];
  const kinds = AREAS[area].kinds;
  return tasks
    .filter(t => t.area === area && kinds[t.kind] && inView(ctx, t))
    .map(t => ({ task: t, days: daysBetween(ctx.today, t.dueDate) }))
    .filter(({ task, days }) => days <= leadDays(task))
    .map(({ task, days }) => ({
      id: `${area}:${task.id}`,
      title: AREAS[area].label,
      url: `${ctx.hubUrl}household/#${area}`,
      glance: glanceFor(ctx, task, kinds[task.kind], days),
      data: {
        task: {
          id: task.id, kind: task.kind, title: task.title,
          pet: task.petName, assignee: task.assignee,
          dueDate: task.dueDate, dueTime: task.dueTime, daysUntil: days, overdue: days < 0,
          repeats: repeatLabel(task), provider: task.provider, phone: task.phone,
        },
      },
    }));
}
