/**
 * Cards for household tasks (worker/household.js), shared by the components that
 * show them. One card per task that's overdue or close enough to its date,
 * overdue first. Tasks of one group (the same thing for several pets) that fall
 * on the same day share a card.
 *
 *   data: { task: { id, kind, title, pet, pets[], place, assignee, dueDate, dueTime,
 *                   date, daysUntil, overdue, booked, apptDate, apptTime, endDate,
 *                   needsBooking, repeats, provider, phone } }
 *
 * `pet` is the pets' names joined ("Pepper & Mochi"), kept for screens that read it.
 * `date` is the day that matters: the appointment once it's booked, else when it's due.
 */

import { AREAS, leadDays, kindOf, whenOf } from "../household.js";
import { daysBetween, dateLabel, dayName, dateRange } from "../util.js";

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

/** "Pepper", "Pepper & Mochi", "Pepper, Mochi & Waffles", or "4 dogs". */
export function petNames(tasks) {
  const names = tasks.map(t => t.petName).filter(Boolean);
  if (names.length <= 3) return names.length < 2 ? names[0] ?? null : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
  const species = new Set(tasks.map(t => String(t.petSpecies || "").toLowerCase()));
  const one = species.size === 1 ? [...species][0] : "";
  return `${names.length} ${one ? `${one}s` : "pets"}`;
}

/** A member's view keeps what's assigned to them; adults also see what's unassigned. */
function inView(ctx, task) {
  if (!ctx.view) return true;
  if (task.assignee) return task.assignee === ctx.view.id;
  return ctx.view.role !== "child";
}

/** Tasks that share a group and a day (and a booking), as one entry; others alone. */
function bundle(tasks) {
  const out = [];
  const byKey = {};
  for (const t of tasks) {
    const key = t.groupId ? [t.groupId, whenOf(t), t.booked, t.apptTime ?? "", t.endDate ?? ""].join("|") : null;
    if (key && byKey[key]) { byKey[key].tasks.push(t); continue; }
    const entry = { task: t, tasks: [t] };
    if (key) byKey[key] = entry;
    out.push(entry);
  }
  return out;
}

function glanceFor(ctx, entry, kind, days) {
  const { task, tasks } = entry;
  const who = petNames(tasks) || ctx.hub.members.find(m => m.id === task.assignee)?.name || null;
  const place = task.placeName || null;
  const date = whenOf(task);
  const shortDate = dateLabel(date, ctx.locale, { month: "short", day: "numeric" });
  const time = (task.booked ? task.apptTime : null) || task.dueTime;
  const at = time ? clock(time, ctx.locale) : null;
  const soon = n => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);
  const parts = (...xs) => xs.filter(Boolean).join(" · ");
  const extra = !who && !place ? task.provider : null;   // say who does it when nothing else does

  // A stay (boarding): before, during, and after.
  if (kind.stay && task.endDate) {
    const range = dateRange(date, task.endDate, ctx.locale, ctx.today);
    const untilEnd = daysBetween(ctx.today, task.endDate);
    if (!task.booked) return { headline: days < 0 ? `${task.title}: not booked` : `${task.title} ${soon(days)}`, detail: parts(who, range, "not booked yet") };
    if (days > 0) return { headline: `${task.title} ${soon(days)}`, detail: parts(who, range, task.provider, at) };
    if (untilEnd >= 0) return { headline: untilEnd === 0 ? `${task.title}: home today` : `${task.title}: home ${dayName(task.endDate, ctx.today, ctx.locale)}`, detail: parts(who, task.provider) };
    return { headline: `${task.title}: done?`, detail: parts(who, `Ended ${dateLabel(task.endDate, ctx.locale, { month: "short", day: "numeric" })}`) };
  }

  // Something to book that isn't yet: still a deadline, with a nudge.
  if (kind.bookable && !task.booked) {
    if (days < 0) return { headline: `${task.title} overdue`, detail: parts(who, place, `Due ${shortDate} · ${plural(-days, "day")} ago`, "not booked") };
    return { headline: `${task.title} due ${soon(days)}`, detail: parts(who, place, days > 1 ? dayName(date, ctx.today, ctx.locale) : null, "not booked yet") };
  }

  // An appointment: booked, or a visit by nature (a lawn service).
  if (kind.bookable || kind.appointment) {
    if (days < 0) return { headline: `${task.title}: done?`, detail: parts(who, place, `Was ${shortDate} · ${plural(-days, "day")} ago`) };
    return { headline: `${task.title} ${soon(days)}`, detail: parts(who, place, extra, days > 1 ? dayName(date, ctx.today, ctx.locale) : null, at) };
  }

  // A deadline.
  if (days < 0) return { headline: `${task.title} overdue`, detail: parts(who, place, extra, `Due ${shortDate} · ${plural(-days, "day")} ago`) };
  return { headline: `${task.title} due ${soon(days)}`, detail: parts(who, place, extra, days > 1 ? dayName(date, ctx.today, ctx.locale) : null, at) };
}

/** How far off a task is, if its card shows today; otherwise null. */
function due(ctx, task) {
  const date = whenOf(task);
  if (!date) return null;
  const days = daysBetween(ctx.today, date);
  const kind = kindOf(task);
  // A stay shows until it ends.
  const staying = kind.stay && task.booked && task.endDate && days <= 0 && ctx.today <= task.endDate;
  return days <= leadDays(task) || staying ? days : null;
}

/** The cards for one area's tasks. No database, or nothing due: no cards. */
export async function taskCards(ctx, area) {
  const tasks = await ctx.household();
  if (!tasks) return [];
  const kinds = AREAS[area].kinds;
  const showing = tasks.filter(t => t.area === area && kinds[t.kind] && inView(ctx, t) && due(ctx, t) != null);
  const timeOf = t => String((t.booked ? t.apptTime : null) ?? t.dueTime ?? "");
  return bundle(showing)
    .map(entry => ({ entry, days: due(ctx, entry.task) }))
    // Overdue first, then soonest; appointments on the same day by time.
    .sort((a, b) => a.days - b.days || timeOf(a.entry.task).localeCompare(timeOf(b.entry.task)))
    .map(({ entry, days }) => {
      const { task, tasks: group } = entry;
      const kind = kinds[task.kind];
      return {
        id: group.length > 1 ? `${area}:${task.groupId}:${whenOf(task)}` : `${area}:${task.id}`,
        title: AREAS[area].label,
        url: `${ctx.hubUrl}household/#${area}`,
        glance: { ...glanceFor(ctx, entry, kind, days), emoji: kind.emoji },
        data: {
          task: {
            id: task.id, kind: task.kind, title: task.title,
            pet: petNames(group), pets: group.map(t => t.petName).filter(Boolean),
            place: task.placeName ?? null, assignee: task.assignee,
            dueDate: task.dueDate, dueTime: task.dueTime, date: whenOf(task), daysUntil: days, overdue: days < 0,
            booked: !!task.booked, apptDate: task.apptDate ?? null, apptTime: task.apptTime ?? null, endDate: task.endDate ?? null,
            needsBooking: !!kind.bookable && !task.booked,
            repeats: repeatLabel(task), provider: task.provider, phone: task.phone,
          },
        },
      };
    });
}
