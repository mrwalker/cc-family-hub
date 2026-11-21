/**
 * The stream: what the brain hands every output (docs/stream.md).
 *
 *   GET /api/stream?view=family|<member id>&output=<output id>[&components=a,b][&all=1]
 *     → { title, view, output, members, hubUrl, generatedAt, cards: [card…], errors? }
 *   components= narrows the stream to those components (in that order); all=1 returns
 *   every card, without taking turns or photos between.
 *   GET /api/stream/image/<card id>   → the card's photo (album photo or trip hero)
 *
 * The hub page asks at /api/page/stream instead (see index.js); its image links
 * then point under /api/page/stream too.
 *
 * Each component (components/) turns data into cards. compose() then applies the
 * rotation rules: order, empty components skipped, an active trip leads, long
 * components take turns, and photos between cards. A component that fails is
 * skipped and reported in `errors`; it never fails the stream.
 */

import { COMPONENT_IDS, byId } from "./components/index.js";
import { tripSummaries, heroResponse } from "./trips.js";
import { albumPhotos, albumPhotosFor, photoById, photoFromAlbum } from "./photos.js";
import { listGrocery } from "./grocery.js";
import { loadDueTasks, loadPets, photoResponse, roomImage, movieImage } from "./household.js";
import { loadRooms } from "./rooms.js";
import { loadMovies } from "./movies.js";
import { loadTrips, tripAlbumLink } from "./trip-records.js";
import { ensureSchema } from "./db/migrations.js";
import { loadChoresToday } from "./chores.js";
import { ymd, addDays, json } from "./util.js";

export const DEFAULT_MAX = 3;
export const DEFAULT_DWELL = 15;
const TURN_MS = 10 * 60_000;     // long components move to their next few cards every 10 minutes
const EVENT_DAYS = 8;            // today through the end of the week

/** Defaults each screen gets before the family's own `outputs.<id>.stream`. */
export const OUTPUT_DEFAULTS = {
  "hub-page": {},
  "phone-widget": {},
  "mac-menu-bar": {},
  roku: { photosBetween: 3, dwell: 10 },
  "tizen-tv": { photosBetween: 3, dwell: 10 },   // Samsung TVs (app/tizen)
};

/**
 * The stream settings for one output: the family's `stream`, then the
 * output's built-in defaults, then the family's `outputs.<id>.stream`.
 */
export function resolveConfig(hub, outputId) {
  const base = hub.stream ?? {};
  const layers = [base, OUTPUT_DEFAULTS[outputId] ?? {}, hub.outputs?.[outputId]?.stream ?? {}];
  // A component may say how many of its cards a pass shows (pet-portraits: every pet).
  const defaultMax = Object.fromEntries(Object.values(byId).filter(c => c.max).map(c => [c.id, c.max]));
  const cfg = { components: COMPONENT_IDS, dwell: DEFAULT_DWELL, photosBetween: 0, max: defaultMax };
  for (const l of layers) {
    if (Array.isArray(l.components)) cfg.components = l.components.filter(c => byId[c]);
    if (l.dwell != null) cfg.dwell = mergeDwell(cfg.dwell, l.dwell);
    if (l.photosBetween != null) cfg.photosBetween = l.photosBetween;
    if (l.max) cfg.max = { ...cfg.max, ...l.max };
  }
  return cfg;
}

function mergeDwell(a, b) {
  const asMap = d => (typeof d === "number" ? { default: d } : { ...d });
  return { ...asMap(a), ...asMap(b) };
}

export function dwellFor(dwell, component) {
  if (typeof dwell === "number") return dwell;
  return dwell?.[component] ?? dwell?.default ?? DEFAULT_DWELL;
}

/** Up to `max` of `list`, starting at a different place each turn so every card gets its go. */
export function takeTurns(list, max, turn) {
  if (list.length <= max) return list.slice();
  const start = (turn * max) % list.length;
  return Array.from({ length: max }, (_, i) => list[(start + i) % list.length]);
}

/**
 * Applies the rotation rules (docs/stream.md#rotation-rules) to each component's
 * cards. Pure: the same inputs give the same stream.
 *
 *   cardsBy:   { <component>: [card…] }, in each component's own order
 *   photoPool: shuffled photo cards for photosBetween
 */
export function compose({ cfg, cardsBy, photoPool = [], turn = 0 }) {
  const between = Math.max(0, cfg.photosBetween | 0);
  const leading = [];
  const rest = [];
  for (const component of cfg.components) {
    // With photos between every card, photos don't also take a place of their own.
    if (between && component === "photos") continue;
    let list = (cardsBy[component] ?? []).map(c => ({ ...c, component }));
    // Rule 3: an active trip leads, and is never left out by taking turns.
    const leads = list.filter(c => c.leads);
    list = list.filter(c => !c.leads);
    leading.push(...leads);
    rest.push(...takeTurns(list, cfg.max[component] ?? DEFAULT_MAX, turn));
  }
  const ordered = [...leading, ...rest].map(({ leads, ...c }) => ({ ...c, dwell: dwellFor(cfg.dwell, c.component) }));
  if (!between || !photoPool.length) return ordered;

  const out = [];
  let p = 0;
  for (const card of ordered) {
    out.push(card);
    for (let i = 0; i < between; i++) {
      const photo = photoPool[p++ % photoPool.length];
      out.push({ ...photo, component: "photos", dwell: dwellFor(cfg.dwell, "photos") });
    }
  }
  return out;
}

/** The context components read from. Each source is fetched at most once per request. */
export function makeContext({ request, env, hub, loadEvents, now = new Date(), view = null, base = "/api/stream" }) {
  const url = new URL(request.url);
  const tz = hub.timezone;
  const today = ymd(now, tz);
  const once = fn => { let p; return () => (p ??= Promise.resolve().then(fn)); };
  const dataCache = {};
  const albums = {};
  const ctx = {
    env, hub, now, tz, view,
    locale: hub.locale || "en-US",
    today,
    tomorrow: addDays(today, 1),
    origin: url.origin,
    hubUrl: `${url.origin}/`,
    turn: Math.floor(now.getTime() / TURN_MS),
    photoSeed: Math.floor(now.getTime() / 60_000),
    data: kind => (dataCache[kind] ??= env.HUB_DATA ? env.HUB_DATA.get(`data:${kind}`, "json") : Promise.resolve(null)),
    events: once(() => loadEvents(EVENT_DAYS)),
    trips: once(() => tripSummaries(env, hub)),
    photos: once(() => albumPhotos(hub)),
    grocery: once(() => listGrocery(env)),
    // Household tasks that could have a card today; null without a HUB_DB database.
    household: once(() => loadDueTasks(env, today, { hub, origin: url.origin })),
    // Pets and their photos, for pet-portraits; null without a HUB_DB database.
    pets: once(() => loadPets(env)),
    // Each kid's chores today, and the week's jobs; null without a HUB_DB database or chores.
    chores: once(() => loadChoresToday(env, hub, now)),
    // The escape rooms the hub keeps; null without a database or before the old list is imported.
    rooms: once(async () => { if (!env.HUB_DB) return null; await ensureSchema(env.HUB_DB); return loadRooms(env); }),
    // Movies the hub keeps (v2.8); null without a database or before the first picks.
    movies: once(async () => { if (!env.HUB_DB) return null; await ensureSchema(env.HUB_DB); return loadMovies(env); }),
    // The trips the hub keeps (v2.9); null without a database or before it has any.
    tripRecords: once(async () => { if (!env.HUB_DB) return null; await ensureSchema(env.HUB_DB); return loadTrips(env); }),
    // A trip's own shared album (its album link), by link.
    album: link => (albums[link] ??= albumPhotosFor(link)),
    image: cardId => `${url.origin}${base}/image/${encodeURIComponent(cardId)}`,
  };
  return ctx;
}

export async function handleStream(request, env, hub, loadEvents, path, base = "/api/stream") {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);

  const image = path.match(/^\/image\/(.+)$/);
  if (image) return streamImage(env, hub, decodeURIComponent(image[1]), url.origin, url.searchParams.get("v"));
  if (path !== "") return json({ error: "Not found" }, 404);

  const viewId = (url.searchParams.get("view") || "family").toLowerCase();
  const view = hub.members.find(m => m.id === viewId) || null;
  if (!view && viewId !== "family") {
    return json({ error: `Unknown view "${viewId}". Use "family" or one of: ${hub.members.map(m => m.id).join(", ")}` }, 400);
  }
  const output = url.searchParams.get("output") || null;
  const cfg = resolveConfig(hub, output);
  const only = (url.searchParams.get("components") || "").split(",").map(s => s.trim()).filter(Boolean);
  const unknown = only.filter(c => !byId[c]);
  if (unknown.length) {
    return json({ error: `Unknown component "${unknown[0]}". Known: ${Object.keys(byId).join(", ")}` }, 400);
  }
  if (only.length) cfg.components = only;
  if (url.searchParams.get("all") === "1") {
    cfg.photosBetween = 0;
    cfg.max = Object.fromEntries(Object.keys(byId).map(c => [c, Infinity]));
  }
  const ctx = makeContext({ request, env, hub, loadEvents, view, base });

  const wanted = new Set(cfg.components);
  if (cfg.photosBetween > 0) wanted.add("photos");
  const cardsBy = {};
  const errors = [];
  await Promise.all([...wanted].map(async id => {
    try {
      cardsBy[id] = await byId[id].cards(ctx);
    } catch (err) {
      cardsBy[id] = [];
      errors.push({ component: id, error: err.message });
    }
  }));

  const cards = compose({ cfg, cardsBy, photoPool: cardsBy.photos ?? [], turn: ctx.turn });
  return json({
    title: hub.title,
    view: view ? { id: view.id, name: view.name, color: view.color } : null,
    output,
    members: hub.members.map(({ id, name, color }) => ({ id, name, color })),
    hubUrl: ctx.hubUrl,
    generatedAt: ctx.now.toISOString(),
    cards,
    ...(errors.length ? { errors } : {}),
  });
}

async function streamImage(env, hub, cardId, origin, version = null) {
  const [component, ...rest] = cardId.split(":");
  const id = rest.join(":");
  // pet-portraits:<pet id>?v=<photo id> — that photo, or the pet's newest.
  if (component === "pet-portraits" && id) {
    const pet = (await loadPets(env))?.find(p => p.id === id);
    const photo = pet?.photos.find(p => p.id === version) ?? pet?.photos[0];
    return photo ? photoResponse(env, photo.id) : json({ error: `No photo of "${id}"` }, 404);
  }
  if (component === "photos" && id) return photoById(hub, id);
  // escape-rooms:<room id> — the room's picture, from its site.
  if (component === "escape-rooms" && id) return roomImage(env, id);
  // movies:<movie id> — its poster, from its site.
  if (component === "movies" && id) return movieImage(env, id);
  // trip-photo:<trip id>:<photo id> — a photo from that trip's shared album.
  if (component === "trip-photo" && id) {
    const [tripId, ...photo] = id.split(":");
    const album = await tripAlbumLink(env, tripId);
    if (!album || !photo.length) return json({ error: `No album for trip "${tripId}"` }, 404);
    return photoFromAlbum(album, photo.join(":"));
  }
  if ((component === "trips" || component === "past-trips") && id) {
    return heroResponse(env, hub.tripApps.find(t => t.trip === id), origin);
  }
  return json({ error: `No image for card "${cardId}"` }, 404);
}
