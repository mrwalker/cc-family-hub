/**
 * Household appointments on a Google Calendar, both ways.
 *
 *   family.yaml → hub.householdCalendar: "<calendar id>"   shared with the service
 *                 account, with "Make changes to events"
 *
 * Out: after every household change, the hub makes the calendar match: an event for
 * each booked appointment, each stay, and each service visit (the same thing for
 * several pets on one day is one event). Events it no longer wants are deleted.
 *
 * Back: every few minutes (and whenever /household/ loads), the hub reads the events
 * it made that changed since it last looked. An event moved in Google Calendar moves
 * the booking; a deleted one leaves the appointment not booked (a deleted service
 * visit stays off the calendar until its date changes).
 *
 * The hub's events carry extendedProperties.private { hub: "household", hubKey }, and
 * calendar_events remembers what it last wrote for each, so it can tell a change made
 * in Google Calendar from its own.
 *
 * Calendar trouble never fails a save: the reason is logged and shown on the page.
 */

import { AREAS, kindOf, whenOf } from "./household.js";
import { addDays } from "./util.js";

export const PULL_EVERY_MS = 5 * 60_000;
const APPT_MINUTES = 60;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Whether a task belongs on the calendar, and on which day. */
export function onCalendar(task) {
  if (task.archived) return false;
  const kind = kindOf(task);
  if (kind.bookable) return task.booked && !!whenOf(task);
  return !!kind.appointment && !!task.dueDate;
}

function names(tasks) {
  const n = tasks.map(t => t.petName).filter(Boolean);
  if (n.length <= 3) return n.length < 2 ? n[0] ?? "" : `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}`;
  return plural(n.length, "pet");
}

/** "HH:MM" plus `minutes`, as a local date-time on `day` (may run past midnight). */
function later(day, time, minutes) {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const d = addDays(day, Math.floor(total / 1440));
  const t = total % 1440;
  return `${d}T${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}:00`;
}

/**
 * The events the calendar should have, by key. The key is the sorted ids of the
 * tasks an event covers, so it stays the same when the appointment moves.
 */
export function wantedEvents(tasks, { timezone, hubUrl }) {
  const groups = {};
  for (const t of tasks.filter(onCalendar)) {
    const date = whenOf(t);
    const time = (t.booked ? t.apptTime : null) || t.dueTime || "";
    const k = t.groupId ? `${t.groupId}|${date}|${time}|${t.endDate ?? ""}` : t.id;
    (groups[k] ??= []).push(t);
  }
  const out = {};
  for (const list of Object.values(groups)) {
    list.sort((a, b) => a.id.localeCompare(b.id));
    const t = list[0];
    const kind = kindOf(t);
    const date = whenOf(t);
    const time = (t.booked ? t.apptTime : null) || t.dueTime || null;
    const who = names(list);
    const key = list.map(x => x.id).join(",");
    const start = kind.stay && t.endDate ? { date } : time ? { dateTime: `${date}T${time}:00`, timeZone: timezone } : { date };
    const end = kind.stay && t.endDate ? { date: addDays(t.endDate, 1) }
      : time ? { dateTime: later(date, time, APPT_MINUTES), timeZone: timezone } : { date: addDays(date, 1) };
    const lines = [
      who ? `For: ${who}` : null,
      t.placeName ? `At: ${t.placeName}` : null,
      kind.stay && t.endDate && t.apptTime ? `Drop off: ${t.apptTime}` : null,
      t.provider ? `With: ${t.provider}${t.phone ? ` (${t.phone})` : ""}` : null,
      t.url || null,
      t.notes || null,
      "",
      `On the hub: ${hubUrl}household/#${t.area}`,
    ].filter(x => x !== null);
    out[key] = {
      summary: `${kind.emoji ?? ""} ${t.title}${who ? `: ${who}` : ""}${t.placeName ? ` (${t.placeName})` : ""}`.trim(),
      description: lines.join("\n"),
      start, end,
      ...(t.placeAddress ? { location: t.placeAddress } : {}),
      extendedProperties: { private: { hub: "household", hubKey: key } },
    };
  }
  return out;
}

/** What we compare to tell whether an event needs writing: everything we set. */
const fingerprint = e => JSON.stringify([e.summary, e.description, e.start, e.end, e.location ?? null]);
const startOf = e => e?.start?.dateTime ? e.start.dateTime.slice(0, 16) : e?.start?.date ?? null;
const endOf = e => e?.end?.dateTime ? e.end.dateTime.slice(0, 16) : e?.end?.date ?? null;

/**
 * Makes the calendar match the tasks. `google` is calendarClient(env), or a stand-in.
 * Returns { created, updated, deleted }.
 */
export async function pushToCalendar(db, google, calendarId, tasks, opts) {
  const wanted = wantedEvents(tasks, opts);
  const { results } = await db.prepare("SELECT * FROM calendar_events WHERE calendar_id = ?").bind(calendarId).all();
  const have = Object.fromEntries(results.map(r => [r.key, r]));
  const now = Date.now();
  const done = { created: 0, updated: 0, deleted: 0 };
  for (const [key, event] of Object.entries(wanted)) {
    const row = have[key];
    const print = fingerprint(event);
    if (row && row.fingerprint === print) continue;
    // Deleted in Google Calendar: stays off until the appointment changes.
    if (row && !row.event_id && row.start === startOf(event)) continue;
    let saved;
    if (row?.event_id) {
      try { saved = await google.patch(calendarId, row.event_id, event); done.updated++; }
      catch (err) { if (!/ 404| 410/.test(err.message)) throw err; }
    }
    if (!saved) { saved = await google.insert(calendarId, event); done.created++; }
    await db.prepare(`INSERT INTO calendar_events (key, calendar_id, event_id, fingerprint, start, "end", updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT (key) DO UPDATE SET calendar_id = excluded.calendar_id, event_id = excluded.event_id,
                        fingerprint = excluded.fingerprint, start = excluded.start, "end" = excluded."end", updated_at = excluded.updated_at`)
      .bind(key, calendarId, saved.id, print, startOf(event), endOf(event), now).run();
  }
  for (const row of results) {
    if (wanted[row.key]) continue;
    if (row.event_id) { await google.remove(calendarId, row.event_id); done.deleted++; }
    await db.prepare("DELETE FROM calendar_events WHERE key = ?").bind(row.key).run();
  }
  return done;
}

/** "2026-12-10T09:30" → { date, time }; "2026-12-10" → { date, time: null }. */
const split = s => (s && s.length > 10 ? { date: s.slice(0, 10), time: s.slice(11, 16) } : { date: s, time: null });

/**
 * Reads the hub's events that changed in Google Calendar since `since` (ISO), and
 * carries moves and deletions back to the tasks. Returns { moved, unbooked }.
 */
export async function pullFromCalendar(db, google, calendarId, { since, now = Date.now(), who = "calendar" } = {}) {
  const items = await google.list(calendarId, since ? { updatedMin: since } : {});
  const { results } = await db.prepare("SELECT * FROM calendar_events WHERE calendar_id = ?").bind(calendarId).all();
  const byEvent = Object.fromEntries(results.filter(r => r.event_id).map(r => [r.event_id, r]));
  const done = { moved: 0, unbooked: 0 };
  for (const item of items) {
    const row = byEvent[item.id];
    if (!row) continue;
    const ids = row.key.split(",");
    const { results: rows } = await db.prepare(`SELECT id, area, kind, booked FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    if (!rows.length) continue;
    const kind = AREAS[rows[0].area]?.kinds[rows[0].kind] ?? {};
    const stmts = [];
    if (item.status === "cancelled") {
      // Deleted there. A booking is undone; a service visit just stays off the calendar.
      if (kind.bookable) {
        for (const id of ids) stmts.push(db.prepare("UPDATE tasks SET booked = 0, appt_date = NULL, appt_time = NULL, updated_at = ?, updated_by = ? WHERE id = ?").bind(now, who, id));
        stmts.push(db.prepare("DELETE FROM calendar_events WHERE key = ?").bind(row.key));
        done.unbooked++;
      } else {
        stmts.push(db.prepare("UPDATE calendar_events SET event_id = NULL, updated_at = ? WHERE key = ?").bind(now, row.key));
      }
    } else {
      const start = startOf(item), end = endOf(item);
      if (start === row.start && end === row.end) continue;   // ours, or nothing that matters
      const s = split(start);
      for (const id of ids) {
        if (kind.stay) {
          // An all-day stay ends the day before its exclusive end date.
          const last = item.end?.date ? addDays(item.end.date, -1) : split(end).date;
          stmts.push(db.prepare("UPDATE tasks SET booked = 1, appt_date = ?, due_date = ?, end_date = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(s.date, s.date, last, now, who, id));
        } else if (kind.bookable) {
          stmts.push(db.prepare("UPDATE tasks SET booked = 1, appt_date = ?, appt_time = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(s.date, s.time, now, who, id));
        } else {
          stmts.push(db.prepare("UPDATE tasks SET due_date = ?, due_time = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(s.date, s.time, now, who, id));
        }
      }
      // Remember the new times as what the event has, so the next push doesn't move it back.
      stmts.push(db.prepare(`UPDATE calendar_events SET start = ?, "end" = ?, fingerprint = '', updated_at = ? WHERE key = ?`).bind(start, end, now, row.key));
      done.moved++;
    }
    if (stmts.length) await db.batch(stmts);
  }
  return done;
}
