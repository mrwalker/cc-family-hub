/**
 * chores: the kids' chores for today (chores.js). Ticked off at /household/.
 *
 *   The family's view (and an adult's): one card, "5 of 9 done", naming who's next.
 *   A kid's view: their own card, with their next chore.
 *   On the week's first day: a card with the new jobs.
 *
 * No household database, or no chores set up: no cards.
 *
 *   data: { type: "day" | "week", day, week, jobs: [{ id, name, emoji, member }],
 *           people: [{ id, name, color, jobs[], chores: [{ id, title, job, cadence, time,
 *                      timeKind, when, status, doneAt, count }] }] }
 */

import { nextUp, minutesIn } from "../chores.js";

export const id = "chores";

/** "Feed the dogs at 4:30 PM", "Dishes (late)", "Bins to the curb tomorrow". */
export function choreLine(c) {
  if (c.status === "late") return `${c.title} (late)`;
  if (c.status === "tomorrow") return `${c.title} tomorrow`;
  return c.when ? `${c.title} ${c.when}` : c.title;
}

/** What counts toward "done": scheduled chores due today, not as-needed or tomorrow's. */
const counted = c => c.cadence !== "as-needed" && c.status !== "tomorrow";

const data = (view, type, people = view.people) => ({
  type, day: view.day, week: view.week, jobs: view.jobs,
  people: people.map(p => ({
    id: p.id, name: p.name, color: p.color, jobs: p.jobs,
    chores: p.chores.map(c => ({ id: c.id, title: c.title, job: c.job, cadence: c.cadence, time: c.time, timeKind: c.timeKind, when: c.when, status: c.status, doneAt: c.doneAt, count: c.count })),
  })),
});

export async function cards(ctx) {
  const today = await ctx.chores();
  if (!today) return [];
  const { view } = today;
  const minutes = minutesIn(ctx.now, ctx.tz);
  const url = `${ctx.hubUrl}household/#chores`;
  const nameOf = id => view.people.find(p => p.id === id)?.name ?? id;
  const out = [];

  // A kid's own view: just theirs.
  if (ctx.view?.role === "child") {
    const me = view.people.find(p => p.id === ctx.view.id);
    const mine = me?.chores ?? [];
    if (!mine.length) return [];
    const total = mine.filter(counted).length;
    const done = mine.filter(c => counted(c) && c.status === "done").length;
    const next = nextUp({ people: [me] }, minutes);
    out.push({
      id: `chores:${me.id}`,
      title: "Your chores",
      url,
      glance: {
        headline: next ? choreLine(next) : total ? "All done for today" : choreLine(mine[0]),
        detail: [total ? `${done} of ${total} done` : null, me.jobs.length ? me.jobs.join(", ") : null].filter(Boolean).join(" · "),
        emoji: "🧹",
        colors: me.color ? [me.color] : [],
      },
      data: data(view, "day", [me]),
    });
    return out;
  }

  const all = view.people.flatMap(p => p.chores.filter(counted).map(c => ({ c, p })));
  if (all.length) {
    const done = all.filter(x => x.c.status === "done").length;
    const next = nextUp(view, minutes);
    const open = [...new Set(all.filter(x => x.c.status !== "done" && x.c.status !== "missed").map(x => x.p.color).filter(Boolean))];
    out.push({
      id: "chores:today",
      title: "Chores",
      url,
      glance: {
        headline: done === all.length ? "All chores done today" : `${done} of ${all.length} chores done`,
        detail: next ? `Next: ${next.person.name} · ${choreLine(next)}` : "",
        emoji: "🧹",
        colors: open,
      },
      data: data(view, "day"),
    });
  }

  // The week's first day: who has which job now.
  const held = view.jobs.filter(j => j.member);
  if (ctx.today === view.week && held.length) {
    out.push({
      id: `chores:week:${view.week}`,
      title: "This week's jobs",
      url,
      glance: {
        headline: "New jobs this week",
        detail: held.map(j => `${nameOf(j.member)}: ${j.name}`).join(" · "),
        emoji: "🔄",
        colors: held.map(j => view.people.find(p => p.id === j.member)?.color).filter(Boolean),
      },
      data: data(view, "week"),
    });
  }
  return out;
}
