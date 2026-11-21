/**
 * Questions for the family's assistant from the hub page and trip apps, its answers, and
 * the notes it leaves (D1, inbox_messages). The assistant lives in the family's chat; a
 * script on its machine polls for new questions, posts each in the channel its scope maps
 * to (hub.agent.channels), and hands the answer back.
 *
 *   message  a question or request from someone signed in; status open → claimed → answered
 *   reply    the assistant's answer to one message
 *   note     something the assistant wants everyone to see for a scope (a trip briefing),
 *            until a date
 *
 * Scopes are the channels': "household" and "trip:<id>". The family may ask in any of
 * them; a trip guest only about the trips they're on.
 *
 * Page (signed in; household.js and index.js route these):
 *   GET  /api/household/inbox              → { scopes, threads, notes }
 *   POST /api/household/inbox                { id, scope, body, threadId? }
 *   GET  /api/trip/:appId/inbox            → the same, for that trip only
 *   POST /api/trip/:appId/inbox              { id, body, threadId? }
 * The assistant (agent.js):
 *   GET  /api/agent/inbox?channel=         messages to answer (from an ops channel)
 *   POST /api/agent/inbox/claim              { channel, ids }
 *   POST /api/agent/inbox/:id/reply          { channel, body }
 *   POST /api/agent/notes                    { channel, body, until? }
 */

import { json, ymd, addDays } from "./util.js";

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const MAX_BODY = 1000;
const MAX_NOTE = 600;
const PER_HOUR = 20;
const CLAIM_MS = 15 * 60_000;
const THREADS = 20;

/** The scopes the assistant answers in: { key, label, channel }. */
export function inboxScopes(hub, tripNames = {}) {
  const out = new Map();
  for (const [channel, c] of Object.entries(hub.agent?.channels ?? {})) {
    const key = c.scope === "trip" ? `trip:${c.trip}` : c.scope === "household" ? "household" : null;
    if (key && !out.has(key)) out.set(key, { key, label: c.scope === "trip" ? tripNames[c.trip] ?? c.trip : "Home", channel });
  }
  return [...out.values()];
}

/** The scopes `viewer` may ask in: the family, all of them; a guest, their trips. */
function askable(hub, viewer, scopes) {
  if (viewer.role === "adult" || viewer.role === "child") return scopes;
  return scopes.filter(s => s.key.startsWith("trip:") && hub.tripApps.some(a => `trip:${a.trip}` === s.key && a.players.includes(viewer.id)));
}

const cap = id => String(id).replace(/(^|-)([a-z])/g, (_, s, c) => `${s ? " " : ""}${c.toUpperCase()}`);
const labelFor = (hub, viewer) => hub.members.find(m => m.id === viewer.id)?.name
  ?? Object.values(hub.agent?.names ?? {}).find(p => p.id === viewer.id)?.name ?? cap(viewer.id);

async function tripNames(db) {
  const { results } = await db.prepare("SELECT id, name FROM trips").all();
  return Object.fromEntries(results.map(r => [r.id, r.name]));
}

/** What the page shows: the scopes it may ask in, recent threads there, and current notes. */
export async function pageInbox(db, hub, viewer, now, { only = null } = {}) {
  const scopes = askable(hub, viewer, inboxScopes(hub, await tripNames(db))).filter(s => !only || s.key === only);
  if (!scopes.length) return { scopes: [], threads: [], notes: [] };
  const keys = scopes.map(s => s.key);
  const marks = keys.map(() => "?").join(",");
  const roots = (await db.prepare(`SELECT * FROM inbox_messages WHERE kind = 'message' AND id = thread_id AND scope IN (${marks})
      ORDER BY created_at DESC LIMIT ${THREADS}`).bind(...keys).all()).results;
  const ids = roots.map(r => r.id);
  const rest = ids.length ? (await db.prepare(`SELECT * FROM inbox_messages WHERE thread_id IN (${ids.map(() => "?").join(",")}) AND id != thread_id
      ORDER BY created_at, rowid`).bind(...ids).all()).results : [];
  const today = ymd(new Date(now), hub.timezone);
  const notes = (await db.prepare(`SELECT * FROM inbox_messages WHERE kind = 'note' AND scope IN (${marks}) AND created_at > ? ORDER BY created_at DESC`)
    .bind(...keys, now - 30 * 86_400_000).all()).results
    .filter(n => (n.until ? n.until >= today : n.created_at > now - 2 * 86_400_000));
  const latest = new Map();
  for (const n of notes) if (!latest.has(n.scope)) latest.set(n.scope, n);
  const msg = r => ({ id: r.id, kind: r.kind, by: r.author_label ?? r.author, mine: r.author === viewer.id, body: r.body, at: r.created_at, status: r.status ?? null });
  return {
    scopes: scopes.map(({ key, label }) => ({ key, label })),
    threads: roots.map(r => ({ ...msg(r), scope: r.scope, messages: [msg(r), ...rest.filter(x => x.thread_id === r.id).map(msg)] })),
    notes: [...latest.values()].map(n => ({ scope: n.scope, body: n.body, at: n.created_at, until: n.until })),
    name: hub.agent?.name ?? "Assistant",
  };
}

/**
 * A message from the page. Idempotent by its client-made id, so a phone that sends it
 * twice (offline, then online) asks once. Returns a Response on refusal, else null.
 */
export async function postInbox(db, hub, viewer, body, now, { only = null } = {}) {
  if (!hub.agent) return json({ error: "The assistant isn't set up on this hub" }, 404);
  const id = body?.id;
  if (typeof id !== "string" || !ID_RE.test(id)) return json({ error: "id: 8 to 40 letters, digits, - or _ (made by the page)" }, 400);
  const text = typeof body.body === "string" ? body.body.replace(/[ \t]+/g, " ").trim() : "";
  if (!text) return json({ error: "body: say something" }, 400);
  if (text.length > MAX_BODY) return json({ error: `body: no more than ${MAX_BODY} characters` }, 400);
  const scopes = askable(hub, viewer, inboxScopes(hub));
  const scope = only ?? body.scope;
  if (!scopes.some(s => s.key === scope)) return json({ error: `scope: one of ${scopes.map(s => s.key).join(", ") || "nothing you can ask about"}` }, 403);
  if (await db.prepare("SELECT 1 FROM inbox_messages WHERE id = ?").bind(id).first()) return null;   // sent before
  let thread = id;
  if (body.threadId != null) {
    const root = await db.prepare("SELECT thread_id, scope FROM inbox_messages WHERE id = ?").bind(body.threadId).first();
    if (!root || root.scope !== scope) return json({ error: "threadId: no such conversation here" }, 400);
    thread = root.thread_id;
  }
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM inbox_messages WHERE author = ? AND kind = 'message' AND created_at > ?").bind(viewer.id, now - 3_600_000).first();
  if (n >= PER_HOUR) return json({ error: "That's a lot of questions this hour. Try again later" }, 429);
  await db.prepare(`INSERT INTO inbox_messages (id, thread_id, scope, kind, author, author_label, via, body, status, created_at)
      VALUES (?, ?, ?, 'message', ?, ?, ?, ?, 'open', ?)`)
    .bind(id, thread, scope, viewer.id, labelFor(hub, viewer), only ? "trip-app" : "hub", text, now).run();
  return null;
}

// ─── The assistant's side ─────────────────────────────────────────────────────

/** Messages waiting for an answer (or claimed and not answered in 15 minutes), with what came before. */
export async function agentInbox(db, hub, now) {
  const scopes = inboxScopes(hub, await tripNames(db));
  const { results } = await db.prepare(`SELECT * FROM inbox_messages WHERE kind = 'message'
      AND (status = 'open' OR (status = 'claimed' AND claimed_at < ?)) ORDER BY created_at LIMIT 20`).bind(now - CLAIM_MS).all();
  const out = [];
  for (const m of results) {
    const s = scopes.find(x => x.key === m.scope);
    const earlier = m.thread_id === m.id ? [] : (await db.prepare(`SELECT * FROM inbox_messages WHERE thread_id = ?
        AND rowid < (SELECT rowid FROM inbox_messages WHERE id = ?) ORDER BY rowid DESC LIMIT 10`)
      .bind(m.thread_id, m.id).all()).results.reverse();
    out.push({
      id: m.id, thread: m.thread_id, scope: m.scope, scopeLabel: s?.label ?? m.scope, channel: s?.channel ?? null,
      by: m.author_label ?? m.author, role: hub.members.find(x => x.id === m.author)?.role ?? "guest", via: m.via, body: m.body, at: new Date(m.created_at).toISOString(),
      earlier: earlier.map(e => ({ by: e.kind === "reply" ? hub.agent.name : e.author_label ?? e.author, body: e.body })),
    });
  }
  return out;
}

/** Marks messages taken, so two runs don't answer one. Returns the ids this call got. */
export async function claimInbox(db, ids, now) {
  const mine = (Array.isArray(ids) ? ids : []).filter(id => typeof id === "string" && ID_RE.test(id)).slice(0, 20);
  if (!mine.length) return [];
  const results = await db.batch(mine.map(id => db.prepare(`UPDATE inbox_messages SET status = 'claimed', claimed_at = ? WHERE id = ? AND kind = 'message'
      AND (status = 'open' OR (status = 'claimed' AND claimed_at < ?))`).bind(now, id, now - CLAIM_MS)));
  return mine.filter((_, i) => (results[i].meta?.changes ?? 0) > 0);
}

/** The assistant's answer to one message. */
export async function replyInbox(db, hub, id, text, now) {
  const m = await db.prepare("SELECT * FROM inbox_messages WHERE id = ? AND kind = 'message'").bind(id).first();
  if (!m) return { error: `No message ${id}`, status: 404 };
  const clean = typeof text === "string" ? text.trim() : "";
  if (!clean) return { error: "body: the answer", status: 400 };
  if (clean.length > 4000) return { error: "body: no more than 4000 characters", status: 400 };
  await db.batch([
    db.prepare(`INSERT INTO inbox_messages (id, thread_id, scope, kind, author, author_label, via, body, created_at) VALUES (?, ?, ?, 'reply', 'assistant', ?, 'agent', ?, ?)`)
      .bind(`r-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, m.thread_id, m.scope, hub.agent.name, clean, now),
    db.prepare("UPDATE inbox_messages SET status = 'answered' WHERE id = ?").bind(id),
  ]);
  return { ok: true, thread: m.thread_id };
}

/** A note for a scope's screens, until a date (or for two days). */
export async function postNote(db, hub, scopeKey, text, until, now) {
  const clean = typeof text === "string" ? text.trim() : "";
  if (!clean) return { error: "body: the note", status: 400 };
  if (clean.length > MAX_NOTE) return { error: `body: no more than ${MAX_NOTE} characters; shorten it`, status: 400 };
  if (until != null && !(typeof until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(until))) return { error: "until: YYYY-MM-DD", status: 400 };
  const today = ymd(new Date(now), hub.timezone);
  if (until && (until < today || until > addDays(today, 60))) return { error: "until: today or within 60 days", status: 400 };
  await db.prepare(`INSERT INTO inbox_messages (id, thread_id, scope, kind, author, author_label, via, body, until, created_at) VALUES (?, ?, ?, 'note', 'assistant', ?, 'agent', ?, ?, ?)`)
    .bind(`n-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, "notes", scopeKey, hub.agent.name, clean, until ?? null, now).run();
  return { ok: true };
}
