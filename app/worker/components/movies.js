/**
 * movies: one card per movie or show worth seeing, over its poster. Coming soon first
 * (soonest first), then what came out in the last few weeks (newest first).
 *
 * The movies are the hub's own (movies.js), picked monthly by the family's assistant,
 * with everyone's marks. A member's view shows what they want to see (or everything,
 * when they haven't marked any). Before the first picks, the published movies.yaml
 * list is used, as before v2.8.
 *
 *   data: { movie: { id, title, kind, releaseDate, where, format, blurb, url, image,
 *                    want[], seen[], who[] (= want) } }
 *
 *   data: { movie: { title, releaseDate, format, streaming, who, status } }
 */

import { dateLabel, addDays } from "../util.js";

export const id = "movies";

const isOut = (ctx, m) => !!m.releaseDate && m.releaseDate <= ctx.today;
const rank = (ctx, m) => (!m.releaseDate ? 2 : isOut(ctx, m) ? 1 : 0);

const RECENT_DAYS = 45;

export async function cards(ctx) {
  const kept = typeof ctx.movies === "function" ? await ctx.movies() : null;
  if (kept) return keptCards(ctx, kept);
  const family = await ctx.data("family");
  const movies = (Array.isArray(family?.movies) ? family.movies : [])
    .filter(m => m?.title && m.status === "want-to-watch")
    .filter(m => !ctx.view || !Array.isArray(m.who) || m.who.includes(ctx.view.id))
    // Coming soon first (soonest first), then what's out (newest first), then undated.
    .sort((a, b) => rank(ctx, a) - rank(ctx, b) || (isOut(ctx, a)
      ? String(b.releaseDate).localeCompare(String(a.releaseDate))
      : String(a.releaseDate ?? "").localeCompare(String(b.releaseDate ?? ""))));
  return movies.map((m, i) => {
    const out = m.releaseDate && m.releaseDate <= ctx.today;
    const when = !m.releaseDate ? null
      : out ? (m.streaming ? `Streaming on ${m.streaming}` : "Out now")
      : `Out ${dateLabel(m.releaseDate, ctx.locale, { month: "short", day: "numeric" })}`;
    return {
      id: `movies:${m.id ?? i}`,
      title: "Movies",
      url: `${ctx.hubUrl}#movies`,
      glance: { headline: m.title, detail: [when, m.format].filter(Boolean).join(" · "), emoji: "🍿" },
      data: {
        movie: {
          title: m.title, releaseDate: m.releaseDate ?? null, format: m.format ?? null,
          streaming: m.streaming ?? null, who: Array.isArray(m.who) ? m.who : [], status: m.status,
        },
      },
    };
  });
}

/** "Out Dec 18 · IMAX", "In theaters now", "On Netflix now", "On Netflix Dec 5". */
function whenText(ctx, m) {
  const theaters = !m.where || /theat/i.test(m.where);
  const day = m.releaseDate ? dateLabel(m.releaseDate, ctx.locale, { month: "short", day: "numeric" }) : null;
  const out = !m.releaseDate || m.releaseDate <= ctx.today;
  if (theaters) return out ? "In theaters now" : `In theaters ${day}`;
  return out ? `On ${m.where} now` : `On ${m.where} ${day}`;
}

function keptCards(ctx, movies) {
  const recent = addDays(ctx.today, -RECENT_DAYS);
  let list = movies.filter(m => !m.archived && (!m.releaseDate || m.releaseDate >= recent));
  if (ctx.view) {
    const mine = list.filter(m => m.marks?.[ctx.view.id] === "want");
    if (mine.length) list = mine;
  }
  const soon = m => m.releaseDate && m.releaseDate >= ctx.today;
  list.sort((a, b) => (soon(b) - soon(a)) || (soon(a)
    ? a.releaseDate.localeCompare(b.releaseDate)
    : String(b.releaseDate ?? "").localeCompare(String(a.releaseDate ?? ""))));
  const colors = Object.fromEntries((ctx.hub.members ?? []).map(m => [m.id, m.color]));
  return list.map(m => {
    const want = Object.keys(m.marks ?? {}).filter(id => m.marks[id] === "want");
    const seen = Object.keys(m.marks ?? {}).filter(id => m.marks[id] === "seen");
    const image = m.imageUrl ? ctx.image(`movies:${m.id}`) : null;
    return {
      id: `movies:${m.id}`,
      title: m.kind === "show" ? "Shows" : "Movies",
      url: `${ctx.hubUrl}#movies`,
      glance: {
        headline: m.title,
        detail: [whenText(ctx, m), m.format].filter(Boolean).join(" · "),
        emoji: m.kind === "show" ? "📺" : "🍿",
        colors: want.map(id => colors[id]).filter(Boolean),
        ...(image ? { image } : {}),
      },
      data: {
        movie: {
          id: m.id, title: m.title, kind: m.kind, releaseDate: m.releaseDate, where: m.where, format: m.format,
          blurb: m.blurb, url: m.url, image, want, seen, who: want,
        },
      },
    };
  });
}
