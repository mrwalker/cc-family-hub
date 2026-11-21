/**
 * The family's assistant: an agent outside the hub (in the family's chat, say) that keeps
 * the hub's records up to date. It proves itself with its own token, AGENT_TOKEN, and
 * says which channel it's working in. The channel decides what it may touch:
 *
 *   family.yaml → hub.agent.channels:   <channel id>: { trip: <trip id> }   that trip only
 *                                       <channel id>: { scope: household }  (or ops, grocery, …)
 *
 * The Worker decides scope and whether a change is applied at once; a request can't.
 * Everything applied is logged with who asked and what undoes it (agent-ops.js).
 *
 *   GET  /api/agent/health                       what's deployed and how fresh the data is
 *                                                (the publish token works here too)
 *   GET  /api/agent/trips?channel=               the trips this channel may see
 *   GET  /api/agent/trip?channel=&trip=          one trip (the channel's own, or `trip`)
 *   GET  /api/agent/facts/trip?channel=&trip=    everything a trip briefing needs
 *   GET  /api/agent/grocery?channel=             the grocery list
 *   GET  /api/agent/log?channel=&limit=          what the assistant changed lately
 *   POST /api/agent/ops                          { op, args, channel, actor: { slack?, name? }, source? }
 *                                                → { status: "applied" | "unchanged", logId?, summary }
 *   POST /api/agent/log/:id/undo                 { channel, actor }
 *
 * The acting person is whoever asked, by their chat id (members/<id>.yaml and
 * hub.guests carry `slack:`) or, when the assistant doesn't have one, by name. One token can't prove which
 * person or channel a request came from: scope guards against a confused assistant,
 * not a stolen token.
 */

import { timingSafeEqual } from "./data-api.js";
import { ensureSchema, SCHEMA_VERSION } from "./db/migrations.js";
import { tripFromRow, listTrips } from "./trip-records.js";
import { tripSummaries } from "./trips.js";
import { listGrocery, sortItems } from "./grocery.js";
import { OPS, UNDO, OpError } from "./agent-ops.js";
import { ymd, addDays, daysBetween, json } from "./util.js";

const CHANNEL_RE = /^[A-Z0-9]{6,20}$/;
const PERSON_RE = /^[A-Z0-9]{6,20}$/;
const LOG_COLUMNS = "id, created_at, scope, channel, op, target, summary, args_json, undo_json, actor, actor_role, actor_label, source";

const bearer = (request, token) => !!token && timingSafeEqual(request.headers.get("Authorization") || "", `Bearer ${token}`);
const newId = () => [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, "0")).join("");

export async function handleAgent(request, env, hub, path, opts = {}) {
  const now = opts.now ?? Date.now();
  try {
    if (path === "/health") {
      if (!bearer(request, env.AGENT_TOKEN) && !bearer(request, env.PUBLISH_TOKEN)) return json({ error: "Missing or wrong token (Authorization: Bearer …)" }, 401);
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return json(await health(env, hub, now));
    }
    if (!env.AGENT_TOKEN) return json({ error: "AGENT_TOKEN secret not configured on the Worker (wrangler secret put AGENT_TOKEN)" }, 503);
    if (!bearer(request, env.AGENT_TOKEN)) return json({ error: "Missing or wrong agent token (Authorization: Bearer …)" }, 401);
    if (!hub.agent) return json({ error: "The assistant isn't set up on this hub: add hub.agent.channels to family.yaml (docs/assistant.md)" }, 503);
    if (!env.HUB_DB) return json({ error: "Household records aren't set up on this hub (no HUB_DB database). See docs/getting-started.md" }, 503);
    const db = env.HUB_DB;
    await ensureSchema(db);

    if (request.method === "GET") {
      const q = new URL(request.url).searchParams;
      const scope = channelScope(hub, q.get("channel"));
      if (path === "/trips") return json({ trips: await visibleTrips(db, scope) });
      if (path === "/trip") return json({ trip: await readTrip(db, hub, scope, q.get("trip")) });
      if (path === "/facts/trip") return json(await tripFacts(env, hub, db, await tripFor(db, hub, scope, q.get("trip"), { read: true }), now));
      if (path === "/grocery") {
        allow(scope, ["grocery", "household", "ops"], "see the grocery list");
        return json({ items: sortItems(await listGrocery(env)).map(({ name, quantity, store, done, addedBy }) => ({ name, quantity, store: store ?? null, done, addedBy: addedBy ?? null })) });
      }
      if (path === "/log") return json({ log: await readLog(db, scope, Number(q.get("limit")) || 20) });
      return json({ error: "Not found" }, 404);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Body is not valid JSON" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Body must be a JSON object" }, 400);
    const scope = channelScope(hub, body.channel);
    const actor = whoAsked(hub, body.actor);

    if (path === "/ops") return json(await runOp({ env, db, hub, now, scope, actor, body }));
    const undo = path.match(/^\/log\/([a-f0-9]{10})\/undo$/);
    if (undo) return json(await undoLogged({ env, db, hub, now, scope, actor, id: undo[1] }));
    return json({ error: "Not found" }, 404);
  } catch (err) {
    if (err instanceof OpError) return json({ error: err.message }, err.status);
    throw err;
  }
}

// ─── Who, and where ───────────────────────────────────────────────────────────

/** The scope of the channel a request names: { kind, trip?, place?, key, channel }. */
function channelScope(hub, channel) {
  if (typeof channel !== "string" || !CHANNEL_RE.test(channel)) {
    throw new OpError("channel: the id of the channel you're working in (like C0123ABCD), not its name");
  }
  const c = hub.agent.channels[channel];
  if (!c) throw new OpError(`Channel ${channel} isn't one of this hub's: an adult adds it under hub.agent.channels in family.yaml`, 403);
  const key = c.scope === "trip" ? `trip:${c.trip}` : c.scope === "place" ? `place:${c.place}` : c.scope;
  return { kind: c.scope, trip: c.trip ?? null, place: c.place ?? null, key, channel };
}

function allow(scope, kinds, what) {
  if (!kinds.includes(scope.kind)) {
    throw new OpError(`This channel (${scope.key}) can't ${what}. That's for a ${kinds.join(" or ")} channel`, 403);
  }
}

/**
 * Who asked: a family member, a trip guest, or someone the hub doesn't know. By their
 * chat id when the assistant has it, else by name (a member's or guest's id or name).
 * Either way it's the assistant's word: the hub can't check it.
 */
function whoAsked(hub, actor) {
  const slack = typeof actor?.slack === "string" && actor.slack ? actor.slack : null;
  const label = typeof actor?.name === "string" ? actor.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (slack && !PERSON_RE.test(slack)) throw new OpError("actor.slack: the person's chat id, like U0123ABCD; or give their name instead");
  if (!slack && !label) throw new OpError("actor: say who asked, by their chat id (like U0123ABCD) or their name");
  const person = (slack && hub.agent.people[slack]) || (label && hub.agent.names?.[label.toLowerCase()]) || null;
  return {
    id: person?.id ?? (slack ? `slack:${slack}` : `name:${label}`),
    role: person?.role ?? "unknown",
    family: person?.role === "adult" || person?.role === "child",
    label: person?.name ?? (label || null),
  };
}

/** The trip a request is about: the channel's own, or the one it names where that's allowed. */
async function tripFor(db, hub, scope, named, { read = false } = {}) {
  const id = typeof named === "string" && named ? named : null;
  if (scope.kind === "trip") {
    if (id && id !== scope.trip) throw new OpError(`This channel is for the trip "${scope.trip}"; it can't touch "${id}"`, 403);
    return scope.trip;
  }
  allow(scope, read ? ["household", "ops"] : ["ops"], read ? "see trips" : "change trips");
  if (!id) {
    const trips = await listTrips(db, { archived: false });
    throw new OpError(`trip: say which trip. The hub has: ${trips.map(t => t.id).join(", ") || "none yet"}`);
  }
  return id;
}

// ─── Reading ──────────────────────────────────────────────────────────────────

const forAssistant = ({ album, mapFor, mapBbox, ...t }) => t;   // never the album link

async function visibleTrips(db, scope) {
  allow(scope, ["trip", "household", "ops"], "see trips");
  const trips = await listTrips(db, { archived: false });
  return trips.filter(t => scope.kind !== "trip" || t.id === scope.trip)
    .map(t => ({ id: t.id, name: t.name, destination: t.destination, startDate: t.startDate, endDate: t.endDate }));
}

async function readTrip(db, hub, scope, named) {
  const id = await tripFor(db, hub, scope, named, { read: true });
  const row = await db.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first();
  if (!row) throw new OpError(`The hub has no trip "${id}". An adult adds it on /household/ › Trips`, 404);
  return forAssistant(tripFromRow(row));
}

const logRow = r => ({
  id: r.id, at: new Date(r.created_at).toISOString(), scope: r.scope, op: r.op, summary: r.summary,
  by: r.actor_label ?? r.actor, undone: !!r.undone_at,
});

async function readLog(db, scope, limit) {
  const n = Math.min(100, Math.max(1, Math.floor(limit)));
  const { results } = scope.kind === "ops"
    ? await db.prepare("SELECT * FROM agent_log ORDER BY created_at DESC LIMIT ?").bind(n).all()
    : await db.prepare("SELECT * FROM agent_log WHERE scope = ? ORDER BY created_at DESC LIMIT ?").bind(scope.key, n).all();
  return results.map(logRow);
}

/**
 * Everything a trip briefing needs, worked out here so the assistant only writes it up:
 * where the trip is in time, today's and tomorrow's plan, who has packed, the quest
 * scores, and what still needs booking.
 *
 * The plan, packing lists and "!" tags come from the trip app's trip-data.js as of the
 * last deploy (app/build.mjs); the dates and lists come from the hub's own trip record.
 */
export async function tripFacts(env, hub, db, id, now) {
  const row = await db.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first();
  const app = hub.tripApps.find(a => a.trip === id) ?? null;
  const s = app?.summary ?? null;
  if (!row && !s) throw new OpError(`The hub has no trip "${id}". An adult adds it on /household/ › Trips`, 404);
  const record = row ? forAssistant(tripFromRow(row)) : null;
  const tz = s?.tz || hub.timezone;
  const today = ymd(new Date(now), tz);
  // The app's dates are what the phones count down to; the record's are what the hub shows.
  const start = s?.start ?? record.startDate, end = s?.end ?? record.endDate;
  const phase = today < start ? "before" : today > end ? "after" : "during";
  const dayPlan = date => {
    const d = s?.days?.find(x => x.date === date);
    return d ? { date, title: d.title, items: d.items } : null;
  };

  const facts = {
    trip: id, name: record?.name ?? s.title, destination: record?.destination ?? s?.resort ?? null,
    timezone: tz, today, start, end, phase,
    daysUntil: phase === "before" ? daysBetween(today, start) : 0,
    ...(phase === "during" ? { day: daysBetween(start, today) + 1 } : {}),
    ...(phase === "after" ? { endedDaysAgo: daysBetween(end, today) } : {}),
    days: daysBetween(start, end) + 1,
    app: app ? { path: app.path } : null,
    record: record && {
      who: record.who, description: record.description,
      ideas: record.ideas, restaurants: record.restaurants.map(r => r.name), activities: record.activities.map(a => a.name),
    },
    datesMismatch: record && s && (record.startDate !== s.start || record.endDate !== s.end)
      ? { record: { start: record.startDate, end: record.endDate }, app: { start: s.start, end: s.end } } : null,
    schedule: s ? { asOf: hub.build?.builtAt ?? null, today: dayPlan(today), tomorrow: dayPlan(addDays(today, 1)) } : null,
    // "!" tags on the plan that are still ahead, and lists nobody has started.
    unbooked: phase === "after" ? [] : (s?.flags ?? []).filter(f => !f.date || f.date >= today),
    empty: record && phase === "before" ? ["restaurants", "activities"].filter(l => !record[l].length) : [],
    packing: [], leaderboard: [], questsDone: 0, questsTotal: 0,
    recentChanges: (await db.prepare("SELECT * FROM agent_log WHERE scope = ? AND undone_at IS NULL ORDER BY created_at DESC LIMIT 5")
      .bind(`trip:${id}`).all()).results.map(logRow),
  };

  if (app && s) {
    // One cached read for every trip's scores (trips.js): never a KV list() of its own.
    const live = (await tripSummaries(env, hub)).find(t => t.id === app.appId);
    if (live) Object.assign(facts, { leaderboard: live.leaderboard, questsDone: live.questsDone, questsTotal: live.questsTotal });
    if (env.TRIP_KV && phase !== "after" && s.packing?.length) {
      facts.packing = await Promise.all(s.members.map(async m => {
        const mine = s.packing.filter(i => !i.who || i.who.includes(m.id)).map(i => i.id);
        const saved = await env.TRIP_KV.get(`trip:${app.appId}:pack:${m.id}`, "json");
        const done = new Set(Array.isArray(saved?.checked) ? saved.checked : []);
        const packed = mine.filter(i => done.has(i)).length;
        return { member: m.id, name: m.name, packed, total: mine.length };
      }));
    }
  }
  return facts;
}

async function health(env, hub, now) {
  const data = {};
  for (const kind of ["plan", "family"]) {
    const { metadata } = env.HUB_DATA ? await env.HUB_DATA.getWithMetadata(`data:${kind}`, "text") : { metadata: null };
    data[kind] = metadata ? { publishedAt: metadata.publishedAt ?? null, bytes: metadata.bytes ?? null } : null;
  }
  let schema = null, lastWriteAt = null, knownTrips = null;
  if (env.HUB_DB) {
    await ensureSchema(env.HUB_DB);
    schema = (await env.HUB_DB.prepare("SELECT MAX(version) AS v FROM schema_migrations").first())?.v ?? 0;
    const last = (await env.HUB_DB.prepare("SELECT MAX(created_at) AS t FROM agent_log").first())?.t;
    lastWriteAt = last ? new Date(last).toISOString() : null;
    knownTrips = new Set((await env.HUB_DB.prepare("SELECT id FROM trips").all()).results.map(r => r.id));
  }
  return {
    ok: true,
    serverTime: new Date(now).toISOString(),
    build: hub.build ?? null,
    schema: { code: SCHEMA_VERSION, db: schema },
    data,
    bindings: { HUB_DATA: !!env.HUB_DATA, TRIP_KV: !!env.TRIP_KV, HUB_DB: !!env.HUB_DB },
    secrets: { PUBLISH_TOKEN: !!env.PUBLISH_TOKEN, AGENT_TOKEN: !!env.AGENT_TOKEN },
    agent: { configured: !!hub.agent, channels: hub.agent ? Object.keys(hub.agent.channels).length : 0, lastWriteAt },
    // A trip app names its trip by id; the hub only knows whether that trip exists once it runs.
    tripApps: hub.tripApps.map(a => ({ trip: a.trip, path: a.path, known: knownTrips ? knownTrips.has(a.trip) : null })),
  };
}

// ─── Changing ─────────────────────────────────────────────────────────────────

async function runOp({ env, db, hub, now, scope, actor, body }) {
  const op = OPS[body.op];
  if (!op) throw new OpError(`op: unknown "${body.op}". Known: ${Object.keys(OPS).join(", ")}`);
  allow(scope, op.scopes, `do "${body.op}"`);
  if (op.family && !actor.family) {
    throw new OpError(`Only a family member can ask for "${body.op}", and the hub doesn't know ${actor.label ?? actor.id} as one. Give a member's name, or their chat id (members/<id>.yaml → slack)`, 403);
  }
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
  const tripId = op.trip ? await tripFor(db, hub, scope, args.trip) : null;
  const id = newId();
  const entry = e => [id, now, tripId ? `trip:${tripId}` : scope.key, scope.channel, body.op, e.target, e.summary,
    JSON.stringify(args), JSON.stringify(e.undo ?? null), actor.id, actor.role, actor.label,
    typeof body.source === "string" ? body.source.slice(0, 40) : null];
  const c = {
    env, db, hub, now, tripId, actor,
    /** A database change and its log line together; false when the change didn't land. */
    async commit(statement, landed, e) {
      const [changed] = await db.batch([
        statement,
        db.prepare(`INSERT INTO agent_log (${LOG_COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${landed.sql})`).bind(...entry(e), ...landed.binds),
      ]);
      return (changed.meta?.changes ?? 0) > 0;
    },
    /** The log line for a change already made outside the database. */
    record: e => db.prepare(`INSERT INTO agent_log (${LOG_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...entry(e)).run(),
  };
  const done = await op.run(c, args);
  return { status: done.status, summary: done.summary, ...(done.status === "applied" ? { logId: id } : {}) };
}

async function undoLogged({ env, db, hub, now, scope, actor, id }) {
  const row = await db.prepare("SELECT * FROM agent_log WHERE id = ?").bind(id).first();
  if (!row) throw new OpError(`No logged change ${id}`, 404);
  if (scope.kind !== "ops" && row.scope !== scope.key) throw new OpError(`Change ${id} was made for ${row.scope}; undo it from that channel`, 403);
  if (row.undone_at) return { status: "unchanged", summary: `Already undone: ${row.summary}` };
  const data = JSON.parse(row.undo_json ?? "null");
  const undo = data && UNDO[data.kind];
  if (!undo) throw new OpError(`Change ${id} can't be undone from here; an adult can change it on the hub`, 409);
  const mark = db.prepare("UPDATE agent_log SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_at IS NULL");
  const change = await undo({ env, db, hub, now, actor }, data);
  if (change) {
    const [changed] = await db.batch([
      change.statement,
      db.prepare(`UPDATE agent_log SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_at IS NULL AND EXISTS (${change.landed.sql})`).bind(now, actor.id, id, ...change.landed.binds),
    ]);
    if (!(changed.meta?.changes > 0)) throw new OpError("Someone changed it at the same moment. Run the same command again", 409);
  } else {
    await mark.bind(now, actor.id, id).run();
  }
  return { status: "applied", summary: `Undone: ${row.summary}` };
}
