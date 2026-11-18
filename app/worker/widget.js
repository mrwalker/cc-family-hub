/**
 * GET /api/widget?view=<member id>|family — compact data for phone widgets
 * (see app/widgets/). Everything is pre-formatted in the family's timezone so
 * a widget only has to lay it out.
 *
 *   {
 *     title, view: { id, name, color } | null,   // null for the family view
 *     members: [{ id, name, color }],
 *     events: [{ title, day: "Today"|"Tomorrow", time: "3:20 PM"|"All day",
 *                startAt, endAt, allDay, location?, members: [id…], colors: [hex…] }],
 *     nextTrip: { id, name, emoji?, startDate, endDate, status: "upcoming"|"active",
 *                 daysUntil, day?, days, url } | null,
 *     hubUrl, generatedAt
 *   }
 *
 * Events cover the rest of today and all of tomorrow, without events that are
 * over or that the calendar owner declined. A member's view keeps only their
 * events (shared invites included); the family view keeps everyone's.
 */

const MAX_EVENTS = 12;

export async function handleWidget(request, env, hub, loadEvents) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);
  const viewId = (url.searchParams.get("view") || "family").toLowerCase();
  const view = hub.members.find(m => m.id === viewId) || null;
  if (!view && viewId !== "family") {
    return json({ error: `Unknown view "${viewId}". Use "family" or one of: ${hub.members.map(m => m.id).join(", ")}` }, 400);
  }

  const tz = hub.timezone;
  const now = new Date();
  const today = ymd(now, tz);
  const tomorrow = addDays(today, 1);

  let events = [];
  let eventsError = null;
  try {
    events = await loadEvents(2);
  } catch (err) {
    eventsError = err.message;
  }

  const colorOf = Object.fromEntries(hub.members.map(m => [m.id, m.color]));
  const merged = new Map();
  for (const e of events) {
    if (e.declined) continue;
    const key = e.id ?? `${e.title}|${e.startAt}`;
    const g = merged.get(key);
    if (g) {
      if (!g.members.includes(e.memberId)) g.members.push(e.memberId);
    } else {
      merged.set(key, { ...e, members: [e.memberId] });
    }
  }

  const upcoming = [];
  for (const e of merged.values()) {
    if (view && !e.members.includes(view.id)) continue;
    const startDay = e.allDay ? e.startAt.slice(0, 10) : ymd(new Date(e.startAt), tz);
    // All-day events end on the (exclusive) next date; timed events end at endAt.
    const over = e.allDay ? (e.endAt || addDays(startDay, 1)) <= today : new Date(e.endAt || e.startAt) <= now;
    if (over) continue;
    // Multi-day all-day events that started earlier still show as today.
    const day = startDay < today ? today : startDay;
    if (day !== today && day !== tomorrow) continue;
    const order = hub.members.map(m => m.id);
    const members = e.members.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
    upcoming.push({
      title: e.title,
      day: day === today ? "Today" : "Tomorrow",
      time: e.allDay ? "All day" : timeLabel(new Date(e.startAt), tz, hub.locale),
      startAt: e.startAt,
      endAt: e.endAt,
      allDay: !!e.allDay,
      ...(e.location ? { location: e.location } : {}),
      members,
      colors: members.map(id => colorOf[id]).filter(Boolean),
      sortKey: `${day}${e.allDay ? "0" : "1"}${e.allDay ? "" : new Date(e.startAt).toISOString()}`,
    });
  }
  upcoming.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  for (const e of upcoming) delete e.sortKey;

  const nextTrip = await findNextTrip(env, hub, view, today, url.origin);

  return json({
    title: hub.title,
    view: view ? { id: view.id, name: view.name, color: view.color } : null,
    members: hub.members.map(({ id, name, color }) => ({ id, name, color })),
    events: upcoming.slice(0, MAX_EVENTS),
    moreEvents: Math.max(0, upcoming.length - MAX_EVENTS),
    ...(eventsError ? { eventsError } : {}),
    nextTrip,
    hubUrl: `${url.origin}/`,
    generatedAt: now.toISOString(),
  });
}

async function findNextTrip(env, hub, view, today, origin) {
  if (!env.HUB_DATA) return null;
  const family = await env.HUB_DATA.get("data:family", "json");
  const trips = Array.isArray(family?.trips) ? family.trips : [];
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const candidates = trips
    .filter(t => DATE.test(t?.startDate) && DATE.test(t?.endDate))
    .filter(t => t.endDate >= today && t.status !== "past" && t.type !== "work")
    .filter(t => !view || !Array.isArray(t.who) || t.who.includes(view.id))
    .sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  const t = candidates[0];
  if (!t) return null;
  const active = t.startDate <= today;
  const app = hub.tripApps.find(a => a.trip === t.id);
  return {
    id: t.id,
    name: t.name,
    ...(t.emoji ? { emoji: t.emoji } : {}),
    startDate: t.startDate,
    endDate: t.endDate,
    status: active ? "active" : "upcoming",
    daysUntil: active ? 0 : daysBetween(today, t.startDate),
    ...(active ? { day: daysBetween(t.startDate, today) + 1 } : {}),
    days: daysBetween(t.startDate, t.endDate) + 1,
    url: `${origin}${app ? app.path : "/"}`,
  };
}

// ─── Dates in the family's timezone ───────────────────────────────────────────

function ymd(date, tz) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function timeLabel(date, tz, locale) {
  return new Intl.DateTimeFormat(locale || "en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(date);
}
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
