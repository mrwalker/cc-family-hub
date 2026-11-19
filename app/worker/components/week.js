/**
 * week: the next seven days, starting today.
 *
 *   data: { days: [{ date, label, events: [event…] }] }   (events as in today)
 */

import { eventsBetween } from "./events.js";
import { addDays, dayName, dateLabel } from "../util.js";

export const id = "week";
const DAYS = 7;

export async function cards(ctx) {
  const { today } = ctx;
  const last = addDays(today, DAYS - 1);
  const events = eventsBetween(ctx, await ctx.events(), today, last);
  if (!events.length) return [];
  const days = [];
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(today, i);
    days.push({ date, label: dayName(date, today, ctx.locale), events: events.filter(e => e.date === date) });
  }
  const busiest = days.slice(1).reduce((b, d) => (d.events.length > (b?.events.length ?? 0) ? d : b), null);
  const n = events.length;
  return [{
    id: "week",
    title: "This week",
    url: `${ctx.hubUrl}#week`,
    glance: {
      headline: `${n} event${n === 1 ? "" : "s"}`,
      detail: busiest
        ? `Next 7 days · busiest ${dateLabel(busiest.date, ctx.locale, { weekday: "long" })}`
        : "Next 7 days",
    },
    data: { days },
  }];
}
