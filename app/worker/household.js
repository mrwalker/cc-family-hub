/**
 * Household records: the pets' care (and, in later releases, the kids' chores
 * and the upkeep of the house). Stored in D1 (HUB_DB), edited at /household/.
 *
 *   GET  /api/household                    → { enabled, viewer, can, problem, today, areas, pets, tasks, log, serverTime }
 *   POST /api/household/pets                 { id, name, species?, birthday?, notes?, archived? }
 *   POST /api/household/tasks                { id, area, kind, title, petId?, assignee?, dueDate?, dueTime?,
 *                                              repeatEvery?, repeatUnit?, repeatFrom?, leadDays?,
 *                                              provider?, phone?, url?, notes? }
 *   POST /api/household/tasks/:id/done       { doneOn?, note? }
 *   POST /api/household/tasks/:id/undo
 *   POST /api/household/tasks/:id/archive    { archived }
 *   GET  /api/household/export?days=14       → { enabled, today, pets, tasks, recent }   for the planner
 *
 * Every POST answers with the same body as GET, so the page redraws from it.
 *
 * Who may write (access.js works out who's asking): adults manage everything; a
 * child may mark their own chore done and undo it; guests and screens only read.
 * The export is for the pipeline, which proves itself with the PUBLISH_TOKEN
 * bearer (and, behind Access, a service token) rather than a sign-in.
 *
 * Who made a change is taken from the sign-in, never from the request. Writes
 * must be JSON requests, which another site's form can't send.
 *
 * Without the HUB_DB binding none of this is on: GET answers { enabled: false }
 * and the stream has no household cards.
 */

import { ensureSchema } from "./db/migrations.js";
import { identify } from "./access.js";
import { ymd, addDays, daysBetween, json } from "./util.js";
import { timingSafeEqual } from "./data-api.js";

/** Each area's kinds of task, and how many days before it's due a card appears. */
export const AREAS = {
  pets: {
    label: "Pets",
    kinds: {
      vaccination: { label: "Vaccination", lead: 30, emoji: "💉" },
      medication: { label: "Medication", lead: 3, emoji: "💊" },
      grooming: { label: "Grooming", lead: 7, emoji: "✂️" },
      "vet-visit": { label: "Vet visit", lead: 7, emoji: "🩺", appointment: true },
      other: { label: "Other", lead: 7, emoji: "🐾" },
    },
  },
};

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UNITS = ["day", "week", "month", "year"];
const MAX_LEAD_DAYS = 60;
const MAX_PETS = 50;
const MAX_TASKS = 500;
const LOG_ROWS = 100;

const isDate = s => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// ─── Dates ────────────────────────────────────────────────────────────────────

/** `day` plus `n` units. Months and years keep the day of the month, or its last day. */
export function addInterval(day, n, unit) {
  if (unit === "day") return addDays(day, n);
  if (unit === "week") return addDays(day, n * 7);
  const [y, m, d] = day.split("-").map(Number);
  const months = (unit === "year" ? n * 12 : n) + (m - 1);
  const year = y + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, last), 12)).toISOString().slice(0, 10);
}

/**
 * When a repeating task is next due after being done on `doneOn`, or null if it
 * doesn't repeat.
 */
export function nextDue(task, doneOn) {
  if (!task.repeatEvery || !task.repeatUnit) return null;
  if (task.repeatFrom !== "due" || !task.dueDate) return addInterval(doneOn, task.repeatEvery, task.repeatUnit);
  // Keep to the schedule: the first date on it that's after the day it was done.
  let next = task.dueDate;
  for (let k = 1; next <= doneOn && k < 5000; k++) next = addInterval(task.dueDate, k * task.repeatEvery, task.repeatUnit);
  return next;
}

/** How early a task's card appears. */
export function leadDays(task) {
  const lead = task.leadDays ?? AREAS[task.area]?.kinds[task.kind]?.lead ?? 7;
  return Math.min(MAX_LEAD_DAYS, Math.max(0, lead));
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Validates a pet from a client. Returns { pet } or { error }. */
export function cleanPet(c) {
  if (!c || typeof c.id !== "string" || !ID_RE.test(c.id)) return { error: "id: expected 6 to 40 letters, digits, - or _" };
  const name = text(c.name, 40);
  if (!name) return { error: "name: required" };
  if (c.birthday != null && c.birthday !== "" && !isDate(c.birthday)) return { error: "birthday: expected YYYY-MM-DD" };
  return { pet: {
    id: c.id, name,
    species: text(c.species, 30) || null,
    birthday: c.birthday || null,
    notes: text(c.notes, 500) || null,
    archived: c.archived === true,
  } };
}

/** Validates a task from a client. Returns { task } or { error }. */
export function cleanTask(c, { memberIds, petIds }) {
  if (!c || typeof c.id !== "string" || !ID_RE.test(c.id)) return { error: "id: expected 6 to 40 letters, digits, - or _" };
  const area = AREAS[c.area];
  if (!area) return { error: `area: expected one of ${Object.keys(AREAS).join(", ")}` };
  if (!area.kinds[c.kind]) return { error: `kind: expected one of ${Object.keys(area.kinds).join(", ")}` };
  const title = text(c.title, 80);
  if (!title) return { error: "title: required" };

  const task = { id: c.id, area: c.area, kind: c.kind, title };
  task.petId = c.petId || null;
  if (task.petId && !petIds.has(task.petId)) return { error: "petId: no such pet" };
  if (c.area === "pets" && !task.petId) return { error: "petId: required for a pet's task" };
  task.assignee = c.assignee || null;
  if (task.assignee && !memberIds.has(task.assignee)) return { error: "assignee: not a family member" };

  task.dueDate = c.dueDate || null;
  if (task.dueDate && !isDate(task.dueDate)) return { error: "dueDate: expected YYYY-MM-DD" };
  task.dueTime = c.dueTime || null;
  if (task.dueTime && !TIME_RE.test(task.dueTime)) return { error: "dueTime: expected HH:MM" };

  const every = c.repeatEvery == null || c.repeatEvery === "" ? null : Number(c.repeatEvery);
  if (every != null) {
    if (!Number.isInteger(every) || every < 1 || every > 365) return { error: "repeatEvery: expected a whole number from 1 to 365" };
    if (!UNITS.includes(c.repeatUnit)) return { error: `repeatUnit: expected one of ${UNITS.join(", ")}` };
  }
  task.repeatEvery = every;
  task.repeatUnit = every != null ? c.repeatUnit : null;
  task.repeatFrom = c.repeatFrom === "due" ? "due" : "done";

  const lead = c.leadDays == null || c.leadDays === "" ? null : Number(c.leadDays);
  if (lead != null && (!Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_DAYS)) return { error: `leadDays: expected a whole number from 0 to ${MAX_LEAD_DAYS}` };
  task.leadDays = lead;

  task.provider = text(c.provider, 80) || null;
  task.phone = text(c.phone, 30) || null;
  task.url = text(c.url, 300) || null;
  if (task.url && !/^https?:\/\//i.test(task.url)) return { error: "url: expected a link starting with http:// or https://" };
  task.notes = text(c.notes, 500) || null;
  return { task };
}

// ─── Who may do what ──────────────────────────────────────────────────────────

/** Adults add, change and archive. */
export const canManage = viewer => viewer?.role === "adult";

/** Adults complete anything; a child completes their own chore. */
export function canComplete(viewer, task) {
  if (viewer?.role === "adult") return true;
  return viewer?.role === "child" && task.kind === "chore" && task.assignee === viewer.id;
}

// ─── Reading ──────────────────────────────────────────────────────────────────

const TASK_COLUMNS = `t.id, t.area, t.kind, t.title, t.pet_id, t.assignee, t.due_date, t.due_time,
  t.repeat_every, t.repeat_unit, t.repeat_from, t.lead_days, t.provider, t.phone, t.url, t.notes,
  t.archived, t.updated_at, t.updated_by, p.name AS pet_name`;

const taskFromRow = r => ({
  id: r.id, area: r.area, kind: r.kind, title: r.title,
  petId: r.pet_id ?? null, petName: r.pet_name ?? null, assignee: r.assignee ?? null,
  dueDate: r.due_date ?? null, dueTime: r.due_time ?? null,
  repeatEvery: r.repeat_every ?? null, repeatUnit: r.repeat_unit ?? null, repeatFrom: r.repeat_from,
  leadDays: r.lead_days ?? null,
  provider: r.provider ?? null, phone: r.phone ?? null, url: r.url ?? null, notes: r.notes ?? null,
  archived: !!r.archived, updatedAt: r.updated_at, updatedBy: r.updated_by ?? null,
});

const petFromRow = r => ({
  id: r.id, name: r.name, species: r.species ?? null, birthday: r.birthday ?? null,
  notes: r.notes ?? null, archived: !!r.archived,
});

/**
 * The tasks whose cards could show today: not archived, and due within the
 * longest lead time. One indexed query; the stream calls this on every request.
 * Returns null when the hub has no household database.
 */
export async function loadDueTasks(env, today) {
  if (!env.HUB_DB) return null;
  await ensureSchema(env.HUB_DB);
  const { results } = await env.HUB_DB
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN pets p ON p.id = t.pet_id
              WHERE t.archived = 0 AND t.due_date IS NOT NULL AND t.due_date <= ?
              ORDER BY t.due_date, t.due_time, t.title`)
    .bind(addDays(today, MAX_LEAD_DAYS))
    .all();
  return results.map(taskFromRow);
}

async function getTask(db, id) {
  const row = await db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN pets p ON p.id = t.pet_id WHERE t.id = ?`).bind(id).first();
  return row ? taskFromRow(row) : null;
}

async function snapshot(env, hub, who, now) {
  const db = env.HUB_DB;
  const [pets, tasks, log] = await Promise.all([
    db.prepare("SELECT * FROM pets ORDER BY archived, name").all(),
    db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN pets p ON p.id = t.pet_id
                ORDER BY t.archived, t.due_date IS NULL, t.due_date, t.title LIMIT ${MAX_TASKS}`).all(),
    db.prepare(`SELECT l.id, l.task_id, l.done_on, l.done_by, l.note, t.title, t.area
                FROM task_log l JOIN tasks t ON t.id = l.task_id
                ORDER BY l.created_at DESC LIMIT ${LOG_ROWS}`).all(),
  ]);
  return {
    enabled: true,
    viewer: who.viewer,
    can: { manage: canManage(who.viewer) },
    // Why this person can't write, when they can't: for whoever is setting the hub up.
    problem: who.viewer ? null : who.problem,
    today: ymd(new Date(now), hub.timezone),
    areas: AREAS,
    members: hub.members.map(({ id, name, color, role }) => ({ id, name, color, role: role === "child" ? "child" : "adult" })),
    pets: pets.results.map(petFromRow),
    tasks: tasks.results.map(taskFromRow),
    log: log.results.map(r => ({ id: r.id, taskId: r.task_id, title: r.title, area: r.area, doneOn: r.done_on, doneBy: r.done_by ?? null, note: r.note ?? null })),
    serverTime: now,
  };
}

// ─── The planner's export ─────────────────────────────────────────────────────

const EXPORT_DAYS = 14;
const EXPORT_RECENT_DAYS = 30;

/**
 * What the planner needs to know: every pet, each task that's overdue or due in
 * the next `days` days, and what was done in the last 30 days. Names, not ids.
 */
export async function householdExport(env, hub, { now = Date.now(), days = EXPORT_DAYS } = {}) {
  const db = env.HUB_DB;
  const today = ymd(new Date(now), hub.timezone);
  const until = addDays(today, days);
  const name = id => (id ? hub.members.find(m => m.id === id)?.name ?? id : null);
  const [pets, tasks, recent] = await Promise.all([
    db.prepare("SELECT name, species, birthday, notes FROM pets WHERE archived = 0 ORDER BY name").all(),
    db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN pets p ON p.id = t.pet_id
                WHERE t.archived = 0 AND t.due_date IS NOT NULL AND t.due_date <= ?
                ORDER BY t.due_date, t.due_time, t.title`).bind(until).all(),
    db.prepare(`SELECT t.title, t.area, p.name AS pet_name, l.done_on, l.done_by, l.note
                FROM task_log l JOIN tasks t ON t.id = l.task_id LEFT JOIN pets p ON p.id = t.pet_id
                WHERE l.done_on >= ? ORDER BY l.done_on DESC LIMIT ${LOG_ROWS}`).bind(addDays(today, -EXPORT_RECENT_DAYS)).all(),
  ]);
  const every = t => (!t.repeatEvery ? null : t.repeatEvery === 1 ? `every ${t.repeatUnit}` : `every ${t.repeatEvery} ${t.repeatUnit}s`);
  return {
    enabled: true,
    today,
    days,
    pets: pets.results.map(p => ({ name: p.name, species: p.species ?? null, birthday: p.birthday ?? null, notes: p.notes ?? null })),
    tasks: tasks.results.map(taskFromRow).map(t => {
      const daysUntil = daysBetween(today, t.dueDate);
      return {
        area: t.area, kind: t.kind, title: t.title, pet: t.petName, assignee: name(t.assignee),
        dueDate: t.dueDate, dueTime: t.dueTime, daysUntil, overdue: daysUntil < 0, repeats: every(t),
        provider: t.provider, phone: t.phone, notes: t.notes,
      };
    }),
    recent: recent.results.map(r => ({ title: r.title, area: r.area, pet: r.pet_name ?? null, doneOn: r.done_on, doneBy: name(r.done_by), note: r.note ?? null })),
  };
}

async function handleExport(request, env, hub, opts) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!env.PUBLISH_TOKEN) return json({ error: "PUBLISH_TOKEN secret not configured on the Worker" }, 503);
  if (!timingSafeEqual(request.headers.get("Authorization") || "", `Bearer ${env.PUBLISH_TOKEN}`)) {
    return json({ error: "Missing or wrong publish token (Authorization: Bearer …)" }, 401);
  }
  if (!env.HUB_DB) return json({ enabled: false });
  await ensureSchema(env.HUB_DB);
  const asked = parseInt(new URL(request.url).searchParams.get("days") ?? "", 10);
  const days = Number.isFinite(asked) ? Math.min(MAX_LEAD_DAYS, Math.max(1, asked)) : EXPORT_DAYS;
  return json(await householdExport(env, hub, { now: opts.now ?? Date.now(), days }));
}

// ─── The API ──────────────────────────────────────────────────────────────────

export async function handleHousehold(request, env, hub, path, opts = {}) {
  if (path === "/export") return handleExport(request, env, hub, opts);
  if (!env.HUB_DB) {
    if (request.method === "GET" && path === "") return json({ enabled: false });
    return json({ error: "Household records aren't set up on this hub (no HUB_DB database). See docs/getting-started.md" }, 503);
  }
  const db = env.HUB_DB;
  await ensureSchema(db);
  const who = await identify(request, env, hub, opts);
  const now = opts.now ?? Date.now();

  if (request.method === "GET") {
    if (path !== "") return json({ error: "Not found" }, 404);
    return json(await snapshot(env, hub, who, now));
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // Only JSON requests may write. A form on another site can't send one, so it
  // can't make a change with the browser's sign-in.
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) {
    return json({ error: "Send JSON (Content-Type: application/json)" }, 415);
  }
  if (!who.viewer) return json({ error: who.problem }, hub.access ? 403 : 503);

  let body = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw);
  } catch { return json({ error: "Body is not valid JSON" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Body must be a JSON object" }, 400);

  const viewer = who.viewer;
  const forbidden = what => json({ error: `Only adults can ${what}` }, 403);

  if (path === "/pets") {
    if (!canManage(viewer)) return forbidden("add or change pets");
    const { pet, error } = cleanPet(body);
    if (error) return json({ error }, 400);
    const exists = await db.prepare("SELECT id FROM pets WHERE id = ?").bind(pet.id).first();
    if (!exists) {
      const { n } = await db.prepare("SELECT COUNT(*) AS n FROM pets").first();
      if (n >= MAX_PETS) return json({ error: `No more than ${MAX_PETS} pets` }, 400);
    }
    await db.prepare(`INSERT INTO pets (id, name, species, birthday, notes, archived, created_at, updated_at, updated_by)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT (id) DO UPDATE SET name = excluded.name, species = excluded.species,
                        birthday = excluded.birthday, notes = excluded.notes, archived = excluded.archived,
                        updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(pet.id, pet.name, pet.species, pet.birthday, pet.notes, pet.archived ? 1 : 0, now, now, viewer.id).run();
    return json(await snapshot(env, hub, who, now));
  }

  if (path === "/tasks") {
    if (!canManage(viewer)) return forbidden("add or change tasks");
    const pets = await db.prepare("SELECT id FROM pets").all();
    const { task, error } = cleanTask(body, {
      memberIds: new Set(hub.members.map(m => m.id)),
      petIds: new Set(pets.results.map(p => p.id)),
    });
    if (error) return json({ error }, 400);
    const exists = await db.prepare("SELECT id FROM tasks WHERE id = ?").bind(task.id).first();
    if (!exists) {
      const { n } = await db.prepare("SELECT COUNT(*) AS n FROM tasks").first();
      if (n >= MAX_TASKS) return json({ error: `No more than ${MAX_TASKS} tasks. Archive some first` }, 400);
    }
    await db.prepare(`INSERT INTO tasks (id, area, kind, title, pet_id, assignee, due_date, due_time, repeat_every, repeat_unit,
                        repeat_from, lead_days, provider, phone, url, notes, archived, created_at, created_by, updated_at, updated_by)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
                      ON CONFLICT (id) DO UPDATE SET area = excluded.area, kind = excluded.kind, title = excluded.title,
                        pet_id = excluded.pet_id, assignee = excluded.assignee, due_date = excluded.due_date,
                        due_time = excluded.due_time, repeat_every = excluded.repeat_every, repeat_unit = excluded.repeat_unit,
                        repeat_from = excluded.repeat_from, lead_days = excluded.lead_days, provider = excluded.provider,
                        phone = excluded.phone, url = excluded.url, notes = excluded.notes,
                        updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(task.id, task.area, task.kind, task.title, task.petId, task.assignee, task.dueDate, task.dueTime,
            task.repeatEvery, task.repeatUnit, task.repeatFrom, task.leadDays, task.provider, task.phone, task.url,
            task.notes, now, viewer.id, now, viewer.id).run();
    return json(await snapshot(env, hub, who, now));
  }

  const action = path.match(/^\/tasks\/([A-Za-z0-9_-]{6,40})\/(done|undo|archive)$/);
  if (!action) return json({ error: "Not found" }, 404);
  const task = await getTask(db, action[1]);
  if (!task) return json({ error: "No such task" }, 404);

  if (action[2] === "archive") {
    if (!canManage(viewer)) return forbidden("archive tasks");
    await db.prepare("UPDATE tasks SET archived = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .bind(body.archived === false ? 0 : 1, now, viewer.id, task.id).run();
    return json(await snapshot(env, hub, who, now));
  }

  if (!canComplete(viewer, task)) return json({ error: "You can only mark your own chores done" }, 403);

  if (action[2] === "done") {
    if (task.archived) return json({ error: "This task is archived" }, 400);
    const today = ymd(new Date(now), hub.timezone);
    const doneOn = body.doneOn || today;
    if (!isDate(doneOn) || doneOn > today) return json({ error: "doneOn: expected a date (YYYY-MM-DD) that isn't in the future" }, 400);
    const next = nextDue(task, doneOn);
    await db.batch([
      db.prepare("INSERT INTO task_log (id, task_id, done_on, done_by, note, due_before, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), task.id, doneOn, viewer.id, text(body.note, 200) || null, task.dueDate, now),
      // A repeating task moves to its next date; a one-off is finished.
      next
        ? db.prepare("UPDATE tasks SET due_date = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(next, now, viewer.id, task.id)
        : db.prepare("UPDATE tasks SET archived = 1, updated_at = ?, updated_by = ? WHERE id = ?").bind(now, viewer.id, task.id),
    ]);
    return json(await snapshot(env, hub, who, now));
  }

  // undo: take back the last time it was done.
  const last = await db.prepare("SELECT id, due_before FROM task_log WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(task.id).first();
  if (!last) return json({ error: "This task hasn't been marked done" }, 400);
  await db.batch([
    db.prepare("DELETE FROM task_log WHERE id = ?").bind(last.id),
    db.prepare("UPDATE tasks SET due_date = ?, archived = 0, updated_at = ?, updated_by = ? WHERE id = ?")
      .bind(last.due_before ?? null, now, viewer.id, task.id),
  ]);
  return json(await snapshot(env, hub, who, now));
}
