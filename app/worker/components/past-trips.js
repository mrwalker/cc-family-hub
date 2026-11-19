/**
 * past-trips: one card per trip you've taken, most recent first, with its
 * highlights and the trip app's final standings.
 *
 *   data: { trip, name, destination, start, end, dates, highlights: [{ emoji, label, caption }],
 *           leaderboard: [{ id, name, color, points, quests }] }
 */

import { familyTrips, heroImage } from "./trip-info.js";

export const id = "past-trips";

export async function cards(ctx) {
  const trips = (await familyTrips(ctx))
    .filter(t => t.status === "past")
    .sort((a, b) => (a.start < b.start ? 1 : -1));
  return trips.map(t => {
    const cardId = `past-trips:${t.id}`;
    const leaderboard = t.app?.leaderboard ?? [];
    const winner = leaderboard[0]?.points > 0 ? leaderboard[0] : null;
    return {
      id: cardId,
      title: t.name,
      url: t.app ? `${ctx.origin}${t.app.path}` : `${ctx.hubUrl}#past-trips`,
      glance: {
        headline: t.name,
        detail: winner ? `${t.dates} · ${winner.name} won` : [t.destination, t.dates].filter(Boolean).join(" · "),
        ...(t.emoji ? { emoji: t.emoji } : {}),
        ...(heroImage(ctx, cardId, t) ? { image: heroImage(ctx, cardId, t) } : {}),
      },
      data: {
        trip: t.id,
        name: t.name,
        destination: t.destination,
        start: t.start, end: t.end, dates: t.dates,
        who: t.who,
        highlights: t.highlights,
        leaderboard,
      },
    };
  });
}
