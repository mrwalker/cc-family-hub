/**
 * Chores: the kids' jobs, which rotate weekly, and what each job involves and when.
 * Stored in D1 (HUB_DB) beside the household's tasks; routed from household.js.
 *
 * A chore isn't a task. A task waits until it's done; a chore comes round on its
 * schedule and is done, still to do, or missed, and never piles up. Whether it's
 * done is worked out from the schedule and chore_log, so nothing is written when a
 * chore is missed.
 *
 *   job:      { id, name, emoji?, position, archived }
 *   chore:    { id, title, jobIds[], people[], cadence, days[]|null, everyWeeks, anchorWeek?,
 *               time?, timeKind?, seasonFrom?, seasonTo?, askedFor?, notes?, position, archived }
 *             cadence: daily | weekly | as-needed | when-asked
 *   rotation: { people[], anchorWeek, startsOn, direction }   (household_meta "chore_rotation")
 *             In the anchor week people[i] holds the i-th job; each week everyone moves one
 *             job along (direction 1) or back (-1).
 *   swap:     { week, jobId, member }   one job's holder for one week
 *
 *   GET  /api/household/chores?day=        → { enabled, viewer, can, today, chores: state + the day }
 *   POST /api/household/chores               a chore, or { chores: [chore…] }
 *   POST /api/household/chores/jobs          { jobs: [job…] }
 *   POST /api/household/chores/rotation      { people, anchorWeek, startsOn?, direction? }
 *   POST /api/household/chores/swap          { week, jobId, member }   member null: as the rotation says
 *   POST /api/household/chores/:id/ask       { by }   a when-asked chore, by that day (null: not asked)
 *   POST /api/household/chores/:id/done      { day? }  ticks the chore's occurrence on that day
 *   POST /api/household/chores/:id/archive   { archived }
 *   (undo is POST /api/household/undo { actionId }, shared with tasks)
 *
 * Who may write: adults set chores up. Anyone in the family may tick any chore, for
 * anyone (a wall tablet is one sign-in for the whole family); the log keeps whose chore
 * it was and who ticked it. Adults may undo any tick, others their own, that day.
 */

import { ymd, addDays, daysBetween } from "./util.js";
import { ensureSchema } from "./db/migrations.js";

export const CADENCES = ["daily", "weekly", "as-needed", "when-asked"];
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_JOBS = 12;
const MAX_CHORES = 100;
const MAX_PEOPLE = 12;
const UNDO_DAYS = 7;          // how far back a chore can be ticked (yesterday's forgotten tick)
const TOMORROW_FROM = 17 * 60; // from 5 PM, tomorrow's once-a-week chores show as "tomorrow"
const LEAD_MINUTES = 120;     // a timed chore leads its card from two hours before

const isDate = s => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

// ─── Dates ────────────────────────────────────────────────────────────────────

/** 0 = Sunday … 6 = Saturday. */
export const weekday = day => new Date(`${day}T12:00:00Z`).getUTCDay();

/** The first day of `day`'s week, for a week that starts on `startsOn`. */
export function weekOf(day, startsOn = 1) {
  return addDays(day, -((weekday(day) - startsOn + 7) % 7));
}

/** Minutes since midnight in `tz`. */
export function minutesIn(date, tz) {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(date).split(":").map(Number);
  return h * 60 + m;
}

const toMinutes = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

// ─── The rotation ─────────────────────────────────────────────────────────────

/**
 * Who holds each job in the week starting `week`: { jobId: memberId | null }.
 * `jobs` are the active jobs in order.
 */
export function holders(rotation, jobs, swaps, week) {
  const out = {};
  const people = rotation?.people ?? [];
  const n = people.length;
  const k = rotation?.anchorWeek ? Math.floor(daysBetween(weekOf(rotation.anchorWeek, rotation.startsOn ?? 1), week) / 7) : 0;
  const dir = rotation?.direction === -1 ? -1 : 1;
  jobs.forEach((job, j) => { out[job.id] = n ? people[(((j - dir * k) % n) + n) % n] : null; });
  for (const s of swaps ?? []) if (s.week === week && s.jobId in out) out[s.jobId] = s.member;
  return out;
}

/** Whose chore it is that week: its named people, or whoever holds its jobs. */
export function assigneesOf(chore, held) {
  if (chore.people?.length) return [...chore.people];
  return [...new Set((chore.jobIds ?? []).map(id => held[id]).filter(Boolean))];
}

// ─── Schedules ────────────────────────────────────────────────────────────────

export function inSeason(chore, day) {
  if (!chore.seasonFrom || !chore.seasonTo) return true;
  const md = day.slice(5);
  return chore.seasonFrom <= chore.seasonTo
    ? md >= chore.seasonFrom && md <= chore.seasonTo
    : md >= chore.seasonFrom || md <= chore.seasonTo;   // a season across the new year
}

/**
 * The chore's occurrence that `day` belongs to, or null if it has none that day:
 *   { period, anyDay?, dueBy? }
 * period is the day it's for (daily, a set weekday, as-needed), the week's first day
 * (weekly on any day), or the day asked for (when-asked).
 */
export function occurrence(chore, day, startsOn = 1) {
  if (chore.archived || !inSeason(chore, day)) return null;
  if (chore.cadence === "when-asked") return chore.askedFor ? { period: chore.askedFor } : null;
  if (chore.cadence === "as-needed") return { period: day };
  const week = weekOf(day, startsOn);
  if ((chore.everyWeeks ?? 1) > 1) {
    const anchor = weekOf(chore.anchorWeek ?? week, startsOn);
    const weeks = Math.round(daysBetween(anchor, week) / 7);
    if (((weeks % chore.everyWeeks) + chore.everyWeeks) % chore.everyWeeks !== 0) return null;
  }
  const days = chore.days?.length ? chore.days : null;
  if (chore.cadence === "daily") return !days || days.includes(weekday(day)) ? { period: day } : null;
  // weekly: on its day(s), or any day that week.
  if (days) return days.includes(weekday(day)) ? { period: day } : null;
  return { period: week, anyDay: true, dueBy: addDays(week, 6) };
}

/** "at 4:30 PM", "by 8:00 PM", or "". */
export function timeText(chore, locale = "en-US") {
  if (!chore.time) return "";
  const [h, m] = chore.time.split(":").map(Number);
  const t = new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `${chore.timeKind === "by" ? "by" : "at"} ${t}`;
}

/**
 * Each person's chores on `day`, with where each stands. `log` holds the chore_log rows
 * for the week (at least). `minutes` is the time of day now, when `day` is today; null
 * for a day that's over. Returns { day, week, jobs: [{ id, name, emoji, member }],
 * people: [{ id, name, color, jobs[], chores[] }] } with people in rotation order.
 *
 * A chore's status: done, todo, late (past its time, or a when-asked past its day),
 * missed (its day is over), or tomorrow (a once-a-week chore due tomorrow, from 5 PM).
 */
export function dayView(state, day, { minutes = null, members = [], locale = "en-US" } = {}) {
  const startsOn = state.rotation?.startsOn ?? 1;
  const week = weekOf(day, startsOn);
  const jobs = state.jobs.filter(j => !j.archived);
  const held = holders(state.rotation, jobs, state.swaps, week);
  const byId = Object.fromEntries(members.map(m => [m.id, m]));
  const jobName = Object.fromEntries(jobs.map(j => [j.id, j.name]));
  const people = new Map();
  const person = id => {
    if (!people.has(id)) {
      const m = byId[id] ?? { id, name: id };
      people.set(id, { id, name: m.name, color: m.color ?? null, jobs: jobs.filter(j => held[j.id] === id).map(j => j.name), chores: [] });
    }
    return people.get(id);
  };
  for (const id of state.rotation?.people ?? []) person(id);

  const doneRows = (chore, period) => state.log.filter(r => r.choreId === chore.id && r.period === period);
  const over = minutes == null;
  const add = (chore, occ, status, extra = {}) => {
    const rows = doneRows(chore, occ.period);
    const entry = {
      id: chore.id, title: chore.title, cadence: chore.cadence,
      job: (chore.jobIds ?? []).map(id => jobName[id]).filter(Boolean).join(" & ") || null,
      time: chore.time ?? null, timeKind: chore.time ? chore.timeKind ?? "at" : null, when: timeText(chore, locale),
      period: occ.period, status,
      doneAt: rows.length ? rows[rows.length - 1].createdAt : null,
      doneBy: rows.length ? rows[rows.length - 1].doneBy : null,
      actionId: rows.length ? rows[rows.length - 1].actionId : null,
      count: chore.cadence === "as-needed" ? rows.length : null,
      anyDay: !!occ.anyDay || chore.cadence === "when-asked",
      notes: chore.notes ?? null,
      ...extra,
    };
    for (const id of assigneesOf(chore, held)) person(id).chores.push({ ...entry, with: assigneesOf(chore, held).filter(x => x !== id) });
  };

  const tomorrow = addDays(day, 1);
  const tomorrowHeld = holders(state.rotation, jobs, state.swaps, weekOf(tomorrow, startsOn));
  for (const chore of state.chores) {
    if (chore.archived) continue;
    const occ = occurrence(chore, day, startsOn);
    if (occ) {
      const done = doneRows(chore, occ.period).length > 0;
      let status;
      if (chore.cadence === "as-needed") status = "todo";
      else if (done) status = "done";
      else if (chore.cadence === "when-asked") status = day > occ.period ? "late" : "todo";
      else if (occ.anyDay) status = over && day >= occ.dueBy ? "missed" : "todo";
      else if (over) status = "missed";
      else if (chore.time && minutes > toMinutes(chore.time)) status = "late";
      else status = "todo";
      add(chore, occ, status);
      continue;
    }
    // From 5 PM: a once-a-week chore that's due tomorrow (the bins go out in the morning).
    if (!over && minutes >= TOMORROW_FROM && chore.cadence === "weekly" && chore.days?.length) {
      const next = occurrence(chore, tomorrow, startsOn);
      if (next && !doneRows(chore, next.period).length) {
        for (const id of assigneesOf(chore, tomorrowHeld)) {
          person(id).chores.push({
            id: chore.id, title: chore.title, cadence: chore.cadence, job: null, time: chore.time ?? null,
            timeKind: chore.time ? chore.timeKind ?? "at" : null, when: timeText(chore, locale),
            period: next.period, status: "tomorrow", doneAt: null, doneBy: null, actionId: null, count: null, notes: chore.notes ?? null, with: [],
          });
        }
      }
    }
  }

  const ORDER = { late: 0, todo: 1, tomorrow: 3, done: 4, missed: 5 };
  for (const p of people.values()) {
    p.chores.sort((a, b) => {
      // As-needed chores go after the ones with a schedule; timed ones in time order.
      const rank = c => (c.cadence === "as-needed" ? 2 : ORDER[c.status]);
      return rank(a) - rank(b) || (a.time ?? "99").localeCompare(b.time ?? "99") || a.title.localeCompare(b.title);
    });
  }
  return {
    day, week,
    jobs: jobs.map(j => ({ id: j.id, name: j.name, emoji: j.emoji ?? null, member: held[j.id] ?? null })),
    people: [...people.values()],
  };
}

/**
 * The chore to name next on a card: a late one, then one due within two hours, then
 * today's without a time, then later timed ones, then ones that can be done any day
 * this week (or when asked).
 */
export function nextUp(view, minutes = 0) {
  const open = view.people.flatMap(p => p.chores.filter(c => c.status === "late" || c.status === "todo").map(c => ({ ...c, person: p })))
    .filter(c => c.cadence !== "as-needed");
  const at = c => (c.time ? toMinutes(c.time) : 0);
  const score = c => {
    if (c.status === "late") return at(c);
    if (c.anyDay) return 40_000;
    if (!c.time) return 20_000;
    return at(c) - minutes <= LEAD_MINUTES ? 10_000 + at(c) : 30_000 + at(c);
  };
  return open.sort((a, b) => score(a) - score(b))[0] ?? null;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function cleanJob(c, position = 0) {
  if (!c || typeof c !== "object") return { error: "expected a job" };
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) return { error: "id: 6–40 letters, digits, - or _" };
  const name = text(c.name, 40);
  if (!name) return { error: "name: required" };
  return { job: { id: c.id, name, emoji: text(c.emoji, 8) || null, position: Number.isInteger(c.position) ? c.position : position, archived: !!c.archived } };
}

export function cleanChore(c, { memberIds, jobIds, today }) {
  if (!c || typeof c !== "object") return { error: "expected a chore" };
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) return { error: "id: 6–40 letters, digits, - or _" };
  const title = text(c.title, 80);
  if (!title) return { error: "title: required" };
  const cadence = CADENCES.includes(c.cadence) ? c.cadence : null;
  if (!cadence) return { error: `cadence: one of ${CADENCES.join(", ")}` };
  const list = v => (Array.isArray(v) ? [...new Set(v)] : []);
  const chosenJobs = list(c.jobIds);
  if (chosenJobs.some(id => !jobIds.has(id))) return { error: "jobIds: not a job" };
  const people = list(c.people);
  if (people.some(id => !memberIds.has(id))) return { error: "people: not a family member" };
  if (!chosenJobs.length && !people.length) return { error: "a chore needs a job or a person" };
  let days = null;
  if (c.days != null) {
    if (!Array.isArray(c.days) || c.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return { error: "days: weekdays, 0 (Sunday) to 6" };
    days = [...new Set(c.days)].sort();
    if (!days.length || days.length === 7) days = null;
  }
  const everyWeeks = c.everyWeeks == null ? 1 : c.everyWeeks;
  if (!Number.isInteger(everyWeeks) || everyWeeks < 1 || everyWeeks > 8) return { error: "everyWeeks: 1 to 8" };
  if (c.anchorWeek != null && !isDate(c.anchorWeek)) return { error: "anchorWeek: a date (YYYY-MM-DD)" };
  const time = c.time || null;
  if (time && !TIME_RE.test(time)) return { error: "time: HH:MM" };
  const timeKind = time ? (c.timeKind === "by" ? "by" : "at") : null;
  const seasonFrom = c.seasonFrom || null, seasonTo = c.seasonTo || null;
  if (!!seasonFrom !== !!seasonTo) return { error: "season: both a start and an end, or neither" };
  if (seasonFrom && (!MD_RE.test(seasonFrom) || !MD_RE.test(seasonTo))) return { error: "season: MM-DD" };
  const askedFor = c.askedFor || null;
  if (askedFor && (cadence !== "when-asked" || !isDate(askedFor))) return { error: "askedFor: a date, for a when-asked chore" };
  return {
    chore: {
      id: c.id, title, jobIds: people.length ? [] : chosenJobs, people, cadence,
      days: cadence === "daily" || cadence === "weekly" ? days : null,
      everyWeeks: cadence === "weekly" ? everyWeeks : 1,
      anchorWeek: cadence === "weekly" && everyWeeks > 1 ? c.anchorWeek ?? today : null,
      time, timeKind, seasonFrom, seasonTo, askedFor,
      notes: text(c.notes, 300) || null,
      position: Number.isInteger(c.position) ? c.position : 0,
    },
  };
}

export function cleanRotation(c, { memberIds }) {
  if (!c || typeof c !== "object") return { error: "expected a rotation" };
  const people = Array.isArray(c.people) ? c.people : [];
  if (people.length > MAX_PEOPLE) return { error: `people: no more than ${MAX_PEOPLE}` };
  if (people.some(id => !memberIds.has(id)) || new Set(people).size !== people.length) return { error: "people: family members, each once" };
  if (!isDate(c.anchorWeek)) return { error: "anchorWeek: a date (YYYY-MM-DD)" };
  const startsOn = c.startsOn == null ? 1 : c.startsOn;
  if (!Number.isInteger(startsOn) || startsOn < 0 || startsOn > 6) return { error: "startsOn: 0 (Sunday) to 6" };
  return { rotation: { people, anchorWeek: weekOf(c.anchorWeek, startsOn), startsOn, direction: c.direction === -1 ? -1 : 1 } };
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const jobFromRow = r => ({ id: r.id, name: r.name, emoji: r.emoji ?? null, position: r.position, archived: !!r.archived });
const choreFromRow = r => ({
  id: r.id, title: r.title, jobIds: parse(r.job_ids, []), people: parse(r.people, []), cadence: r.cadence,
  days: parse(r.days, null), everyWeeks: r.every_weeks ?? 1, anchorWeek: r.anchor_week ?? null,
  time: r.time ?? null, timeKind: r.time_kind ?? null, seasonFrom: r.season_from ?? null, seasonTo: r.season_to ?? null,
  askedFor: r.asked_for ?? null, notes: r.notes ?? null, position: r.position ?? 0, archived: !!r.archived,
});
const logFromRow = r => ({
  id: r.id, choreId: r.chore_id, period: r.period, doneFor: parse(r.done_for, []), doneBy: r.done_by ?? null,
  actionId: r.action_id, createdAt: r.created_at,
});

/**
 * Everything about chores, with the log from `since` on (by period). Returns null when
 * nothing's set up (no jobs and no chores), so screens add no cards.
 */
export async function loadChoreState(db, { since }) {
  const [jobs, chores, rotation, swaps, log] = await Promise.all([
    db.prepare("SELECT * FROM chore_jobs ORDER BY archived, position, name").all(),
    db.prepare("SELECT * FROM chores ORDER BY archived, position, title").all(),
    db.prepare("SELECT v FROM household_meta WHERE k = 'chore_rotation'").first(),
    db.prepare("SELECT week, job_id, member FROM chore_swaps WHERE week >= ?").bind(addDays(since, -7)).all(),
    db.prepare("SELECT * FROM chore_log WHERE period >= ? ORDER BY created_at, rowid").bind(addDays(since, -7)).all(),
  ]);
  return {
    jobs: jobs.results.map(jobFromRow),
    chores: chores.results.map(choreFromRow),
    rotation: parse(rotation?.v, null),
    swaps: swaps.results.map(s => ({ week: s.week, jobId: s.job_id, member: s.member })),
    log: log.results.map(logFromRow),
  };
}

const isSetUp = state => state.jobs.some(j => !j.archived) || state.chores.some(c => !c.archived);

/** For the stream: the state and today's view, or null with no chores set up. */
export async function loadChoresToday(env, hub, now = new Date()) {
  if (!env.HUB_DB) return null;
  await ensureSchema(env.HUB_DB);
  const today = ymd(now, hub.timezone);
  const state = await loadChoreState(env.HUB_DB, { since: addDays(today, -7) });
  if (!isSetUp(state)) return null;
  return { state, view: dayView(state, today, { minutes: minutesIn(now, hub.timezone), members: hub.members, locale: hub.locale || "en-US" }) };
}

/** What the page shows: the setup, this week, and the day asked for. */
export async function choresSnapshot(db, hub, { day, today, now }) {
  const state = await loadChoreState(db, { since: addDays(day < today ? day : today, -7) });
  const startsOn = state.rotation?.startsOn ?? 1;
  const view = dayView(state, day, { minutes: day === today ? minutesIn(new Date(now), hub.timezone) : day < today ? null : 0, members: hub.members, locale: hub.locale || "en-US" });
  const thisWeek = weekOf(today, startsOn);
  const nextWeek = addDays(thisWeek, 7);
  const active = state.jobs.filter(j => !j.archived);
  return {
    setUp: isSetUp(state),
    day, today,
    jobs: state.jobs,
    chores: state.chores,
    rotation: state.rotation,
    swaps: state.swaps.filter(s => s.week >= thisWeek),
    holders: { [thisWeek]: holders(state.rotation, active, state.swaps, thisWeek), [nextWeek]: holders(state.rotation, active, state.swaps, nextWeek) },
    view,
    log: state.log.slice(-40).reverse(),
  };
}

/** For the planner: who has which job, each kid's chores today, and this week's misses. */
export async function choresExport(db, hub, { today, now }) {
  const state = await loadChoreState(db, { since: addDays(today, -7) });
  if (!isSetUp(state)) return null;
  const name = id => hub.members.find(m => m.id === id)?.name ?? id;
  const opts = { members: hub.members, locale: hub.locale || "en-US" };
  const view = dayView(state, today, { ...opts, minutes: minutesIn(new Date(now), hub.timezone) });
  const missed = [];
  for (let d = view.week; d < today; d = addDays(d, 1)) {
    for (const p of dayView(state, d, opts).people) {
      for (const c of p.chores) if (c.status === "missed") missed.push({ person: p.name, chore: c.title, day: d });
    }
  }
  return {
    week: view.week,
    jobs: view.jobs.map(j => ({ job: j.name, member: j.member ? name(j.member) : null })),
    today: view.people.map(p => ({ person: p.name, chores: p.chores.map(c => ({ title: c.title, when: c.when || null, status: c.status })) })),
    missedThisWeek: missed,
  };
}

// ─── Writing ──────────────────────────────────────────────────────────────────

/** May this sign-in take back this tick? Adults always; anyone their own, the same day. */
export function canUndoTick(viewer, row, today, tz) {
  if (viewer?.role === "adult") return true;
  return !!viewer && row.done_by === viewer.id && ymd(new Date(row.created_at), tz) === today;
}

/** Statements that take back chore_log rows (and re-ask a when-asked chore). */
export function undoTickStatements(db, rows, now, viewer) {
  return rows.flatMap(r => [
    db.prepare("DELETE FROM chore_log WHERE id = ?").bind(r.id),
    ...(r.cadence === "when-asked"
      ? [db.prepare("UPDATE chores SET asked_for = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(r.period, now, viewer.id, r.chore_id)]
      : []),
  ]);
}

/**
 * The /chores routes. `who` is the checked sign-in; `answer()` replies with the
 * page's snapshot. Returns null for a path that isn't a chores route.
 */
export async function handleChoreWrite({ db, hub, path, body, viewer, now, today, answer, json }) {
  const adult = viewer.role === "adult";
  const forbidden = what => json({ error: `Only adults can ${what}` }, 403);
  const memberIds = new Set(hub.members.map(m => m.id));

  if (path === "/chores/jobs") {
    if (!adult) return forbidden("change the jobs");
    const list = Array.isArray(body.jobs) ? body.jobs : [];
    if (!list.length) return json({ error: "jobs: expected { jobs: [...] }" }, 400);
    const jobs = [];
    for (const [i, raw] of list.entries()) {
      const { job, error } = cleanJob(raw, i);
      if (error) return json({ error: `jobs[${i}].${error}` }, 400);
      jobs.push(job);
    }
    const { n } = await db.prepare("SELECT COUNT(*) AS n FROM chore_jobs WHERE archived = 0 AND id NOT IN (" + jobs.map(() => "?").join(",") + ")").bind(...jobs.map(j => j.id)).first();
    if (n + jobs.filter(j => !j.archived).length > MAX_JOBS) return json({ error: `No more than ${MAX_JOBS} jobs` }, 400);
    await db.batch(jobs.map(j => db.prepare(`INSERT INTO chore_jobs (id, name, emoji, position, archived, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, emoji = excluded.emoji, position = excluded.position,
          archived = excluded.archived, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(j.id, j.name, j.emoji, j.position, j.archived ? 1 : 0, now, viewer.id)));
    return answer();
  }

  if (path === "/chores") {
    if (!adult) return forbidden("add or change chores");
    const list = Array.isArray(body.chores) ? body.chores : body.id ? [body] : [];
    if (!list.length) return json({ error: "chores: expected a chore, or { chores: [...] }" }, 400);
    if (list.length > MAX_CHORES) return json({ error: `No more than ${MAX_CHORES} chores at once` }, 400);
    const jobRows = await db.prepare("SELECT id FROM chore_jobs").all();
    const known = { memberIds, jobIds: new Set(jobRows.results.map(r => r.id)), today };
    const chores = [];
    for (const [i, raw] of list.entries()) {
      const { chore, error } = cleanChore(raw, known);
      if (error) return json({ error: list.length > 1 ? `chores[${i}].${error}` : error }, 400);
      chores.push(chore);
    }
    const { n } = await db.prepare("SELECT COUNT(*) AS n FROM chores WHERE id NOT IN (" + chores.map(() => "?").join(",") + ")").bind(...chores.map(c => c.id)).first();
    if (n + chores.length > MAX_CHORES) return json({ error: `No more than ${MAX_CHORES} chores. Archive some first` }, 400);
    await db.batch(chores.map(c => db.prepare(`INSERT INTO chores (id, title, job_ids, people, cadence, days, every_weeks, anchor_week,
          time, time_kind, season_from, season_to, asked_for, notes, position, archived, created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET title = excluded.title, job_ids = excluded.job_ids, people = excluded.people,
          cadence = excluded.cadence, days = excluded.days, every_weeks = excluded.every_weeks, anchor_week = excluded.anchor_week,
          time = excluded.time, time_kind = excluded.time_kind, season_from = excluded.season_from, season_to = excluded.season_to,
          asked_for = excluded.asked_for, notes = excluded.notes, position = excluded.position, archived = 0,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(c.id, c.title, JSON.stringify(c.jobIds), JSON.stringify(c.people), c.cadence, c.days ? JSON.stringify(c.days) : null,
            c.everyWeeks, c.anchorWeek, c.time, c.timeKind, c.seasonFrom, c.seasonTo, c.askedFor, c.notes, c.position,
            now, viewer.id, now, viewer.id)));
    return answer();
  }

  if (path === "/chores/rotation") {
    if (!adult) return forbidden("change the rotation");
    const { rotation, error } = cleanRotation(body, { memberIds });
    if (error) return json({ error }, 400);
    await db.prepare("INSERT INTO household_meta (k, v) VALUES ('chore_rotation', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v")
      .bind(JSON.stringify(rotation)).run();
    return answer();
  }

  if (path === "/chores/swap") {
    if (!adult) return forbidden("swap jobs");
    if (!isDate(body.week)) return json({ error: "week: a date (YYYY-MM-DD)" }, 400);
    if (typeof body.jobId !== "string" || !ID_RE.test(body.jobId)) return json({ error: "jobId: required" }, 400);
    const rotation = parse((await db.prepare("SELECT v FROM household_meta WHERE k = 'chore_rotation'").first())?.v, null);
    const week = weekOf(body.week, rotation?.startsOn ?? 1);
    if (body.member == null) {
      await db.prepare("DELETE FROM chore_swaps WHERE week = ? AND job_id = ?").bind(week, body.jobId).run();
    } else {
      if (!memberIds.has(body.member)) return json({ error: "member: not a family member" }, 400);
      await db.prepare("INSERT INTO chore_swaps (week, job_id, member) VALUES (?, ?, ?) ON CONFLICT (week, job_id) DO UPDATE SET member = excluded.member")
        .bind(week, body.jobId, body.member).run();
    }
    return answer();
  }

  const action = path.match(/^\/chores\/([A-Za-z0-9_-]{6,40})\/(done|ask|archive)$/);
  if (!action) return null;
  const row = await db.prepare("SELECT * FROM chores WHERE id = ?").bind(action[1]).first();
  if (!row) return json({ error: "No such chore" }, 404);
  const chore = choreFromRow(row);

  if (action[2] === "archive") {
    if (!adult) return forbidden("archive chores");
    await db.prepare("UPDATE chores SET archived = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .bind(body.archived === false ? 0 : 1, now, viewer.id, chore.id).run();
    return answer();
  }

  if (action[2] === "ask") {
    if (!adult) return forbidden("ask for a chore");
    if (chore.cadence !== "when-asked") return json({ error: "Only a when-asked chore can be asked for" }, 400);
    if (body.by != null && !isDate(body.by)) return json({ error: "by: a date (YYYY-MM-DD), or null" }, 400);
    await db.prepare("UPDATE chores SET asked_for = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(body.by ?? null, now, viewer.id, chore.id).run();
    return answer();
  }

  // done: anyone in the family, for whoever's chore it is (the honor system). Not guests.
  if (viewer.role !== "adult" && viewer.role !== "child") return json({ error: "Only the family can tick chores" }, 403);
  if (chore.archived) return json({ error: "This chore is archived" }, 400);
  const day = body.day ?? today;
  if (!isDate(day) || day > today || daysBetween(day, today) > UNDO_DAYS) {
    return json({ error: `day: a date in the last ${UNDO_DAYS} days` }, 400);
  }
  const state = await loadChoreState(db, { since: addDays(day, -7) });
  const startsOn = state.rotation?.startsOn ?? 1;
  const occ = occurrence(chore, day, startsOn);
  if (!occ) return json({ error: `"${chore.title}" isn't due that day` }, 400);
  if (chore.cadence !== "as-needed" && state.log.some(r => r.choreId === chore.id && r.period === occ.period)) {
    return json({ error: `"${chore.title}" is already done` }, 409);
  }
  const held = holders(state.rotation, state.jobs.filter(j => !j.archived), state.swaps, weekOf(day, startsOn));
  const actionId = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO chore_log (id, chore_id, period, done_for, done_by, action_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), chore.id, occ.period, JSON.stringify(assigneesOf(chore, held)), viewer.id, actionId, now),
    // A when-asked chore is finished once done, until it's asked for again.
    ...(chore.cadence === "when-asked" ? [db.prepare("UPDATE chores SET asked_for = NULL, updated_at = ?, updated_by = ? WHERE id = ?").bind(now, viewer.id, chore.id)] : []),
  ]);
  return answer({ actionId });
}
