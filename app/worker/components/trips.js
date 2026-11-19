/**
 * trips: one card per upcoming or active trip, soonest first. An active trip
 * leads the stream (rule 3 in docs/stream.md) and carries today's schedule.
 *
 *   data: { trip, resort, start, end, dates, status: "upcoming"|"active",
 *           daysUntil, day, days, countdown, leaderboard: [{ id, name, color, points, quests }],
 *           questsDone, questsTotal, today: [{ time, emoji, title }],
 *           album: { count, photos: [image URL…] } | null }   (trips.yaml → album)
 */

import { familyTrips, heroImage, tripAlbum } from "./trip-info.js";

export const id = "trips";

export async function cards(ctx) {
  const trips = (await familyTrips(ctx))
    .filter(t => t.status !== "past")
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  const albums = await Promise.all(trips.map(t => tripAlbum(ctx, t)));
  return trips.map((t, i) => {
    const album = albums[i];
    // The trip's own photos when it has an album, else the trip app's hero.
    const image = album ? album.photos[0] : heroImage(ctx, `trips:${t.id}`, t);
    const cardId = `trips:${t.id}`;
    const app = t.app;
    const headline = t.status === "active"
      ? `Day ${t.day} of ${t.days}`
      : t.daysUntil === 1 ? "Tomorrow" : `${t.daysUntil} days`;
    return {
      id: cardId,
      title: t.name,
      url: app ? `${ctx.origin}${app.path}` : `${ctx.hubUrl}#trips`,
      leads: t.status === "active",
      glance: {
        headline,
        detail: `${t.name} · ${t.dates}`,
        ...(t.emoji ? { emoji: t.emoji } : {}),
        ...(image ? { image } : {}),
      },
      data: {
        trip: t.id,
        name: t.name,
        destination: t.destination,
        resort: app?.resort ?? null,
        start: t.start, end: t.end, dates: t.dates,
        status: t.status,
        daysUntil: t.daysUntil,
        day: t.day,
        days: t.days,
        countdown: app?.countdown ?? null,
        who: t.who,
        leaderboard: app?.leaderboard ?? [],
        questsDone: app?.questsDone ?? 0,
        questsTotal: app?.questsTotal ?? 0,
        today: app?.today ?? [],
        album,
      },
    };
  });
}
