/**
 * Trip apps at a glance, for screens outside the trip apps (the Roku
 * screensaver, phone and Mac widgets). Under /api/widget/ so the widget service
 * tokens cover it.
 *
 *   GET /api/widget/trips → { trips: [{
 *       id, trip, title, titleAccent, resort, start, end, dates,
 *       status: "upcoming"|"active", daysUntil, day?, days, countdown, team,
 *       hero: "/api/widget/trips/<id>/hero" | null, url,
 *       leaderboard: [{ id, name, color, points, quests }],   // highest first
 *       questsDone, questsTotal,
 *       today: [{ time, emoji, title }]                        // active trips only
 *     }], generatedAt }
 *   GET /api/widget/trips/:id/hero → the trip's hero photo
 *
 * Trips that are over are left out. The data comes from each trip's
 * trip-data.js (summarized at build time by app/build.mjs) plus check-ins in
 * TRIP_KV, scored the same way as the trip app (app/public/trip-app/app.js).
 */

const CACHE_SECONDS = 60;

export async function handleTrips(request, env, hub, path) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);

  const hero = path.match(/^\/([a-z0-9-]{1,40})\/hero$/);
  if (hero) {
    const app = hub.tripApps.find(t => t.appId === hero[1]);
    if (!app?.summary?.hero || !env.ASSETS) return json({ error: "No such trip photo" }, 404);
    const res = await env.ASSETS.fetch(new Request(`${url.origin}${app.summary.hero}`));
    if (!res.ok) return json({ error: "No such trip photo" }, 404);
    return new Response(res.body, {
      headers: { "Content-Type": res.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "private, max-age=86400" },
    });
  }
  if (path !== "") return json({ error: "Not found" }, 404);

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(`https://family-hub.internal/trips`);
  const hit = cache && (await cache.match(key));
  let trips = hit ? await hit.json() : null;
  if (!trips) {
    trips = await summarize(env, hub);
    if (cache) {
      await cache.put(key, new Response(JSON.stringify(trips), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` },
      }));
    }
  }
  return json({
    trips: trips.map(t => ({
      ...t,
      hero: t.hero ? `${url.origin}/api/widget/trips/${t.id}/hero` : null,
      url: `${url.origin}${t.path}`,
      path: undefined,
    })),
    generatedAt: new Date().toISOString(),
  });
}

async function summarize(env, hub) {
  const out = [];
  for (const app of hub.tripApps) {
    const s = app.summary;
    if (!s?.start || !s?.end) continue;
    const today = ymd(new Date(), s.tz || hub.timezone);
    if (today > s.end) continue;
    const active = today >= s.start;
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
      dates: dateRange(s.start, s.end),
      status: active ? "active" : "upcoming",
      daysUntil: active ? 0 : daysBetween(today, s.start),
      ...(active ? { day: daysBetween(s.start, today) + 1 } : {}),
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

// ─── Dates ────────────────────────────────────────────────────────────────────

function ymd(date, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}
function dateRange(a, b) {
  const f = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(a)} – ${f(b)}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
