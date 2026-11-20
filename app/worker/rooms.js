/**
 * Escape rooms the family has played, kept by the hub (D1, HUB_DB). Routed from
 * household.js; edited on /household/ (the Escape rooms tab).
 *
 *   room: { id, venue?, room, city?, date?, approxDate?, url?, imageUrl?, who[], solved,
 *           escapeTime?, failNote?, difficulty?, rating?, notes?, archived }
 *
 *   GET  /api/household/rooms                 → { enabled, can, rooms, canImport }
 *   POST /api/household/rooms                   a room (finds its picture when the link changes)
 *   POST /api/household/rooms/:id/image         { imageUrl? }  that picture, or look again
 *   POST /api/household/rooms/:id/archive       { archived }   adults
 *   POST /api/household/rooms/images            look for pictures the rooms don't have yet
 *   POST /api/household/rooms/import            adults, once: the published escape-rooms.yaml list
 *
 * Anyone in the family adds and edits rooms (it's a record of games, and the kids play
 * too); adults archive. Guests and screens only read.
 *
 * Before a family imports its old list, the stream and the hub page show the
 * published one (data:family.escapeRooms), so nothing goes missing in between.
 */

import { findImage } from "./link-image.js";

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROOMS = 500;
const RECHECK_MS = 24 * 3_600_000;   // a room with no picture is looked at again after a day
const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const isWeb = s => typeof s === "string" && /^https?:\/\/[^\s]+$/i.test(s) && s.length <= 500;
const oneToFive = v => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);

export function cleanRoom(c, { memberIds }) {
  if (!c || typeof c !== "object") return { error: "expected a room" };
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) return { error: "id: 6–40 letters, digits, - or _" };
  const room = text(c.room, 80);
  if (!room) return { error: "room: its name is required" };
  const date = c.date ? String(c.date) : null;
  if (date && (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)))) return { error: "date: YYYY-MM-DD" };
  const url = c.url ? String(c.url).trim() : null;
  if (url && !isWeb(url)) return { error: "url: a web link (https://…)" };
  const who = Array.isArray(c.who) ? [...new Set(c.who.filter(id => memberIds.has(id)))] : [];
  return {
    room: {
      id: c.id, room, venue: text(c.venue, 80) || null, city: text(c.city, 60) || null,
      date, approxDate: !!c.approxDate, url, who, solved: !!c.solved,
      escapeTime: text(c.escapeTime, 20) || null, failNote: text(c.failNote, 200) || null,
      difficulty: oneToFive(c.difficulty), rating: oneToFive(c.rating), notes: text(c.notes, 500) || null,
    },
  };
}

export const roomFromRow = r => ({
  id: r.id, room: r.room, venue: r.venue ?? null, city: r.city ?? null, date: r.date ?? null,
  approxDate: !!r.approx_date, url: r.url ?? null, imageUrl: r.image_url ?? null, imageCheckedAt: r.image_checked_at ?? null,
  who: parse(r.who, []), solved: !!r.solved, escapeTime: r.escape_time ?? null, failNote: r.fail_note ?? null,
  difficulty: r.difficulty ?? null, rating: r.rating ?? null, notes: r.notes ?? null, archived: !!r.archived,
});

/** The rooms, newest first. */
export async function listRooms(db, { archived = true } = {}) {
  const { results } = await db.prepare(`SELECT * FROM escape_rooms ${archived ? "" : "WHERE archived = 0"}
    ORDER BY archived, date IS NULL, date DESC, room`).all();
  return results.map(roomFromRow);
}

/** For the stream: the rooms, or null when the hub has none yet (then the published list is used). */
export async function loadRooms(env) {
  if (!env.HUB_DB) return null;
  const rooms = await listRooms(env.HUB_DB, { archived: false });
  return rooms.length ? rooms : null;
}

/** The published list (escape-rooms.yaml, before v2.7), for the import and the fallback. */
async function publishedRooms(env) {
  const family = env.HUB_DATA ? await env.HUB_DATA.get("data:family", "json") : null;
  return Array.isArray(family?.escapeRooms) ? family.escapeRooms.filter(r => r && r.room) : [];
}

/** What the page needs: the rooms, and whether there's an old list to bring in. */
export async function roomsSnapshot(env) {
  const rooms = await listRooms(env.HUB_DB);
  return { rooms, canImport: !rooms.length && (await publishedRooms(env)).length > 0 };
}

function upsert(db, r, viewer, now) {
  return db.prepare(`INSERT INTO escape_rooms (id, venue, room, city, date, approx_date, url, image_url, image_checked_at, who,
        solved, escape_time, fail_note, difficulty, rating, notes, archived, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET venue = excluded.venue, room = excluded.room, city = excluded.city, date = excluded.date,
        approx_date = excluded.approx_date, url = excluded.url, image_url = excluded.image_url,
        image_checked_at = excluded.image_checked_at, who = excluded.who, solved = excluded.solved,
        escape_time = excluded.escape_time, fail_note = excluded.fail_note, difficulty = excluded.difficulty,
        rating = excluded.rating, notes = excluded.notes, archived = 0, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(r.id, r.venue, r.room, r.city, r.date, r.approxDate ? 1 : 0, r.url, r.imageUrl ?? null, r.imageCheckedAt ?? null,
          JSON.stringify(r.who), r.solved ? 1 : 0, r.escapeTime, r.failNote, r.difficulty, r.rating, r.notes,
          now, viewer.id, now, viewer.id);
}

/** Looks for pictures for these rooms, a few at a time. Returns them with imageUrl set where found. */
async function withPictures(rooms, { fetcher, now }) {
  const out = [];
  for (let i = 0; i < rooms.length; i += 6) {
    out.push(...(await Promise.all(rooms.slice(i, i + 6).map(async r =>
      r.url ? { ...r, imageUrl: await findImage(r.url, { name: r.room, fetcher }), imageCheckedAt: now } : r))));
  }
  return out;
}

/**
 * The /rooms routes. Returns null for a path that isn't one. `answer()` replies with the
 * page's snapshot.
 */
export async function handleRoomWrite({ env, db, hub, path, body, viewer, now, answer, json, fetcher = fetch }) {
  const family = viewer.role === "adult" || viewer.role === "child";
  const memberIds = new Set(hub.members.map(m => m.id));
  if (!family) return json({ error: "Only the family can change escape rooms" }, 403);

  if (path === "/rooms") {
    const { room, error } = cleanRoom(body, { memberIds });
    if (error) return json({ error }, 400);
    const old = await db.prepare("SELECT * FROM escape_rooms WHERE id = ?").bind(room.id).first();
    if (!old) {
      const { n } = await db.prepare("SELECT COUNT(*) AS n FROM escape_rooms").first();
      if (n >= MAX_ROOMS) return json({ error: `No more than ${MAX_ROOMS} rooms` }, 400);
    }
    const before = old ? roomFromRow(old) : null;
    let next = { ...room, imageUrl: before?.imageUrl ?? null, imageCheckedAt: before?.imageCheckedAt ?? null };
    // A new or changed link: look for the room's picture on it.
    if (room.url && room.url !== before?.url) [next] = await withPictures([next], { fetcher, now });
    if (!room.url && before?.url) next = { ...next, imageUrl: null, imageCheckedAt: null };
    await upsert(db, next, viewer, now).run();
    return answer();
  }

  if (path === "/rooms/import") {
    if (viewer.role !== "adult") return json({ error: "Only adults can import the old list" }, 403);
    const { n } = await db.prepare("SELECT COUNT(*) AS n FROM escape_rooms").first();
    if (n) return json({ error: "The hub already has escape rooms" }, 409);
    const list = await publishedRooms(env);
    if (!list.length) return json({ error: "There's no published list to import" }, 400);
    const rooms = [];
    const seen = new Set();
    for (const [i, raw] of list.entries()) {
      let id = typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : `room-${String(i).padStart(4, "0")}`;
      if (seen.has(id)) id = `${id.slice(0, 34)}-${i}`;
      seen.add(id);
      const { room, error } = cleanRoom({ ...raw, id }, { memberIds });
      if (error) return json({ error: `escapeRooms[${i}].${error}` }, 400);
      rooms.push(room);
    }
    const pictured = await withPictures(rooms, { fetcher, now });
    await db.batch(pictured.map(r => upsert(db, r, viewer, now)));
    return answer();
  }

  if (path === "/rooms/images") {
    // The rooms with a link and no picture, not looked at in the last day.
    const rows = (await listRooms(db, { archived: false })).filter(r => r.url && !r.imageUrl && (!r.imageCheckedAt || now - r.imageCheckedAt > RECHECK_MS));
    const pictured = await withPictures(rows.slice(0, 30), { fetcher, now });
    if (pictured.length) {
      await db.batch(pictured.map(r => db.prepare("UPDATE escape_rooms SET image_url = ?, image_checked_at = ? WHERE id = ?").bind(r.imageUrl, now, r.id)));
    }
    return answer({ found: pictured.filter(r => r.imageUrl).length, looked: pictured.length });
  }

  const action = path.match(/^\/rooms\/([A-Za-z0-9_-]{6,40})\/(image|archive)$/);
  if (!action) return null;
  const row = await db.prepare("SELECT * FROM escape_rooms WHERE id = ?").bind(action[1]).first();
  if (!row) return json({ error: "No such room" }, 404);
  const room = roomFromRow(row);

  if (action[2] === "archive") {
    if (viewer.role !== "adult") return json({ error: "Only adults can archive rooms" }, 403);
    await db.prepare("UPDATE escape_rooms SET archived = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .bind(body.archived === false ? 0 : 1, now, viewer.id, room.id).run();
    return answer();
  }

  // image: a picture given by hand, or look on the room's page again.
  let imageUrl;
  if (body.imageUrl != null && body.imageUrl !== "") {
    if (!isWeb(body.imageUrl)) return json({ error: "imageUrl: a web link to a picture (https://…)" }, 400);
    imageUrl = body.imageUrl.trim();
  } else {
    if (!room.url) return json({ error: "This room has no link to look at" }, 400);
    imageUrl = await findImage(room.url, { name: room.room, fetcher });
  }
  await db.prepare("UPDATE escape_rooms SET image_url = ?, image_checked_at = ?, updated_at = ?, updated_by = ? WHERE id = ?")
    .bind(imageUrl, now, now, viewer.id, room.id).run();
  return answer({ found: !!imageUrl });
}
