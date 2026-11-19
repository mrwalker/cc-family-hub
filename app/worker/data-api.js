/**
 * Published hub data (plan, family, strava), stored in the HUB_DATA KV namespace.
 *
 * The pipeline publishes each kind with an authenticated PUT. The Worker validates
 * it before storing, so a malformed plan can never reach the page. The page loads
 * everything with one synchronous <script src="/api/data.js">, which sets the same
 * window globals the old static data files did.
 *
 *   PUT /api/data/:kind   Authorization: Bearer <PUBLISH_TOKEN>, JSON body
 *                         → 200 { ok, kind, bytes, publishedAt }
 *                         → 400 { error, errors: ["plan.days[2].date: expected YYYY-MM-DD, got \"Nov 20\""] }
 *   GET /api/data/:kind   → { kind, publishedAt, data }   (404 if never published)
 *   GET /api/data.js      → window.PLAN_DATA = …; window.FAMILY_DATA = …; window.STRAVA_DATA = …;
 *
 * Each PUT keeps the previous value at data:<kind>:prev for manual rollback.
 */

import { mergePlanShopping } from "./grocery.js";
import { albumKey } from "./photos.js";

const MAX_BYTES = 1_000_000;

export const DATA_KINDS = {
  plan:   { global: "PLAN_DATA",   validate: validatePlan },
  family: { global: "FAMILY_DATA", validate: validateFamily },
  strava: { global: "STRAVA_DATA", validate: validateStrava },
};

const key = kind => `data:${kind}`;

/** Returns a Response for /api/data… paths, or null if the path isn't ours. */
export async function handleDataApi(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/api/data.js") {
    if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
    return dataScript(env);
  }

  const m = url.pathname.match(/^\/api\/data\/([a-z]+)$/);
  if (!m) return null;
  const kind = m[1];
  if (!DATA_KINDS[kind]) {
    return json({ error: `Unknown kind "${kind}". Expected one of: ${Object.keys(DATA_KINDS).join(", ")}` }, 404);
  }
  if (!env.HUB_DATA) return json({ error: "HUB_DATA KV binding not configured" }, 503);

  if (request.method === "PUT") return putData(request, env, kind);
  if (request.method === "GET") {
    const { value, metadata } = await env.HUB_DATA.getWithMetadata(key(kind), "json");
    if (value == null) return json({ error: `No ${kind} data has been published yet` }, 404);
    return json({ kind, publishedAt: metadata?.publishedAt ?? null, data: forPages(kind, value) });
  }
  return text("Method not allowed", 405);
}

async function putData(request, env, kind) {
  if (!env.PUBLISH_TOKEN) return json({ error: "PUBLISH_TOKEN secret not configured on the Worker" }, 503);
  const auth = request.headers.get("Authorization") || "";
  if (!timingSafeEqual(auth, `Bearer ${env.PUBLISH_TOKEN}`)) {
    return json({ error: "Missing or wrong publish token (Authorization: Bearer …)" }, 401);
  }

  const body = await request.text();
  if (body.length > MAX_BYTES) {
    return json({ error: `Body is ${body.length} bytes; the limit is ${MAX_BYTES}` }, 413);
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return json({ error: `Body is not valid JSON: ${e.message}` }, 400);
  }

  const errors = [];
  DATA_KINDS[kind].validate(data, kind, errors);
  if (errors.length) {
    return json({ error: `${kind} failed validation (${errors.length} problem(s))`, errors: errors.slice(0, 50) }, 400);
  }

  const publishedAt = new Date().toISOString();
  const prev = await env.HUB_DATA.getWithMetadata(key(kind), "text");
  if (prev.value != null) {
    await env.HUB_DATA.put(`${key(kind)}:prev`, prev.value, { metadata: prev.metadata ?? {} });
  }
  await env.HUB_DATA.put(key(kind), body, { metadata: { publishedAt, bytes: body.length } });
  // The plan's shopping items join the shared grocery list. A failure here
  // shouldn't fail the publish: the plan itself is stored.
  let groceryAdded;
  if (kind === "plan") {
    try { groceryAdded = await mergePlanShopping(env, data.shoppingList); } catch (e) { console.error("grocery merge:", e.message); }
  }
  return json({ ok: true, kind, bytes: body.length, publishedAt, ...(groceryAdded != null ? { groceryAdded } : {}) });
}

async function dataScript(env) {
  const parts = ["// Published hub data (see data-api.js)"];
  for (const [kind, { global }] of Object.entries(DATA_KINDS)) {
    const raw = env.HUB_DATA ? await env.HUB_DATA.get(key(kind), "json") : null;
    const stored = raw == null ? null : JSON.stringify(forPages(kind, raw));
    // JSON is valid JS; escape "</" so the payload can't close a <script> element.
    parts.push(stored != null
      ? `window.${global} = ${stored.replace(/<\//g, "<\\/")};`
      : `// ${kind}: no data published yet`);
  }
  return new Response(parts.join("\n"), {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * What pages may see of published data: everything but trips' album links,
 * which stay on the server like the family album's (screens get the photos
 * through /api/stream).
 */
function forPages(kind, value) {
  if (kind !== "family" || !Array.isArray(value?.trips)) return value;
  return { ...value, trips: value.trips.map(t => {
    if (!t || typeof t !== "object" || !("album" in t)) return t;
    const { album, ...rest } = t;
    return { ...rest, hasAlbum: true };
  }) };
}

// ─── Validation ───────────────────────────────────────────────────────────────
// Errors read as "<path>: <problem>" so whoever wrote the data can fix it
// without reading this code.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function typeName(v) {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}
function show(v) {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 40 ? s.slice(0, 37) + "..." : s;
}
function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function need(errors, v, path, type, { optional = false } = {}) {
  if (v === undefined) {
    if (!optional) errors.push(`${path}: required ${type} is missing`);
    return false;
  }
  const actual = typeName(v);
  if (actual !== type) {
    errors.push(`${path}: expected ${type}, got ${actual} ${show(v)}`);
    return false;
  }
  return true;
}
function needDate(errors, v, path, opts) {
  if (need(errors, v, path, "string", opts) && !DATE_RE.test(v)) {
    errors.push(`${path}: expected YYYY-MM-DD, got ${show(v)}`);
  }
}
function needEnum(errors, v, path, allowed) {
  if (need(errors, v, path, "string") && !allowed.includes(v)) {
    errors.push(`${path}: expected one of ${allowed.join("|")}, got ${show(v)}`);
  }
}
function eachObj(errors, arr, path, fn, { optional = true } = {}) {
  if (!need(errors, arr, path, "array", { optional })) return;
  arr.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (isObj(item)) fn(item, p);
    else errors.push(`${p}: expected object, got ${typeName(item)} ${show(item)}`);
  });
}

function validatePlan(d, path, errors) {
  if (!isObj(d)) return errors.push(`${path}: expected object, got ${typeName(d)}`);
  need(errors, d.generatedAt, `${path}.generatedAt`, "string", { optional: true });
  needDate(errors, d.weekStarting, `${path}.weekStarting`);
  need(errors, d.summary, `${path}.summary`, "string");
  eachObj(errors, d.days, `${path}.days`, (day, p) => {
    needDate(errors, day.date, `${p}.date`);
    need(errors, day.notes, `${p}.notes`, "string", { optional: true });
    need(errors, day.logistics, `${p}.logistics`, "string", { optional: true });
  }, { optional: false });
  eachObj(errors, d.actionItems, `${path}.actionItems`, (a, p) => {
    need(errors, a.description, `${p}.description`, "string");
    needEnum(errors, a.priority, `${p}.priority`, ["high", "medium", "low"]);
    need(errors, a.assignedTo, `${p}.assignedTo`, "string", { optional: true });
    needDate(errors, a.dueDate, `${p}.dueDate`, { optional: true });
  });
  eachObj(errors, d.flags, `${path}.flags`, (f, p) => {
    needEnum(errors, f.severity, `${p}.severity`, ["info", "warning", "urgent"]);
    need(errors, f.message, `${p}.message`, "string");
  });
  eachObj(errors, d.enrichedEvents, `${path}.enrichedEvents`, (e, p) => {
    need(errors, e.id, `${p}.id`, "string");
  });
  eachObj(errors, d.shoppingList, `${path}.shoppingList`, () => {});
}

function validateFamily(d, path, errors) {
  if (!isObj(d)) return errors.push(`${path}: expected object, got ${typeName(d)}`);
  eachObj(errors, d.trips, `${path}.trips`, (t, p) => {
    need(errors, t.id, `${p}.id`, "string");
    need(errors, t.name, `${p}.name`, "string");
    needDate(errors, t.startDate, `${p}.startDate`);
    needDate(errors, t.endDate, `${p}.endDate`);
    if (t.album != null && !albumKey(t.album)) {
      errors.push(`${p}.album: expected an iCloud shared album link (https://photos.icloud.com/shared/album/… or https://www.icloud.com/sharedalbum/#…), got ${show(t.album)}`);
    }
  }, { optional: false });
  eachObj(errors, d.escapeRooms, `${path}.escapeRooms`, () => {});
  eachObj(errors, d.movies, `${path}.movies`, () => {});
}

function validateStrava(d, path, errors) {
  if (!isObj(d)) return errors.push(`${path}: expected object, got ${typeName(d)}`);
  if (!need(errors, d.members, `${path}.members`, "object")) return;
  for (const [m, list] of Object.entries(d.members)) {
    need(errors, list, `${path}.members.${m}`, "array");
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function text(body, status) {
  return new Response(body, { status });
}
