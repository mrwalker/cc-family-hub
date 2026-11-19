/**
 * movies: one card per movie you want to watch, soonest release first.
 *
 * Coming soon first, then what's already out (newest first).
 *
 *   data: { movie: { title, releaseDate, format, streaming, who, status } }
 */

import { dateLabel } from "../util.js";

export const id = "movies";

const isOut = (ctx, m) => !!m.releaseDate && m.releaseDate <= ctx.today;
const rank = (ctx, m) => (!m.releaseDate ? 2 : isOut(ctx, m) ? 1 : 0);

export async function cards(ctx) {
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
