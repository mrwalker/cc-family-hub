/**
 * Trip apps at a glance, for the trips and past-trips components: each trip
 * app's countdown, hero photo, quest leaderboard and today's schedule. The data
 * comes from each trip's trip-data.js (summarized at build time by app/build.mjs)
 * plus check-ins in TRIP_KV, scored the same way as the trip app
 * (app/public/trip-app/app.js).
 */

import { ymd, daysBetween, dateRange, json } from "./util.js";

// Scoring reads every check-in with a KV list(), and KV's free tier allows only
// 1,000 of those a day across the account, so summaries are cached for 5 minutes.
const CACHE_SECONDS = 300;

/**
 * Every trip app's summary, upcoming, active and past, soonest first. Cached for
 * CACHE_SECONDS, since scoring reads every check-in.
 */
export async function tripSummaries(env, hub) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(`https://family-hub.internal/trip-summaries`);
  const hit = cache && (await cache.match(key));
  if (hit) return hit.json();
  const trips = await summarize(env, hub);
  if (cache) {
    await cache.put(key, new Response(JSON.stringify(trips), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` },
    }));
  }
  return trips;
}

/** A trip app's hero photo, from the family's static assets. */
export async function heroResponse(env, app, origin) {
  if (!app?.summary?.hero || !env.ASSETS) return json({ error: "No such trip photo" }, 404);
  const res = await env.ASSETS.fetch(new Request(`${origin}${app.summary.hero}`));
  if (!res.ok) return json({ error: "No such trip photo" }, 404);
  return new Response(res.body, {
    headers: { "Content-Type": res.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "private, max-age=86400" },
  });
}

async function summarize(env, hub) {
  const out = [];
  for (const app of hub.tripApps) {
    const s = app.summary;
    if (!s?.start || !s?.end) continue;
    const today = ymd(new Date(), s.tz || hub.timezone);
    const past = today > s.end;
    const active = !past && today >= s.start;
    const checkins = await loadCheckins(env, app.appId);
    const { leaderboard, questsDone } = score(s, checkins);
    const todayPlan = active ? (s.days.find(d => d.date === today)?.items ?? []) : [];
    out.push({
      id: app.appId,
      trip: app.trip,
      path: app.path,
      title: s.title,
      titleAccent: s.titleAccent,
      resort: s.resort,
      start: s.start,
      end: s.end,
      dates: dateRange(s.start, s.end, hub.locale),
      status: past ? "past" : active ? "active" : "upcoming",
      daysUntil: active || past ? 0 : daysBetween(today, s.start),
      ...(active ? { day: daysBetween(s.start, today) + 1 } : {}),
      ...(past ? { endedAgo: daysBetween(s.end, today) } : {}),
      days: daysBetween(s.start, s.end) + 1,
      countdown: s.countdown,
      team: s.team,
      hero: !!s.hero,
      leaderboard,
      questsDone,
      questsTotal: Object.keys(s.quests).length,
      today: todayPlan.slice(0, 8),
    });
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1));
}

async function loadCheckins(env, appId) {
  if (!env.TRIP_KV) return [];
  const prefix = `trip:${appId}:ci:`;
  const out = [];
  let cursor;
  do {
    const page = await env.TRIP_KV.list({ prefix, cursor });
    for (const k of page.keys) if (k.metadata) out.push(k.metadata);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** The trip app's scoring (computeScores in trip-app/app.js). */
export function score(s, checkins) {
  const members = new Map(s.members.map(m => [m.id, m]));
  const cis = checkins
    .filter(c => s.quests[c.quest] && members.has(c.member))
    .sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
  const firstTs = {};
  const done = Object.fromEntries(s.members.map(m => [m.id, new Map()]));
  for (const c of cis) {
    if (firstTs[c.quest] == null) firstTs[c.quest] = c.ts;
    if (!done[c.member].has(c.quest)) done[c.member].set(c.quest, c);
  }
  const rows = s.members.map((m, order) => {
    const quests = [...done[m.id].values()];
    let points = 0;
    const cats = new Set();
    for (const c of quests) {
      const q = s.quests[c.quest];
      points += q.pts;
      if (c.ts === firstTs[c.quest]) points += s.scoring.firstBonus;
      cats.add(q.cat);
    }
    if (s.categories.length && s.categories.every(c => cats.has(c))) points += s.scoring.varietyBonus;
    return { id: m.id, name: m.name, color: m.color, points, quests: quests.length, order };
  });
  // Ties (e.g. before anyone scores) keep the trip's member order.
  rows.sort((a, b) => b.points - a.points || b.quests - a.quests || a.order - b.order);
  return {
    leaderboard: rows.map(({ order, ...r }) => r),
    questsDone: new Set(cis.map(c => c.quest)).size,
  };
}

