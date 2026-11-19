/**
 * today: the rest of today and all of tomorrow. Always one card, so screens
 * that show a single card have something to anchor on. Urgent plan flags ride
 * on it (rule 4 in docs/stream.md).
 *
 *   data: { events: [{ title, day: "Today"|"Tomorrow", date, time, startAt, endAt,
 *                      allDay, location?, members, colors }],
 *           moreEvents, flags: [{ severity, message }], eventsError? }
 */

import { eventsBetween, untilLabel } from "./events.js";
import { timeLabel } from "../util.js";

export const id = "today";
const MAX_EVENTS = 12;

export async function cards(ctx) {
  const { today, tomorrow, now } = ctx;
  let events = [], eventsError;
  try {
    events = eventsBetween(ctx, await ctx.events(), today, tomorrow)
      .map(e => ({ ...e, day: e.date === today ? "Today" : "Tomorrow" }));
  } catch (err) {
    eventsError = err.message;
  }
  const plan = await ctx.data("plan");
  const flags = (plan?.flags ?? [])
    .filter(f => f.severity === "urgent")
    .filter(f => !ctx.view || !f.relatedMemberIds?.length || f.relatedMemberIds.includes(ctx.view.id))
    .map(f => ({ severity: f.severity, message: f.message }));

  return [{
    id: "today",
    title: "Today",
    url: `${ctx.hubUrl}#today`,
    glance: glance(ctx, events, flags),
    data: {
      events: events.slice(0, MAX_EVENTS),
      moreEvents: Math.max(0, events.length - MAX_EVENTS),
      flags,
      ...(eventsError ? { eventsError } : {}),
    },
  }];

  function glance(ctx, events, flags) {
    const timedToday = events.filter(e => e.date === today && !e.allDay);
    const next = timedToday[0];
    if (next) {
      const until = untilLabel(now, next.startAt, next.endAt);
      const detail = until === "now"
        ? `Now · until ${timeLabel(new Date(next.endAt), ctx.tz, ctx.locale)}`
        : `${next.time} · ${until}`;
      return { headline: next.title, detail, colors: next.colors };
    }
    const allDay = events.find(e => e.date === today);
    if (allDay) return { headline: allDay.title, detail: "Today · all day", colors: allDay.colors };
    const tmrw = events.find(e => e.date === tomorrow);
    if (tmrw) return { headline: tmrw.title, detail: `Tomorrow · ${tmrw.time}`, colors: tmrw.colors };
    if (flags.length) return { headline: flags[0].message, detail: "From this week's plan", emoji: "🚨" };
    return { headline: "Nothing on the calendar", detail: "Today and tomorrow are clear" };
  }
}
