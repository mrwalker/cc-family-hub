/**
 * Calendar events for the today and week components: shared invites merged
 * into one event with every attendee's color, declined and finished events
 * dropped, filtered to the view, in the family's timezone.
 */

import { ymd, addDays, timeLabel } from "../util.js";

/** Events from `from` to `to` (YYYY-MM-DD, inclusive), soonest first. */
export function eventsBetween(ctx, events, from, to) {
  const { hub, tz, now, today, view } = ctx;
  const order = hub.members.map(m => m.id);
  const colorOf = Object.fromEntries(hub.members.map(m => [m.id, m.color]));
  const merged = new Map();
  for (const e of events) {
    if (e.declined) continue;
    const key = e.id ?? `${e.title}|${e.startAt}`;
    const g = merged.get(key);
    if (g) {
      if (!g.members.includes(e.memberId)) g.members.push(e.memberId);
    } else {
      merged.set(key, { ...e, members: [e.memberId] });
    }
  }
  const out = [];
  for (const e of merged.values()) {
    if (view && !e.members.includes(view.id)) continue;
    const startDay = e.allDay ? e.startAt.slice(0, 10) : ymd(new Date(e.startAt), tz);
    // All-day events end on the (exclusive) next date; timed events end at endAt.
    const endDay = e.allDay ? addDays(e.endAt || addDays(startDay, 1), -1) : ymd(new Date(e.endAt || e.startAt), tz);
    const over = e.allDay ? endDay < today : new Date(e.endAt || e.startAt) <= now;
    if (over) continue;
    // A multi-day event that started earlier shows on the first day in range.
    const day = startDay < from ? from : startDay;
    if (day > to) continue;
    const members = e.members.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
    out.push({
      title: e.title,
      date: day,
      time: e.allDay ? "All day" : timeLabel(new Date(e.startAt), tz, ctx.locale),
      startAt: e.startAt,
      endAt: e.endAt,
      allDay: !!e.allDay,
      ...(e.location ? { location: e.location } : {}),
      members,
      colors: members.map(id => colorOf[id]).filter(Boolean),
      sortKey: `${day}${e.allDay ? "0" : "1"}${e.allDay ? "" : new Date(e.startAt).toISOString()}`,
    });
  }
  out.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  for (const e of out) delete e.sortKey;
  return out;
}

/** "in 25 min", "in 2 hr", "now" */
export function untilLabel(now, startAt, endAt) {
  const start = new Date(startAt), end = new Date(endAt || startAt);
  if (start <= now) return end > now ? "now" : "";
  const mins = Math.round((start - now) / 60_000);
  if (mins < 60) return `in ${Math.max(1, mins)} min`;
  const hrs = Math.round(mins / 60);
  return `in ${hrs} hr`;
}
