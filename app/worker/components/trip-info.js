/**
 * Trips for the trips and past-trips components: the hub's trips (trip-records.js),
 * or before it has any, the published trips.yaml list (data:family), joined with each
 * trip app's summary (dates, hero photo, leaderboard, today's schedule).
 */

import { daysBetween, dateRange, shuffled } from "../util.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every family trip (not work trips) in the view, with its status by date. */
export async function familyTrips(ctx) {
  const kept = typeof ctx.tripRecords === "function" ? await ctx.tripRecords().catch(() => null) : null;
  const family = kept ? null : await ctx.data("family");
  const listed = kept ?? (Array.isArray(family?.trips) ? family.trips : []);
  const apps = await ctx.trips().catch(() => []);
  const appByTrip = new Map(apps.map(a => [a.trip, a]));
  const out = [];
  const seen = new Set();
  for (const t of listed) {
    if (!t?.id || t.type === "work") continue;
    seen.add(t.id);
    const app = appByTrip.get(t.id);
    const start = app?.start ?? t.startDate, end = app?.end ?? t.endDate;
    if (!DATE.test(start ?? "") || !DATE.test(end ?? "")) continue;
    if (ctx.view && Array.isArray(t.who) && !t.who.includes(ctx.view.id)) continue;
    out.push(trip(ctx, t, app, start, end));
  }
  // A trip app whose trip hasn't been published yet still gets a card.
  for (const app of apps) {
    if (seen.has(app.trip)) continue;
    out.push(trip(ctx, { id: app.trip, name: app.title }, app, app.start, app.end));
  }
  return out;
}

function trip(ctx, t, app, start, end) {
  const { today } = ctx;
  const status = today > end ? "past" : today >= start ? "active" : "upcoming";
  return {
    id: t.id,
    name: t.name || app?.title || t.id,
    destination: t.destination ?? app?.resort ?? null,
    emoji: t.emoji ?? null,
    album: typeof t.album === "string" ? t.album : null,   // the link stays on the server
    who: Array.isArray(t.who) ? t.who : null,
    highlights: (t.highlights ?? []).map(h => ({ emoji: h.emoji ?? null, label: h.label ?? "", caption: h.caption ?? "" })),
    start, end,
    dates: dateRange(start, end, ctx.locale, today),
    status,
    daysUntil: status === "upcoming" ? daysBetween(today, start) : 0,
    day: status === "active" ? daysBetween(start, today) + 1 : null,
    days: daysBetween(start, end) + 1,
    app: app ?? null,
  };
}

export function heroImage(ctx, cardId, t) {
  return t.app?.hero ? ctx.image(cardId) : undefined;
}

const ALBUM_PHOTOS = 12;

/**
 * A trip's shared album, if it has one: { count, photos: [image URL…] }
 * in a shuffled order that changes each minute, or null. An album that can't be
 * read counts as none, so a trip still gets its card.
 */
export async function tripAlbum(ctx, t) {
  if (!t.album) return null;
  let photos;
  try { photos = (await ctx.album(t.album)) ?? []; } catch { return null; }
  if (!photos.length) return null;
  let seed = ctx.photoSeed;
  for (const c of t.id) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  return {
    count: photos.length,
    photos: shuffled(photos, seed).slice(0, ALBUM_PHOTOS).map(p => ctx.image(`trip-photo:${t.id}:${p.id}`)),
  };
}
