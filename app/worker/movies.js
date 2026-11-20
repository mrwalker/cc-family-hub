/**
 * Movies and shows worth seeing, kept by the hub (D1, HUB_DB). Most are picked once a
 * month by the family's assistant and handed over by the pipeline
 * (`npx family-hub movies publish <file>`); each gets a poster from its link
 * (link-image.js). Everyone marks which they want to see, and which they've seen.
 *
 *   movie: { id, title, kind (movie|show), releaseDate?, where? ("theaters" or a service),
 *            format? (IMAX, 70mm…), blurb?, forWhom?, url?, imageUrl? (given, or found on url), source (agent|family),
 *            batch?, archived, marks: { member: "want" | "seen" } }
 *
 *   GET  /api/household/movies                 → the page's snapshot (movies in it)
 *   POST /api/household/movies/:id/mark          { member, mark }   mark: want | seen | null
 *   POST /api/household/movies                   adults: a movie by hand
 *   POST /api/household/movies/:id/image         { imageUrl? }  that poster, or look again
 *   POST /api/household/movies/:id/archive       adults
 *   POST /api/household/movies/picks             the pipeline (PUBLISH_TOKEN): { batch, picks: [...] }
 *   GET  /api/household/movies/history           the pipeline: past picks and marks, by name
 *
 * Marks are the honor system, like chores: anyone in the family marks for anyone (the
 * wall tablet is one sign-in for everyone). Guests and screens only read.
 */

import { findImage, imageVersion } from "./link-image.js";
import { addDays } from "./util.js";

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BATCH_RE = /^\d{4}-\d{2}$/;
const MAX_PICKS = 30;
const MAX_MOVIES = 1000;
const KEEP_MARKED_DAYS = 120;   // a marked movie stays this long after it came out
const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const isWeb = s => typeof s === "string" && /^https?:\/\/[^\s]+$/i.test(s) && s.length <= 500;
const isDate = s => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));

/** "Starfall" (2027) → "mv-starfall-2027". The same movie keeps its id month to month. */
export function movieId(title, year) {
  const slug = String(title).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "movie";
  return `mv-${slug}${year ? `-${year}` : ""}`;
}

export function cleanMovie(c, { id = null } = {}) {
  if (!c || typeof c !== "object") return { error: "expected a movie" };
  const title = text(c.title, 100);
  if (!title) return { error: "title: required" };
  const releaseDate = c.releaseDate ? String(c.releaseDate) : null;
  if (releaseDate && !isDate(releaseDate)) return { error: "releaseDate: YYYY-MM-DD" };
  const url = c.url ? String(c.url).trim() : null;
  if (url && !isWeb(url)) return { error: "url: a web link (https://…)" };
  // The poster itself, when whoever picked it has its link (some sites won't show it to the hub).
  const imageUrl = c.imageUrl ? String(c.imageUrl).trim() : null;
  if (imageUrl && !isWeb(imageUrl)) return { error: "imageUrl: a web link to a picture (https://…)" };
  const movieIdValue = id ?? c.id;
  if (typeof movieIdValue !== "string" || !ID_RE.test(movieIdValue)) return { error: "id: 6–40 letters, digits, - or _" };
  return {
    movie: {
      id: movieIdValue, title, kind: c.kind === "show" ? "show" : "movie", releaseDate,
      where: text(c.where, 40) || null, format: text(c.format, 30) || null,
      blurb: text(c.blurb, 300) || null, forWhom: text(c.forWhom, 100) || null, url, givenImage: imageUrl,
    },
  };
}

const movieFromRow = (r, marks = {}) => ({
  id: r.id, title: r.title, kind: r.kind, releaseDate: r.release_date ?? null, where: r.where_to ?? null,
  format: r.format ?? null, blurb: r.blurb ?? null, forWhom: r.for_whom ?? null, url: r.url ?? null,
  imageUrl: r.image_url ?? null, imageVersion: imageVersion(r.image_url), source: r.source, batch: r.batch ?? null, archived: !!r.archived, marks,
});

/** The movies (newest release first), each with everyone's marks. */
export async function listMovies(db, { archived = false } = {}) {
  const [movies, marks] = await Promise.all([
    db.prepare(`SELECT * FROM movies ${archived ? "" : "WHERE archived = 0"} ORDER BY archived, release_date IS NULL, release_date DESC, title`).all(),
    db.prepare("SELECT movie_id, member, mark FROM movie_marks").all(),
  ]);
  const byMovie = {};
  for (const m of marks.results) (byMovie[m.movie_id] ??= {})[m.member] = m.mark;
  return movies.results.map(r => movieFromRow(r, byMovie[r.id] ?? {}));
}

/** For the stream: the movies, or null when the hub has none yet. */
export async function loadMovies(env) {
  if (!env.HUB_DB) return null;
  const movies = await listMovies(env.HUB_DB);
  return movies.length ? movies : null;
}

function upsert(db, m, { source, batch = null, now, by = null }) {
  return db.prepare(`INSERT INTO movies (id, title, kind, release_date, where_to, format, blurb, for_whom, url, image_url, image_checked_at,
        source, batch, archived, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET title = excluded.title, kind = excluded.kind, release_date = excluded.release_date,
        where_to = excluded.where_to, format = excluded.format, blurb = excluded.blurb, for_whom = excluded.for_whom,
        url = excluded.url, image_url = excluded.image_url, image_checked_at = excluded.image_checked_at,
        batch = COALESCE(excluded.batch, movies.batch), archived = 0, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(m.id, m.title, m.kind, m.releaseDate, m.where, m.format, m.blurb, m.forWhom, m.url, m.imageUrl ?? null, m.imageCheckedAt ?? null,
          source, batch, now, now, by);
}

/** Keeps the poster when the link didn't change; looks for one when it did. */
async function withPosters(movies, existing, { fetcher, now }) {
  const out = [];
  for (let i = 0; i < movies.length; i += 6) {
    out.push(...(await Promise.all(movies.slice(i, i + 6).map(async m => {
      const old = existing[m.id];
      if (m.givenImage) return { ...m, imageUrl: m.givenImage, imageCheckedAt: now };
      if (old && old.url === m.url && old.imageUrl) return { ...m, imageUrl: old.imageUrl, imageCheckedAt: now };
      if (!m.url) return { ...m, imageUrl: old?.imageUrl ?? null, imageCheckedAt: null };
      return { ...m, imageUrl: (await findImage(m.url, { name: m.title, fetcher })) ?? old?.imageUrl ?? null, imageCheckedAt: now };
    }))));
  }
  return out;
}

/**
 * The month's picks from the assistant. Each is added, or updated if it's already here
 * (the same title and year). Last time's picks that aren't picked again are archived,
 * unless they're still to come or someone marked them (and came out less than four
 * months ago). Returns { added, updated, archived, pictured }.
 */
export async function applyPicks(db, body, { today, now, fetcher = fetch }) {
  if (!body || typeof body !== "object") return { error: "expected { batch, picks: [...] }" };
  const batch = BATCH_RE.test(body.batch ?? "") ? body.batch : today.slice(0, 7);
  const list = Array.isArray(body.picks) ? body.picks : [];
  if (!list.length) return { error: "picks: at least one" };
  if (list.length > MAX_PICKS) return { error: `picks: no more than ${MAX_PICKS}` };
  const picks = [];
  const seen = new Set();
  for (const [i, raw] of list.entries()) {
    const year = (raw?.releaseDate && String(raw.releaseDate).slice(0, 4)) || batch.slice(0, 4);
    const { movie, error } = cleanMovie(raw, { id: movieId(raw?.title ?? "", year) });
    if (error) return { error: `picks[${i}].${error}` };
    if (seen.has(movie.id)) continue;
    seen.add(movie.id);
    picks.push(movie);
  }
  const all = await listMovies(db, { archived: true });
  if (all.length + picks.length > MAX_MOVIES) return { error: `No more than ${MAX_MOVIES} movies` };
  const existing = Object.fromEntries(all.map(m => [m.id, m]));
  const pictured = await withPosters(picks, existing, { fetcher, now });
  const keepAfter = addDays(today, -KEEP_MARKED_DAYS);
  const retire = all.filter(m => m.source === "agent" && !m.archived && !seen.has(m.id))
    .filter(m => !(m.releaseDate && m.releaseDate >= today))
    .filter(m => !Object.keys(m.marks).length || (m.releaseDate && m.releaseDate < keepAfter));
  await db.batch([
    ...pictured.map(m => upsert(db, m, { source: existing[m.id]?.source ?? "agent", batch, now, by: "assistant" })),
    ...retire.map(m => db.prepare("UPDATE movies SET archived = 1, updated_at = ?, updated_by = 'assistant' WHERE id = ?").bind(now, m.id)),
  ]);
  return {
    added: pictured.filter(m => !existing[m.id]).length,
    updated: pictured.filter(m => existing[m.id]).length,
    archived: retire.length,
    pictured: pictured.filter(m => m.imageUrl).length,
  };
}

/** For the assistant: past picks with who wanted and saw them, by name, so the next suit. */
export async function moviesHistory(db, hub) {
  const name = id => hub.members.find(m => m.id === id)?.name ?? id;
  const all = await listMovies(db, { archived: true });
  const by = mark => m => Object.entries(m.marks).filter(([, v]) => v === mark).map(([id]) => name(id));
  return {
    members: hub.members.map(m => ({ name: m.name, role: m.role === "child" ? "child" : "adult" })),
    movies: all.slice(0, 200).map(m => ({
      title: m.title, kind: m.kind, releaseDate: m.releaseDate, where: m.where, format: m.format, batch: m.batch,
      source: m.source, archived: m.archived, want: by("want")(m), seen: by("seen")(m),
    })),
    seenCounts: Object.fromEntries(hub.members.map(mem => [mem.name, all.filter(m => m.marks[mem.id] === "seen").length])),
  };
}

/** The /movies routes a family sign-in can use. Returns null for a path that isn't one. */
export async function handleMovieWrite({ db, hub, path, body, viewer, now, answer, json, fetcher = fetch }) {
  const family = viewer.role === "adult" || viewer.role === "child";
  if (!family) return json({ error: "Only the family can mark movies" }, 403);
  const memberIds = new Set(hub.members.map(m => m.id));

  if (path === "/movies") {
    if (viewer.role !== "adult") return json({ error: "Only adults can add movies" }, 403);
    const year = body?.releaseDate ? String(body.releaseDate).slice(0, 4) : null;
    const { movie, error } = cleanMovie(body, { id: body?.id ?? movieId(body?.title ?? "", year) });
    if (error) return json({ error }, 400);
    const all = await listMovies(db, { archived: true });
    const existing = Object.fromEntries(all.map(m => [m.id, m]));
    if (!existing[movie.id] && all.length >= MAX_MOVIES) return json({ error: `No more than ${MAX_MOVIES} movies` }, 400);
    const [pictured] = await withPosters([movie], existing, { fetcher, now });
    await upsert(db, pictured, { source: existing[movie.id]?.source ?? "family", now, by: viewer.id }).run();
    return answer();
  }

  const action = path.match(/^\/movies\/([A-Za-z0-9_-]{6,40})\/(mark|image|archive)$/);
  if (!action) return null;
  const row = await db.prepare("SELECT * FROM movies WHERE id = ?").bind(action[1]).first();
  if (!row) return json({ error: "No such movie" }, 404);

  if (action[2] === "mark") {
    const member = body.member;
    if (!memberIds.has(member)) return json({ error: "member: a family member" }, 400);
    const mark = body.mark ?? null;
    if (mark !== null && mark !== "want" && mark !== "seen") return json({ error: "mark: want, seen, or null" }, 400);
    await (mark
      ? db.prepare(`INSERT INTO movie_marks (movie_id, member, mark, at, by) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (movie_id, member) DO UPDATE SET mark = excluded.mark, at = excluded.at, by = excluded.by`).bind(row.id, member, mark, now, viewer.id)
      : db.prepare("DELETE FROM movie_marks WHERE movie_id = ? AND member = ?").bind(row.id, member)).run();
    return answer();
  }

  if (action[2] === "archive") {
    if (viewer.role !== "adult") return json({ error: "Only adults can archive movies" }, 403);
    await db.prepare("UPDATE movies SET archived = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .bind(body.archived === false ? 0 : 1, now, viewer.id, row.id).run();
    return answer();
  }

  // image: a poster given by hand, or look on the movie's page again.
  let imageUrl;
  if (body.imageUrl) {
    if (!isWeb(body.imageUrl)) return json({ error: "imageUrl: a web link to a picture" }, 400);
    imageUrl = body.imageUrl.trim();
  } else {
    if (!row.url) return json({ error: "This movie has no link to look at" }, 400);
    imageUrl = await findImage(row.url, { name: row.title, fetcher });
  }
  await db.prepare("UPDATE movies SET image_url = ?, image_checked_at = ?, updated_at = ?, updated_by = ? WHERE id = ?")
    .bind(imageUrl, now, now, viewer.id, row.id).run();
  return answer({ found: !!imageUrl });
}
