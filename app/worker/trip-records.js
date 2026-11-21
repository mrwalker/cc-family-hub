/**
 * The family's trips, kept by the hub (D1, HUB_DB). Routed from household.js; edited on
 * /household/ (the Trips tab). Trip apps (trips.js, hub.tripApps) are separate: an app
 * names the trip it belongs to by its id here.
 *
 *   trip: { id, name, destination?, emoji?, startDate, endDate, type: "family"|"work",
 *           who[], album?, description?, mapBbox?,
 *           highlights: [{ emoji, label, caption, bg }], activities: [{ emoji, name, note }],
 *           restaurants: [{ name, price, type, note }], ideas: [text], archived }
 *
 *   GET  /api/household/trips              → the household snapshot, with { trips, canImportTrips, tripApps }
 *   POST /api/household/trips                a trip (with isNew: true to add one; its id can't be taken)
 *   POST /api/household/trips/:id/archive    { archived }
 *   POST /api/household/trips/import         once: the published trips.yaml list
 *
 * Adults add, change and archive trips. Everyone else only reads, and only adults see a
 * trip's album link. The map on the hub page is centered on the destination, looked up
 * once on OpenStreetMap's geocoder whenever the destination changes.
 *
 * Until a family has any trips here, the stream and the hub page show the published list
 * (data:family.trips), so nothing goes missing in between.
 */

import { albumKey } from "./photos.js";
import { ensureSchema } from "./db/migrations.js";

const ID_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const MAX_TRIPS = 300;
const BG_RE = /^linear-gradient\(\d{1,3}deg, ?#[0-9a-f]{3,8}, ?#[0-9a-f]{3,8}\)$/i;
const PRICES = ["$", "$$", "$$$", "$$$$"];
/** The highlight colors the editor offers; a highlight without one takes them in turn. */
export const HIGHLIGHT_COLORS = [
  "linear-gradient(135deg,#0891b2,#1d4ed8)", "linear-gradient(135deg,#0284c7,#7c3aed)",
  "linear-gradient(135deg,#16a34a,#84cc16)", "linear-gradient(135deg,#f97316,#db2777)",
  "linear-gradient(135deg,#0d9488,#4f46e5)", "linear-gradient(135deg,#78716c,#44403c)",
];
/** How many of each a trip holds. */
export const LIMITS = { highlights: 12, activities: 40, restaurants: 40, ideas: 40 };
const GEOCODER = "https://nominatim.openstreetmap.org/search";
const GEOCODE_MS = 5000;

const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const day = v => {
  const s = v instanceof Date ? v.toISOString() : typeof v === "string" ? v.trim() : "";
  const d = DATE_RE.test(s) ? s.slice(0, 10) : null;
  return d && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) ? d : null;
};

/** "west,south,east,north" in degrees, or null. */
export function cleanBbox(v) {
  if (typeof v !== "string") return null;
  const n = v.split(",").map(s => Number(s.trim()));
  if (n.length !== 4 || n.some(x => !Number.isFinite(x))) return null;
  const [w, s, e, north] = n;
  if (w < -180 || e > 180 || s < -90 || north > 90 || w >= e || s >= north) return null;
  return n.map(x => String(Math.round(x * 1000) / 1000)).join(",");
}

/** A list of up to `max` items, each made by `clean` (which returns null to drop it). */
function list(v, max, clean, at) {
  if (v == null) return { items: [] };
  if (!Array.isArray(v)) return { error: `${at}: a list` };
  if (v.length > max) return { error: `${at}: no more than ${max}` };
  return { items: v.map(clean).filter(Boolean) };
}

export function cleanTrip(c, { memberIds }) {
  if (!c || typeof c !== "object") return { error: "expected a trip" };
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) return { error: "id: 2–60 lowercase letters, digits or -, like beach-jul-2027" };
  const name = text(c.name, 80);
  if (!name) return { error: "name: required" };
  const startDate = day(c.startDate), endDate = day(c.endDate);
  if (!startDate) return { error: "startDate: YYYY-MM-DD" };
  if (!endDate) return { error: "endDate: YYYY-MM-DD" };
  if (endDate < startDate) return { error: "endDate: on or after the start" };
  if (c.type != null && c.type !== "family" && c.type !== "work") return { error: `type: "family" or "work"` };
  const album = c.album ? String(c.album).trim() : null;
  if (album && !albumKey(album)) {
    return { error: "album: an iCloud shared album link (https://www.icloud.com/sharedalbum/#… or https://photos.icloud.com/shared/album/…) with Public Website on" };
  }
  const mapBbox = c.mapBbox != null && c.mapBbox !== "" ? cleanBbox(c.mapBbox) : null;
  if (c.mapBbox != null && c.mapBbox !== "" && !mapBbox) return { error: "mapBbox: west,south,east,north in degrees" };

  let bgTurn = 0;
  const highlights = list(c.highlights, LIMITS.highlights, h => {
    const label = text(h?.label, 40);
    if (!label) return null;
    const bg = typeof h.bg === "string" && BG_RE.test(h.bg.trim()) ? h.bg.trim() : HIGHLIGHT_COLORS[bgTurn++ % HIGHLIGHT_COLORS.length];
    return { emoji: text(h.emoji, 16), label, caption: text(h.caption, 160), bg };
  }, "highlights");
  const activities = list(c.activities, LIMITS.activities, a => {
    const name = text(a?.name, 80);
    return name ? { emoji: text(a.emoji, 16), name, note: text(a.note, 400) } : null;
  }, "activities");
  const restaurants = list(c.restaurants, LIMITS.restaurants, r => {
    const name = text(r?.name, 80);
    if (!name) return null;
    const price = PRICES.includes(String(r.price ?? "").trim()) ? String(r.price).trim() : "";
    return { name, price, type: text(r.type, 40), note: text(r.note, 400) };
  }, "restaurants");
  const ideas = list(c.ideas, LIMITS.ideas, i => text(i, 400) || null, "ideas");
  for (const l of [highlights, activities, restaurants, ideas]) if (l.error) return { error: l.error };

  return {
    trip: {
      id: c.id, name, destination: text(c.destination, 80) || null, emoji: text(c.emoji, 16) || null,
      startDate, endDate, type: c.type === "work" ? "work" : "family",
      who: Array.isArray(c.who) ? [...new Set(c.who.filter(id => memberIds.has(id)))] : [],
      album, description: typeof c.description === "string" ? c.description.replace(/[ \t]+/g, " ").trim().slice(0, 2000) || null : null,
      mapBbox,
      highlights: highlights.items, activities: activities.items, restaurants: restaurants.items, ideas: ideas.items,
    },
  };
}

export const tripFromRow = r => {
  const d = parse(r.details, {});
  return {
    id: r.id, name: r.name, destination: r.destination ?? null, emoji: r.emoji ?? null,
    startDate: r.start_date, endDate: r.end_date, type: r.kind === "work" ? "work" : "family",
    who: parse(r.who, []), album: r.album ?? null, description: r.description ?? null,
    mapBbox: r.map_bbox ?? null, mapFor: r.map_for ?? null,
    highlights: d.highlights ?? [], activities: d.activities ?? [], restaurants: d.restaurants ?? [], ideas: d.ideas ?? [],
    archived: !!r.archived,
  };
};

/** The trips, latest start first. */
export async function listTrips(db, { archived = true } = {}) {
  const { results } = await db.prepare(`SELECT * FROM trips ${archived ? "" : "WHERE archived = 0"}
    ORDER BY archived, start_date DESC, name`).all();
  return results.map(tripFromRow);
}

const tripCount = async db => (await db.prepare("SELECT COUNT(*) AS n FROM trips").first()).n;

/** For the stream: the trips, or null when the hub has none yet (then the published list is used). */
export async function loadTrips(env) {
  if (!env.HUB_DB) return null;
  if (!(await tripCount(env.HUB_DB))) return null;
  return listTrips(env.HUB_DB, { archived: false });
}

/**
 * A trip's album link, for serving its photos: from the hub's trips, or before it has
 * any, from the published list. Null when the trip has none.
 */
export async function tripAlbumLink(env, id) {
  if (env.HUB_DB) await ensureSchema(env.HUB_DB);
  if (env.HUB_DB && (await tripCount(env.HUB_DB))) {
    const row = await env.HUB_DB.prepare("SELECT album FROM trips WHERE id = ?").bind(id).first();
    return row?.album ?? null;
  }
  return (await publishedTrips(env)).find(t => t.id === id)?.album ?? null;
}

/** Every album link among the trips that aren't archived, for warmAlbums (photos.js). */
export async function tripAlbumLinks(env) {
  if (env.HUB_DB) await ensureSchema(env.HUB_DB);
  if (env.HUB_DB && (await tripCount(env.HUB_DB))) {
    const { results } = await env.HUB_DB.prepare("SELECT album FROM trips WHERE archived = 0 AND album IS NOT NULL").all();
    return results.map(r => r.album);
  }
  return (await publishedTrips(env)).map(t => t.album).filter(Boolean);
}

/** The published list (trips.yaml), for the import and the fallback. */
async function publishedTrips(env) {
  const family = env.HUB_DATA ? await env.HUB_DATA.get("data:family", "json") : null;
  return Array.isArray(family?.trips) ? family.trips.filter(t => t && t.id) : [];
}

/**
 * What the page needs: the trips, whether there's an old list to bring in, and which
 * trips have an app. Only adults see album links.
 */
export async function tripsSnapshot(env, hub, { manage = false } = {}) {
  const trips = await listTrips(env.HUB_DB);
  return {
    trips: trips.map(({ album, mapFor, ...t }) => ({ ...t, hasAlbum: !!album, ...(manage ? { album } : {}) })),
    canImport: !trips.length && (await publishedTrips(env)).length > 0,
    tripApps: Object.fromEntries((hub.tripApps ?? []).map(a => [a.trip, a.path])),
  };
}

/**
 * The destination's area on the map, "west,south,east,north", from OpenStreetMap's
 * geocoder. Null when it can't be found or the geocoder can't be reached.
 */
export async function findMap(destination, { fetcher = fetch } = {}) {
  if (!destination) return null;
  try {
    const url = `${GEOCODER}?format=json&limit=1&q=${encodeURIComponent(destination)}`;
    const res = await fetcher(url, {
      headers: { "User-Agent": "cc-family-hub (a family's hub page; trip maps)", Accept: "application/json" },
      signal: AbortSignal.timeout(GEOCODE_MS),
    });
    if (!res.ok) return null;
    const [hit] = await res.json();
    const b = hit?.boundingbox;   // [south, north, west, east]
    return Array.isArray(b) && b.length === 4 ? cleanBbox(`${b[2]},${b[0]},${b[3]},${b[1]}`) : null;
  } catch { return null; }
}

function upsert(db, t, viewer, now) {
  const details = JSON.stringify({ highlights: t.highlights, activities: t.activities, restaurants: t.restaurants, ideas: t.ideas });
  return db.prepare(`INSERT INTO trips (id, name, destination, emoji, start_date, end_date, kind, who, album, description,
        map_bbox, map_for, details, archived, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, destination = excluded.destination, emoji = excluded.emoji,
        start_date = excluded.start_date, end_date = excluded.end_date, kind = excluded.kind, who = excluded.who,
        album = excluded.album, description = excluded.description, map_bbox = excluded.map_bbox,
        map_for = excluded.map_for, details = excluded.details, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(t.id, t.name, t.destination, t.emoji, t.startDate, t.endDate, t.type, JSON.stringify(t.who), t.album,
          t.description, t.mapBbox, t.mapFor ?? null, details, now, viewer.id, now, viewer.id);
}

/** An id like "beach-jul-2027" from a name and start date, for a published trip without a usable one. */
export function tripId(name, startDate) {
  const slug = String(name ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "trip";
  const d = day(startDate);
  if (!d) return slug.length >= 2 ? slug : "trip";
  const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][Number(d.slice(5, 7)) - 1];
  return `${slug}-${mon}-${d.slice(0, 4)}`;
}

/**
 * The /trips routes. Returns null for a path that isn't one. `answer()` replies with the
 * page's snapshot.
 */
export async function handleTripWrite({ env, db, hub, path, body, viewer, now, answer, json, fetcher = fetch }) {
  if (viewer.role !== "adult") return json({ error: "Only adults can change trips" }, 403);
  const memberIds = new Set(hub.members.map(m => m.id));

  if (path === "/trips") {
    const { trip, error } = cleanTrip(body, { memberIds });
    if (error) return json({ error }, 400);
    const old = await db.prepare("SELECT * FROM trips WHERE id = ?").bind(trip.id).first();
    if (old && body.isNew) return json({ error: `id: "${trip.id}" is another trip's; pick another` }, 409);
    if (!old && (await tripCount(db)) >= MAX_TRIPS) return json({ error: `No more than ${MAX_TRIPS} trips` }, 400);
    const before = old ? tripFromRow(old) : null;
    let next = { ...trip, mapFor: trip.mapBbox ? trip.destination : null };
    if (!trip.mapBbox && trip.destination) {
      // Keep the map while the destination stays the same; look again when it changes.
      next = before?.mapBbox && before.mapFor === trip.destination
        ? { ...next, mapBbox: before.mapBbox, mapFor: before.mapFor }
        : { ...next, ...(await mapFor(trip.destination, fetcher)) };
    }
    await upsert(db, next, viewer, now).run();
    return answer({ map: !!next.mapBbox });
  }

  if (path === "/trips/import") {
    if (await tripCount(db)) return json({ error: "The hub already has trips" }, 409);
    const published = await publishedTrips(env);
    if (!published.length) return json({ error: "There's no published list to import" }, 400);
    const trips = [];
    const seen = new Set();
    for (const [i, raw] of published.entries()) {
      let id = typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : tripId(raw.name, raw.startDate);
      if (seen.has(id)) id = `${id.slice(0, 55)}-${i}`;
      seen.add(id);
      const { trip, error } = cleanTrip({ ...raw, id }, { memberIds });
      if (error) return json({ error: `trips[${i}] (${raw.id ?? raw.name ?? "?"}).${error}` }, 400);
      trips.push({ ...trip, mapFor: trip.mapBbox ? trip.destination : null });
    }
    await db.batch(trips.map(t => upsert(db, t, viewer, now)));
    return answer({ imported: trips.length });
  }

  const action = path.match(/^\/trips\/([a-z0-9][a-z0-9-]{1,59})\/archive$/);
  if (!action) return null;
  const row = await db.prepare("SELECT id FROM trips WHERE id = ?").bind(action[1]).first();
  if (!row) return json({ error: "No such trip" }, 404);
  await db.prepare("UPDATE trips SET archived = ?, updated_at = ?, updated_by = ? WHERE id = ?")
    .bind(body.archived === false ? 0 : 1, now, viewer.id, row.id).run();
  return answer();
}

async function mapFor(destination, fetcher) {
  const mapBbox = await findMap(destination, { fetcher });
  return mapBbox ? { mapBbox, mapFor: destination } : { mapBbox: null, mapFor: null };
}
