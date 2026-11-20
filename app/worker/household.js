/**
 * Household records: the pets' care and the upkeep of the house (and, in a
 * later release, the kids' chores). Stored in D1 (HUB_DB), edited at /household/.
 *
 *   GET  /api/household                    → { enabled, viewer, can, problem, today, areas, members,
 *                                              pets, places, tasks, log, serverTime }
 *   POST /api/household/pets                 { id, name, species?, birthday?, notes?, archived? }
 *   POST /api/household/places               { id, name, address?, notes?, archived? }
 *   POST /api/household/tasks                a task, or { tasks: [task…], archive: [id…] } in one go
 *        task: { id, area, kind, title, petId?, placeId?, groupId?, assignee?, dueDate?, dueTime?,
 *                repeatEvery?, repeatUnit?, repeatFrom?, leadDays?, booked?, apptDate?, apptTime?,
 *                endDate?, provider?, phone?, url?, notes? }
 *   POST /api/household/tasks/:id/done       { doneOn?, note?, group? }   group: its group's tasks on the same day
 *   POST /api/household/tasks/:id/undo       takes back the last time it was done
 *   POST /api/household/undo                 { actionId }  takes back one action (a group's done)
 *   POST /api/household/tasks/:id/archive    { archived }
 *   GET  /api/household/export?days=14       → { enabled, today, days, pets, places, tasks, recent }   for the planner
 *   GET  /api/household/diag?…               a page reporting that a save didn't arrive (logged; 204)
 *
 * Every POST answers with the same body as GET, so the page redraws from it.
 *
 * A task is due on a date and may repeat. Tasks added together for several pets
 * share a group: each pet keeps its own dates and history, and the group can be
 * done or booked at once. Booking an appointment gives it a date and time of its
 * own; a stay (boarding) also has an end date.
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

/**
 * Each area's kinds of task.
 *   lead:        how many days before it's due a card appears
 *   bookable:    has an appointment to book; until it's booked, the card says "Book …"
 *   appointment: its date is a visit, not a deadline ("Lawn tomorrow", not "due tomorrow")
 *   stay:        runs from one date to another (boarding)
 *   undated:     may have no date at all
 */
export const AREAS = {
  pets: {
    label: "Pets",
    kinds: {
      vaccination: { label: "Vaccination", lead: 30, emoji: "💉", bookable: true },
      medication: { label: "Medication", lead: 3, emoji: "💊" },
      dental: { label: "Teeth cleaning", lead: 30, emoji: "🦷", bookable: true },
      grooming: { label: "Grooming", lead: 14, emoji: "✂️", bookable: true },
      "vet-visit": { label: "Vet visit", lead: 14, emoji: "🩺", bookable: true },
      boarding: { label: "Boarding", lead: 30, emoji: "🏨", bookable: true, stay: true },
      other: { label: "Other", lead: 7, emoji: "🐾" },
    },
  },
  house: {
    label: "House",
    kinds: {
      // Someone comes to the house: lawn, cleaning, pest control.
      service: { label: "Service", lead: 2, emoji: "🧹", appointment: true },
      // Upkeep on a schedule: filters, gutters, smoke detectors.
      maintenance: { label: "Maintenance", lead: 7, emoji: "🔧" },
      // Something to fix. It needn't have a date.
      fix: { label: "Fix", lead: 7, emoji: "🛠️", undated: true },
    },
  },
};

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UNITS = ["day", "week", "month", "year"];
const MAX_LEAD_DAYS = 60;
const MAX_STAY_DAYS = 90;
const MAX_PETS = 50;
const MAX_PLACES = 20;
const MAX_TASKS = 500;
const MAX_BATCH = 50;
const LOG_ROWS = 100;

const isDate = s => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
export const kindOf = task => AREAS[task.area]?.kinds[task.kind] ?? {};

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
  // Keep to the schedule. Doing it counts for the date it was due, early or late,
  // so the next one is the first date on the schedule after both.
  const after = doneOn > task.dueDate ? doneOn : task.dueDate;
  let next = task.dueDate;
  for (let k = 1; next <= after && k < 5000; k++) next = addInterval(task.dueDate, k * task.repeatEvery, task.repeatUnit);
  return next;
}

/** How early a task's card appears. */
export function leadDays(task) {
  const lead = task.leadDays ?? kindOf(task).lead ?? 7;
  return Math.min(MAX_LEAD_DAYS, Math.max(0, lead));
}

/** The date that matters now: a booked appointment's, or else when it's due. */
export const whenOf = task => (task.booked && task.apptDate ? task.apptDate : task.dueDate);

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

/** Validates a place (a house) from a client. Returns { place } or { error }. */
export function cleanPlace(c) {
  if (!c || typeof c.id !== "string" || !ID_RE.test(c.id)) return { error: "id: expected 6 to 40 letters, digits, - or _" };
  const name = text(c.name, 40);
  if (!name) return { error: "name: required" };
  return { place: { id: c.id, name, address: text(c.address, 200) || null, notes: text(c.notes, 500) || null, archived: c.archived === true } };
}

/** Validates a task from a client. Returns { task } or { error }. */
export function cleanTask(c, { memberIds, petIds, placeIds = new Set() }) {
  if (!c || typeof c.id !== "string" || !ID_RE.test(c.id)) return { error: "id: expected 6 to 40 letters, digits, - or _" };
  const area = AREAS[c.area];
  if (!area) return { error: `area: expected one of ${Object.keys(AREAS).join(", ")}` };
  const kind = area.kinds[c.kind];
  if (!kind) return { error: `kind: expected one of ${Object.keys(area.kinds).join(", ")}` };
  const title = text(c.title, 80);
  if (!title) return { error: "title: required" };

  const task = { id: c.id, area: c.area, kind: c.kind, title };
  task.petId = c.area === "pets" ? c.petId || null : null;
  if (task.petId && !petIds.has(task.petId)) return { error: "petId: no such pet" };
  if (c.area === "pets" && !task.petId) return { error: "petId: required for a pet's task" };
  task.placeId = c.area === "house" ? c.placeId || null : null;
  if (task.placeId && !placeIds.has(task.placeId)) return { error: "placeId: no such place" };
  task.groupId = c.groupId || null;
  if (task.groupId && !ID_RE.test(task.groupId)) return { error: "groupId: expected 6 to 40 letters, digits, - or _" };
  task.assignee = c.assignee || null;
  if (task.assignee && !memberIds.has(task.assignee)) return { error: "assignee: not a family member" };

  task.dueDate = c.dueDate || null;
  if (task.dueDate && !isDate(task.dueDate)) return { error: "dueDate: expected YYYY-MM-DD" };
  task.dueTime = c.dueTime || null;
  if (task.dueTime && !TIME_RE.test(task.dueTime)) return { error: "dueTime: expected HH:MM" };

  task.booked = c.booked === true;
  task.apptDate = task.booked ? c.apptDate || null : null;
  task.apptTime = task.booked ? c.apptTime || null : null;
  if (task.apptDate && !isDate(task.apptDate)) return { error: "apptDate: expected YYYY-MM-DD" };
  if (task.apptTime && !TIME_RE.test(task.apptTime)) return { error: "apptTime: expected HH:MM" };
  if (task.booked && !task.apptDate && !task.dueDate) return { error: "apptDate: required when it's booked" };
  task.endDate = kind.stay ? c.endDate || null : null;
  if (task.endDate) {
    const start = task.apptDate || task.dueDate;
    if (!isDate(task.endDate)) return { error: "endDate: expected YYYY-MM-DD" };
    if (!start || task.endDate < start) return { error: "endDate: expected a date on or after the stay starts" };
    if (daysBetween(start, task.endDate) > MAX_STAY_DAYS) return { error: `endDate: a stay can be at most ${MAX_STAY_DAYS} days` };
  }

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

const TASK_COLUMNS = `t.id, t.area, t.kind, t.title, t.pet_id, t.place_id, t.group_id, t.assignee, t.due_date, t.due_time,
  t.repeat_every, t.repeat_unit, t.repeat_from, t.lead_days, t.booked, t.appt_date, t.appt_time, t.end_date,
  t.provider, t.phone, t.url, t.notes, t.archived, t.updated_at, t.updated_by,
  p.name AS pet_name, p.species AS pet_species, pl.name AS place_name`;
const TASK_FROM = `tasks t LEFT JOIN pets p ON p.id = t.pet_id LEFT JOIN places pl ON pl.id = t.place_id`;

const taskFromRow = r => ({
  id: r.id, area: r.area, kind: r.kind, title: r.title,
  petId: r.pet_id ?? null, petName: r.pet_name ?? null, petSpecies: r.pet_species ?? null,
  placeId: r.place_id ?? null, placeName: r.place_name ?? null, groupId: r.group_id ?? null,
  assignee: r.assignee ?? null,
  dueDate: r.due_date ?? null, dueTime: r.due_time ?? null,
  repeatEvery: r.repeat_every ?? null, repeatUnit: r.repeat_unit ?? null, repeatFrom: r.repeat_from,
  leadDays: r.lead_days ?? null,
  booked: !!r.booked, apptDate: r.appt_date ?? null, apptTime: r.appt_time ?? null, endDate: r.end_date ?? null,
  provider: r.provider ?? null, phone: r.phone ?? null, url: r.url ?? null, notes: r.notes ?? null,
  archived: !!r.archived, updatedAt: r.updated_at, updatedBy: r.updated_by ?? null,
});

const petFromRow = r => ({
  id: r.id, name: r.name, species: r.species ?? null, birthday: r.birthday ?? null,
  notes: r.notes ?? null, archived: !!r.archived,
});

const placeFromRow = r => ({ id: r.id, name: r.name, address: r.address ?? null, notes: r.notes ?? null, archived: !!r.archived });

/**
 * The tasks whose cards could show today: not archived, and due (or booked)
 * within the longest lead time. One query; the stream calls this on every
 * request. Returns null when the hub has no household database.
 */
export async function loadDueTasks(env, today) {
  if (!env.HUB_DB) return null;
  await ensureSchema(env.HUB_DB);
  const until = addDays(today, MAX_LEAD_DAYS);
  const { results } = await env.HUB_DB
    .prepare(`SELECT ${TASK_COLUMNS} FROM ${TASK_FROM}
              WHERE t.archived = 0 AND (t.due_date <= ? OR (t.booked = 1 AND t.appt_date <= ?))
              ORDER BY t.due_date, t.due_time, t.title`)
    .bind(until, until)
    .all();
  return results.map(taskFromRow);
}

async function getTask(db, id) {
  const row = await db.prepare(`SELECT ${TASK_COLUMNS} FROM ${TASK_FROM} WHERE t.id = ?`).bind(id).first();
  return row ? taskFromRow(row) : null;
}

async function snapshot(env, hub, who, now) {
  const db = env.HUB_DB;
  const [pets, places, tasks, log] = await Promise.all([
    db.prepare("SELECT * FROM pets ORDER BY archived, name").all(),
    db.prepare("SELECT * FROM places ORDER BY archived, name").all(),
    db.prepare(`SELECT ${TASK_COLUMNS} FROM ${TASK_FROM}
                ORDER BY t.archived, t.due_date IS NULL, t.due_date, t.title LIMIT ${MAX_TASKS}`).all(),
    db.prepare(`SELECT l.id, l.task_id, l.done_on, l.done_by, l.note, l.action_id, t.title, t.area, t.group_id, p.name AS pet_name
                FROM task_log l JOIN tasks t ON t.id = l.task_id LEFT JOIN pets p ON p.id = t.pet_id
                ORDER BY l.created_at DESC, l.rowid DESC LIMIT ${LOG_ROWS}`).all(),
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
    places: places.results.map(placeFromRow),
    tasks: tasks.results.map(taskFromRow),
    log: log.results.map(r => ({
      id: r.id, taskId: r.task_id, actionId: r.action_id ?? null, groupId: r.group_id ?? null,
      title: r.title, area: r.area, pet: r.pet_name ?? null,
      doneOn: r.done_on, doneBy: r.done_by ?? null, note: r.note ?? null,
    })),
    serverTime: now,
  };
}

// ─── The planner's export ─────────────────────────────────────────────────────

const EXPORT_DAYS = 14;
const EXPORT_RECENT_DAYS = 30;

/**
 * What the planner needs to know: every pet and place, each task that's overdue
 * or due (or booked) in the next `days` days, and what was done in the last 30
 * days. Names, not ids.
 */
export async function householdExport(env, hub, { now = Date.now(), days = EXPORT_DAYS } = {}) {
  const db = env.HUB_DB;
  const today = ymd(new Date(now), hub.timezone);
  const until = addDays(today, days);
  const name = id => (id ? hub.members.find(m => m.id === id)?.name ?? id : null);
  const [pets, places, tasks, recent] = await Promise.all([
    db.prepare("SELECT name, species, birthday, notes FROM pets WHERE archived = 0 ORDER BY name").all(),
    db.prepare("SELECT name, address FROM places WHERE archived = 0 ORDER BY name").all(),
    db.prepare(`SELECT ${TASK_COLUMNS} FROM ${TASK_FROM}
                WHERE t.archived = 0 AND (t.due_date <= ? OR (t.booked = 1 AND t.appt_date <= ?))
                ORDER BY t.due_date, t.due_time, t.title`).bind(until, until).all(),
    db.prepare(`SELECT t.title, t.area, p.name AS pet_name, pl.name AS place_name, l.done_on, l.done_by, l.note
                FROM task_log l JOIN tasks t ON t.id = l.task_id LEFT JOIN pets p ON p.id = t.pet_id
                LEFT JOIN places pl ON pl.id = t.place_id
                WHERE l.done_on >= ? ORDER BY l.done_on DESC LIMIT ${LOG_ROWS}`).bind(addDays(today, -EXPORT_RECENT_DAYS)).all(),
  ]);
  const every = t => (!t.repeatEvery ? null : t.repeatEvery === 1 ? `every ${t.repeatUnit}` : `every ${t.repeatEvery} ${t.repeatUnit}s`);
  return {
    enabled: true,
    today,
    days,
    pets: pets.results.map(p => ({ name: p.name, species: p.species ?? null, birthday: p.birthday ?? null, notes: p.notes ?? null })),
    places: places.results.map(p => ({ name: p.name, address: p.address ?? null })),
    tasks: tasks.results.map(taskFromRow).map(t => {
      const daysUntil = daysBetween(today, t.dueDate ?? whenOf(t));
      return {
        area: t.area, kind: t.kind, title: t.title, pet: t.petName, place: t.placeName, assignee: name(t.assignee),
        dueDate: t.dueDate, dueTime: t.dueTime, daysUntil, overdue: daysUntil < 0, repeats: every(t),
        booked: t.booked, apptDate: t.apptDate, apptTime: t.apptTime, endDate: t.endDate,
        provider: t.provider, phone: t.phone, notes: t.notes,
      };
    }),
    recent: recent.results.map(r => ({ title: r.title, area: r.area, pet: r.pet_name ?? null, place: r.place_name ?? null, doneOn: r.done_on, doneBy: name(r.done_by), note: r.note ?? null })),
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

/**
 * The page reports here when a save never reached the hub (the request failed in
 * the browser). Reads always reach the hub, so this one does too; it goes in the
 * Worker's logs, where someone can see what the browser said.
 */
function handleDiag(request) {
  const url = new URL(request.url);
  const field = k => (url.searchParams.get(k) || "").slice(0, 200);
  console.log(JSON.stringify({
    household: "save-failed",
    path: field("path"), error: field("error"), name: field("name"),
    online: field("online"), page: field("page"),
    ua: (request.headers.get("User-Agent") || "").slice(0, 200),
  }));
  return new Response(null, { status: 204 });
}

// ─── Writing ──────────────────────────────────────────────────────────────────

function upsertTask(db, task, viewer, now) {
  return db.prepare(`INSERT INTO tasks (id, area, kind, title, pet_id, place_id, group_id, assignee, due_date, due_time,
                       repeat_every, repeat_unit, repeat_from, lead_days, booked, appt_date, appt_time, end_date,
                       provider, phone, url, notes, archived, created_at, created_by, updated_at, updated_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
                     ON CONFLICT (id) DO UPDATE SET area = excluded.area, kind = excluded.kind, title = excluded.title,
                       pet_id = excluded.pet_id, place_id = excluded.place_id, group_id = excluded.group_id,
                       assignee = excluded.assignee, due_date = excluded.due_date, due_time = excluded.due_time,
                       repeat_every = excluded.repeat_every, repeat_unit = excluded.repeat_unit,
                       repeat_from = excluded.repeat_from, lead_days = excluded.lead_days,
                       booked = excluded.booked, appt_date = excluded.appt_date, appt_time = excluded.appt_time,
                       end_date = excluded.end_date, provider = excluded.provider, phone = excluded.phone,
                       url = excluded.url, notes = excluded.notes, archived = 0,
                       updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(task.id, task.area, task.kind, task.title, task.petId, task.placeId, task.groupId, task.assignee,
          task.dueDate, task.dueTime, task.repeatEvery, task.repeatUnit, task.repeatFrom, task.leadDays,
          task.booked ? 1 : 0, task.apptDate, task.apptTime, task.endDate,
          task.provider, task.phone, task.url, task.notes, now, viewer.id, now, viewer.id);
}

/** What done changes on a task, so undo can put it back. */
const beforeOf = t => ({ dueDate: t.dueDate, booked: t.booked, apptDate: t.apptDate, apptTime: t.apptTime, endDate: t.endDate, archived: t.archived });

/** The statements that mark `task` done on `doneOn`, as part of `actionId`. */
function doneStatements(db, task, { doneOn, note, actionId, viewer, now }) {
  const next = nextDue(task, doneOn);
  return [
    db.prepare(`INSERT INTO task_log (id, task_id, done_on, done_by, note, due_before, action_id, before_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), task.id, doneOn, viewer.id, note, task.dueDate, actionId, JSON.stringify(beforeOf(task)), now),
    // A repeating task moves to its next date, and its booking is used up; a one-off is finished.
    next
      ? db.prepare(`UPDATE tasks SET due_date = ?, booked = 0, appt_date = NULL, appt_time = NULL, end_date = NULL,
                    updated_at = ?, updated_by = ? WHERE id = ?`).bind(next, now, viewer.id, task.id)
      : db.prepare("UPDATE tasks SET archived = 1, updated_at = ?, updated_by = ? WHERE id = ?").bind(now, viewer.id, task.id),
  ];
}

/** The statements that take back one log row. */
function undoStatements(db, row, viewer, now) {
  let before = null;
  try { before = row.before_json ? JSON.parse(row.before_json) : null; } catch { before = null; }
  // Rows from before v2.3 only kept the due date.
  before ??= { dueDate: row.due_before ?? null, booked: false, apptDate: null, apptTime: null, endDate: null, archived: false };
  return [
    db.prepare("DELETE FROM task_log WHERE id = ?").bind(row.id),
    db.prepare(`UPDATE tasks SET due_date = ?, booked = ?, appt_date = ?, appt_time = ?, end_date = ?, archived = ?,
                updated_at = ?, updated_by = ? WHERE id = ?`)
      .bind(before.dueDate ?? null, before.booked ? 1 : 0, before.apptDate ?? null, before.apptTime ?? null,
            before.endDate ?? null, before.archived ? 1 : 0, now, viewer.id, row.task_id),
  ];
}

// ─── The API ──────────────────────────────────────────────────────────────────

export async function handleHousehold(request, env, hub, path, opts = {}) {
  if (path === "/export") return handleExport(request, env, hub, opts);
  if (path === "/diag" && request.method === "GET") return handleDiag(request);
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
  const answer = async () => json(await snapshot(env, hub, who, now));
  const today = ymd(new Date(now), hub.timezone);

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
    return answer();
  }

  if (path === "/places") {
    if (!canManage(viewer)) return forbidden("add or change places");
    const { place, error } = cleanPlace(body);
    if (error) return json({ error }, 400);
    const exists = await db.prepare("SELECT id FROM places WHERE id = ?").bind(place.id).first();
    if (!exists) {
      const { n } = await db.prepare("SELECT COUNT(*) AS n FROM places").first();
      if (n >= MAX_PLACES) return json({ error: `No more than ${MAX_PLACES} places` }, 400);
    }
    await db.prepare(`INSERT INTO places (id, name, address, notes, archived, created_at, updated_at, updated_by)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT (id) DO UPDATE SET name = excluded.name, address = excluded.address,
                        notes = excluded.notes, archived = excluded.archived,
                        updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(place.id, place.name, place.address, place.notes, place.archived ? 1 : 0, now, now, viewer.id).run();
    return answer();
  }

  if (path === "/tasks") {
    if (!canManage(viewer)) return forbidden("add or change tasks");
    // One task, or several at once: a task for each of several pets, a group's edit.
    const list = Array.isArray(body.tasks) ? body.tasks : body.id ? [body] : [];
    const archive = Array.isArray(body.archive) ? body.archive.filter(id => typeof id === "string" && ID_RE.test(id)) : [];
    if (!list.length && !archive.length) return json({ error: "tasks: expected a task, or { tasks: [...] }" }, 400);
    if (list.length + archive.length > MAX_BATCH) return json({ error: `No more than ${MAX_BATCH} tasks at once` }, 400);
    const [pets, places] = await Promise.all([db.prepare("SELECT id FROM pets").all(), db.prepare("SELECT id FROM places").all()]);
    const known = {
      memberIds: new Set(hub.members.map(m => m.id)),
      petIds: new Set(pets.results.map(p => p.id)),
      placeIds: new Set(places.results.map(p => p.id)),
    };
    const tasks = [];
    for (const [i, raw] of list.entries()) {
      const { task, error } = cleanTask(raw, known);
      if (error) return json({ error: list.length > 1 ? `tasks[${i}].${error}` : error }, 400);
      tasks.push(task);
    }
    const { n } = await db.prepare("SELECT COUNT(*) AS n FROM tasks").first();
    if (n + tasks.length > MAX_TASKS) {
      const existing = tasks.length ? (await db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE id IN (${tasks.map(() => "?").join(",")})`).bind(...tasks.map(t => t.id)).first()).n : 0;
      if (n + tasks.length - existing > MAX_TASKS) return json({ error: `No more than ${MAX_TASKS} tasks. Archive some first` }, 400);
    }
    await db.batch([
      ...tasks.map(t => upsertTask(db, t, viewer, now)),
      ...archive.map(id => db.prepare("UPDATE tasks SET archived = 1, updated_at = ?, updated_by = ? WHERE id = ?").bind(now, viewer.id, id)),
    ]);
    return answer();
  }

  if (path === "/undo") {
    const actionId = typeof body.actionId === "string" ? body.actionId : "";
    const { results } = await db.prepare(`SELECT l.*, t.kind, t.assignee FROM task_log l JOIN tasks t ON t.id = l.task_id WHERE l.action_id = ?`).bind(actionId).all();
    if (!results.length) return json({ error: "Nothing to undo" }, 400);
    if (!results.every(r => canComplete(viewer, r))) return json({ error: "You can only undo your own chores" }, 403);
    await db.batch(results.flatMap(r => undoStatements(db, r, viewer, now)));
    return answer();
  }

  const action = path.match(/^\/tasks\/([A-Za-z0-9_-]{6,40})\/(done|undo|archive)$/);
  if (!action) return json({ error: "Not found" }, 404);
  const task = await getTask(db, action[1]);
  if (!task) return json({ error: "No such task" }, 404);

  if (action[2] === "archive") {
    if (!canManage(viewer)) return forbidden("archive tasks");
    await db.prepare("UPDATE tasks SET archived = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .bind(body.archived === false ? 0 : 1, now, viewer.id, task.id).run();
    return answer();
  }

  if (!canComplete(viewer, task)) return json({ error: "You can only mark your own chores done" }, 403);

  if (action[2] === "done") {
    if (task.archived) return json({ error: "This task is archived" }, 400);
    const doneOn = body.doneOn || today;
    if (!isDate(doneOn) || doneOn > today) return json({ error: "doneOn: expected a date (YYYY-MM-DD) that isn't in the future" }, 400);
    // Just this one, or the group's tasks that fall on the same day (one card's worth).
    let targets = [task];
    if (body.group === true && task.groupId) {
      const { results } = await db.prepare(`SELECT ${TASK_COLUMNS} FROM ${TASK_FROM} WHERE t.group_id = ? AND t.archived = 0`).bind(task.groupId).all();
      targets = results.map(taskFromRow).filter(t => whenOf(t) === whenOf(task) && canComplete(viewer, t));
    }
    const actionId = crypto.randomUUID();
    const note = text(body.note, 200) || null;
    await db.batch(targets.flatMap(t => doneStatements(db, t, { doneOn, note, actionId, viewer, now })));
    return answer();
  }

  // undo: take back the last time this task was done (only this task's row).
  const last = await db.prepare("SELECT * FROM task_log WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(task.id).first();
  if (!last) return json({ error: "This task hasn't been marked done" }, 400);
  await db.batch(undoStatements(db, last, viewer, now));
  return answer();
}
