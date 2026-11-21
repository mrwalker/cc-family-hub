/**
 * What the family's assistant can change through POST /api/agent/ops (agent.js): one
 * small, checked change per op, never a whole record.
 *
 *   op: { tier, scopes, family?, trip?, prepare?, run }
 *     tier     "direct": applied at once.
 *              "confirm": waits for an adult's yes (on /household/ › Assistant, or from
 *              an ops channel). prepare(c, args) checks it and says what it would do;
 *              run(c, args) makes it once approved, against the records as they are then.
 *              The request can't choose the tier.
 *     scopes   the kinds of channel that may ask for it (hub.agent.channels in family.yaml)
 *     family   only a family member may ask (they're found by chat id or name)
 *     trip     it's about one trip: the channel's, or one named from an ops channel
 *     run      makes the change and returns { status: "applied" | "unchanged", target, summary }
 *
 * The household's own records (tasks, chores, movies) are changed through the household
 * API itself, as the family member who asked (c.household), so the same rules apply as on
 * /household/: a child can tick a chore but not add a task.
 *
 * An op refuses with an OpError that says what to do next: an assistant acts on the
 * message. It never shortens what it was given to make it fit.
 *
 * Every applied change is logged in agent_log with what undoes it (UNDO below): the
 * inverse of that one change, not a copy of the record, so undoing it leaves everything
 * that happened since in place.
 */

import { cleanTrip, tripFromRow, LIMITS } from "./trip-records.js";
import { listGrocery, saveGrocery, norm as groceryKey, MAX_ITEMS } from "./grocery.js";
import { AREAS } from "./household.js";
import { listMovies } from "./movies.js";

export class OpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const PRICES = ["$", "$$", "$$$", "$$$$"];
const LIST_NAMES = { ideas: "ideas", restaurants: "restaurants", activities: "things to do" };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UNITS = ["day", "week", "month", "year"];

/** A text argument: tidied, and refused when it's missing or too long. */
function field(args, name, max, { required = false } = {}) {
  const v = args?.[name];
  if (v == null || v === "") {
    if (required) throw new OpError(`${name}: required`);
    return "";
  }
  if (typeof v !== "string") throw new OpError(`${name}: text`);
  const s = v.replace(/\s+/g, " ").trim();
  if (!s && required) throw new OpError(`${name}: required`);
  if (s.length > max) throw new OpError(`${name}: no more than ${max} characters (it has ${s.length}); shorten it`);
  return s;
}

function dateArg(args, name, { required = false } = {}) {
  const v = field(args, name, 10, { required });
  if (v && (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T12:00:00Z`)))) throw new OpError(`${name}: a date, YYYY-MM-DD`);
  return v || null;
}

/** How two names are told apart: ignoring case, accents and punctuation. */
const key = s => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const itemKey = x => key(typeof x === "string" ? x : x?.name);
/** "Lake week's", "Outer Banks'". */
const poss = name => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
const quote = s => `"${s.length > 60 ? `${s.slice(0, 57)}…` : s}"`;

/**
 * The one entry `name` means: the same name, or else the only one containing it.
 * Otherwise an OpError naming the choices, so the assistant can ask which.
 */
function pick(list, name, nameOf, what) {
  const k = key(name);
  if (!k) throw new OpError("name: required");
  const exact = list.filter(x => key(nameOf(x)) === k);
  const hits = exact.length ? exact : list.filter(x => key(nameOf(x)).includes(k));
  const names = xs => xs.slice(0, 12).map(x => `"${nameOf(x)}"`).join(", ");
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new OpError(`"${name}" matches several ${what}: ${names(hits)}. Say which, by its full name`);
  throw new OpError(list.length ? `Nothing called "${name}" among the ${what}. There are: ${names(list)}` : `There are no ${what}`, 404);
}

const randomId = (prefix = "") => {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return prefix + [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
};

/** A family member by id or name. */
function member(c, v, what = "who") {
  const k = key(v);
  const m = c.hub.members.find(x => x.id === v || key(x.id) === k || key(x.name) === k);
  if (!m) throw new OpError(`${what}: one of the family: ${c.hub.members.map(x => x.name).join(", ")}`);
  return m;
}

// ─── Trips ────────────────────────────────────────────────────────────────────

async function loadTrip(c) {
  const row = await c.db.prepare("SELECT * FROM trips WHERE id = ?").bind(c.tripId).first();
  if (!row) throw new OpError(`The hub has no trip "${c.tripId}". An adult adds it on /household/ › Trips`, 404);
  if (row.archived) throw new OpError(`"${row.name}" is archived; an adult brings it back on /household/ › Trips`, 409);
  return row;
}

const detailsOf = t => JSON.stringify({ highlights: t.highlights, activities: t.activities, restaurants: t.restaurants, ideas: t.ideas });

/** Saves a trip's lists (and dates) if nobody changed the trip since `row` was read. */
function saveTrip(c, row, trip) {
  // A later time than the row's, so "did my change land" can be read back from it.
  const at = Math.max(c.now, row.updated_at + 1);
  return {
    statement: c.db.prepare(`UPDATE trips SET details = ?, start_date = ?, end_date = ?, updated_at = ?, updated_by = 'assistant'
        WHERE id = ? AND updated_at = ?`)
      .bind(detailsOf(trip), trip.startDate, trip.endDate, at, row.id, row.updated_at),
    landed: { sql: "SELECT 1 FROM trips WHERE id = ? AND updated_at = ?", binds: [row.id, at] },
  };
}

async function commitTrip(c, row, trip, e) {
  const { statement, landed } = saveTrip(c, row, trip);
  if (!(await c.commit(statement, landed, e))) throw new OpError("Someone changed the trip at the same moment. Run the same command again", 409);
}

/** Adds one entry to one of a trip's lists. */
async function tripAdd(c, list, item, label) {
  const row = await loadTrip(c);
  const trip = tripFromRow(row);
  const target = `trip:${row.id}`;
  if (trip[list].some(x => itemKey(x) === itemKey(item))) {
    return { status: "unchanged", target, summary: `${label} is already in ${poss(row.name)} ${LIST_NAMES[list]}` };
  }
  if (trip[list].length >= LIMITS[list]) {
    throw new OpError(`${list}: ${row.name} already has ${LIMITS[list]}, the most a trip holds. Remove one first`);
  }
  const memberIds = new Set(c.hub.members.map(m => m.id));
  const { trip: clean, error } = cleanTrip({ ...trip, [list]: [...trip[list], item] }, { memberIds });
  if (error) throw new OpError(error);
  const summary = `Added ${label} to ${poss(row.name)} ${LIST_NAMES[list]}`;
  await commitTrip(c, row, clean, { target, summary, undo: { kind: "trip-remove", trip: row.id, list, key: itemKey(item) } });
  return { status: "applied", target, summary };
}

/** The entry of a trip's list that `name` means, and where it is. */
async function tripEntry(c, list, name) {
  const row = await loadTrip(c);
  const trip = tripFromRow(row);
  const item = pick(trip[list], name, x => (typeof x === "string" ? x : x.name), `${LIST_NAMES[list]} on ${row.name}`);
  const label = quote(typeof item === "string" ? item : item.name);
  return { row, trip, item, index: trip[list].indexOf(item), summary: `Remove ${label} from ${poss(row.name)} ${LIST_NAMES[list]}` };
}

const tripRemove = list => ({
  ...TRIP_CONFIRM,
  async prepare(c, args) {
    const { row, summary } = await tripEntry(c, list, field(args, list === "ideas" ? "text" : "name", 400, { required: true }));
    return { target: `trip:${row.id}`, summary };
  },
  async run(c, args) {
    const { row, trip, item, index, summary } = await tripEntry(c, list, field(args, list === "ideas" ? "text" : "name", 400, { required: true }));
    const done = summary.replace(/^Remove/, "Removed");
    await commitTrip(c, row, { ...trip, [list]: trip[list].filter((_, i) => i !== index) },
      { target: `trip:${row.id}`, summary: done, undo: { kind: "trip-insert", trip: row.id, list, index, item } });
    return { status: "applied", target: `trip:${row.id}`, summary: done };
  },
});

function datesArgs(args) {
  const start = dateArg(args, "start", { required: true }), end = dateArg(args, "end", { required: true });
  if (end < start) throw new OpError("end: on or after the start");
  return { start, end };
}

async function undoTrip(c, u) {
  const row = await c.db.prepare("SELECT * FROM trips WHERE id = ?").bind(u.trip).first();
  if (!row) throw new OpError("That trip is gone", 409);
  const trip = tripFromRow(row);
  if (u.kind === "trip-remove") {
    const kept = trip[u.list].filter(x => itemKey(x) !== u.key);
    if (kept.length === trip[u.list].length) throw new OpError("It's already gone from the trip", 409);
    return saveTrip(c, row, { ...trip, [u.list]: kept });
  }
  if (u.kind === "trip-insert") {
    if (trip[u.list].some(x => itemKey(x) === itemKey(u.item))) throw new OpError("It's already back on the trip", 409);
    if (trip[u.list].length >= LIMITS[u.list]) throw new OpError(`${u.list}: the trip is full; remove one first`, 409);
    const next = [...trip[u.list]];
    next.splice(Math.min(u.index, next.length), 0, u.item);
    return saveTrip(c, row, { ...trip, [u.list]: next });
  }
  // trip-dates: only if they're still the dates the change set.
  if (trip.startDate !== u.to.start || trip.endDate !== u.to.end) throw new OpError("The dates have changed again since; change them on /household/ › Trips", 409);
  return saveTrip(c, row, { ...trip, startDate: u.from.start, endDate: u.from.end });
}

// ─── The grocery list ─────────────────────────────────────────────────────────

async function groceryAdd(c, args) {
  const name = field(args, "name", 80, { required: true });
  const store = field(args, "store", 40);
  const quantity = args.quantity == null || args.quantity === "" ? 1 : Number(args.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new OpError("quantity: a whole number from 1 to 99");
  const items = await listGrocery(c.env);
  const have = items.find(i => !i.done && groceryKey(i.name) === groceryKey(name));
  if (have) return { status: "unchanged", target: "grocery", summary: `"${have.name}" is already on the grocery list` };
  if (items.length >= MAX_ITEMS) throw new OpError(`The grocery list is full (${MAX_ITEMS} items). Clear what's been bought on the hub page`);
  const item = {
    id: randomId("agent-").slice(0, 24), name, quantity, ...(store ? { store } : {}),
    ...(c.actor.family ? { addedBy: c.actor.id } : {}),
    done: false, addedAt: c.now, updatedAt: c.now,
  };
  await saveGrocery(c.env, [...items, item]);
  const summary = `Added ${quantity > 1 ? `${quantity} × ` : ""}"${name}" to the grocery list`;
  await c.record({ target: "grocery", summary, undo: { kind: "grocery-delete", id: item.id } });
  return { status: "applied", target: "grocery", summary };
}

async function groceryCheck(c, args) {
  const items = await listGrocery(c.env);
  const item = pick(items.filter(i => !i.done), field(args, "name", 80, { required: true }), i => i.name, "items left to buy");
  await saveGrocery(c.env, items.map(i => (i.id === item.id ? { ...i, done: true, updatedAt: c.now } : i)));
  const summary = `Checked "${item.name}" off the grocery list`;
  await c.record({ target: "grocery", summary, undo: { kind: "grocery-uncheck", id: item.id } });
  return { status: "applied", target: "grocery", summary };
}

const groceryToRemove = async (c, args) => {
  const items = await listGrocery(c.env);
  return { items, item: pick(items, field(args, "name", 80, { required: true }), i => i.name, "items on the grocery list") };
};

async function undoGrocery(c, u) {
  const items = await listGrocery(c.env);
  const has = items.some(i => i.id === (u.item?.id ?? u.id));
  if (u.kind === "grocery-restore") {
    if (has) throw new OpError("That item is already back on the list", 409);
    await saveGrocery(c.env, [...items, { ...u.item, updatedAt: c.now }]);
    return null;
  }
  if (!has) throw new OpError("That item is already off the list", 409);
  await saveGrocery(c.env, u.kind === "grocery-delete"
    ? items.filter(i => i.id !== u.id)
    : items.map(i => (i.id === u.id ? { ...i, done: false, updatedAt: c.now } : i)));
  return null;
}

// ─── Household tasks ──────────────────────────────────────────────────────────

/** The open tasks this channel may touch, with their pet and place names. */
async function tasksInScope(c) {
  const { results } = await c.db.prepare(`SELECT t.id, t.title, t.area, t.kind, t.place_id, t.due_date, p.name AS pet, pl.name AS place
      FROM tasks t LEFT JOIN pets p ON p.id = t.pet_id LEFT JOIN places pl ON pl.id = t.place_id
      WHERE t.archived = 0 ORDER BY t.due_date IS NULL, t.due_date, t.title`).all();
  return results.filter(t => c.scope.kind === "pets" ? t.area === "pets"
    : c.scope.kind === "place" ? t.area === "house" && t.place_id === c.scope.place : true);
}

const taskName = t => [t.title, t.pet, t.place].filter(Boolean).join(" · ");

/** The open task `args.title` means (narrowed by --pet or --place when given). */
async function findTask(c, args) {
  const title = field(args, "title", 80, { required: true });
  let tasks = await tasksInScope(c);
  const pet = field(args, "pet", 40), place = field(args, "place", 40);
  if (pet) tasks = tasks.filter(t => key(t.pet) === key(pet));
  if (place) tasks = tasks.filter(t => key(t.place) === key(place));
  return pick(tasks, title, t => t.title, "open tasks here");
}

async function taskAdd(c, args) {
  const title = field(args, "title", 80, { required: true });
  const petName = field(args, "pet", 40), placeName = field(args, "place", 40);
  const area = c.scope.kind === "pets" || petName ? "pets" : "house";
  if (c.scope.kind === "pets" && area !== "pets") throw new OpError("This channel is for the pets' tasks");
  if (c.scope.kind === "place" && area !== "house") throw new OpError("This channel is for one house's tasks; a pet's task goes in the pets' channel");
  const kinds = AREAS[area].kinds;
  const kind = field(args, "kind", 20) || (area === "pets" ? "other" : args.due ? "maintenance" : "fix");
  if (!kinds[kind]) throw new OpError(`kind: for ${area === "pets" ? "a pet" : "the house"}, one of ${Object.keys(kinds).join(", ")}`);

  let petId = null, placeId = null, where = "";
  if (area === "pets") {
    if (!petName) throw new OpError("pet: which pet it's for");
    const pets = (await c.db.prepare("SELECT id, name FROM pets WHERE archived = 0").all()).results;
    const pet = pick(pets, petName, p => p.name, "pets");
    petId = pet.id; where = ` for ${pet.name}`;
  } else if (c.scope.kind === "place") {
    placeId = c.scope.place;
  } else if (placeName) {
    const places = (await c.db.prepare("SELECT id, name FROM places WHERE archived = 0").all()).results;
    const place = pick(places, placeName, p => p.name, "places");
    placeId = place.id; where = ` at ${place.name}`;
  }
  const time = field(args, "time", 5);
  if (time && !TIME_RE.test(time)) throw new OpError("time: HH:MM, 24-hour");
  const every = args.every == null || args.every === "" ? null : Number(args.every);
  const unit = field(args, "unit", 6) || (every ? "month" : "");
  if (every != null && (!Number.isInteger(every) || every < 1 || every > 365)) throw new OpError("every: a whole number from 1 to 365");
  if (unit && !UNITS.includes(unit)) throw new OpError(`unit: one of ${UNITS.join(", ")}`);
  const assignee = field(args, "assignee", 40) ? member(c, args.assignee, "assignee").id : null;

  const id = randomId("task-").slice(0, 30);
  await c.household("/tasks", {
    id, area, kind, title, petId, placeId, assignee,
    dueDate: dateArg(args, "due"), dueTime: time || null,
    repeatEvery: every, repeatUnit: every ? unit : null,
    provider: field(args, "provider", 80) || null, phone: field(args, "phone", 30) || null, notes: field(args, "notes", 500) || null,
  });
  const summary = `Added the task "${title}"${where}${args.due ? `, due ${args.due}` : ""}`;
  await c.record({ target: `task:${id}`, summary, undo: { kind: "task-archive", id } });
  return { status: "applied", target: `task:${id}`, summary };
}

async function taskDone(c, args) {
  const task = await findTask(c, args);
  const note = field(args, "note", 200);
  await c.household(`/tasks/${task.id}/done`, note ? { note } : {});
  const last = await c.db.prepare("SELECT action_id FROM task_log WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(task.id).first();
  const summary = `Marked "${taskName(task)}" done`;
  await c.record({ target: `task:${task.id}`, summary, undo: last?.action_id ? { kind: "household-undo", actionId: last.action_id } : null });
  return { status: "applied", target: `task:${task.id}`, summary };
}

// ─── Chores and movies ────────────────────────────────────────────────────────

async function choreDone(c, args) {
  const title = field(args, "title", 80, { required: true });
  const chores = (await c.db.prepare("SELECT id, title FROM chores WHERE archived = 0 ORDER BY title").all()).results;
  const chore = pick(chores, title, x => x.title, "chores");
  const day = dateArg(args, "day");
  const r = await c.household(`/chores/${chore.id}/done`, day ? { day } : {});
  const summary = `Ticked the chore "${chore.title}"${day ? ` for ${day}` : ""}`;
  await c.record({ target: `chore:${chore.id}`, summary, undo: r.actionId ? { kind: "household-undo", actionId: r.actionId } : null });
  return { status: "applied", target: `chore:${chore.id}`, summary };
}

async function movieMark(c, args) {
  const movies = await listMovies(c.db);
  const movie = pick(movies, field(args, "title", 120, { required: true }), m => m.title, "movies and shows on the hub");
  const raw = field(args, "mark", 6) || "want";
  const mark = raw === "none" ? null : raw;
  if (mark !== null && mark !== "want" && mark !== "seen") throw new OpError("mark: want, seen, or none");
  const who = args.who ? member(c, args.who) : c.hub.members.find(m => m.id === c.actor.id);
  if (!who) throw new OpError("who: whose mark it is (a family member)");
  const before = movie.marks?.[who.id] ?? null;
  if (before === mark) return { status: "unchanged", target: `movie:${movie.id}`, summary: `${who.name} already has "${movie.title}" as ${mark ?? "unmarked"}` };
  await c.household(`/movies/${movie.id}/mark`, { member: who.id, mark });
  const summary = mark ? `Marked "${movie.title}" as ${mark === "want" ? "wanted" : "seen"} by ${who.name}` : `Cleared ${who.name}'s mark on "${movie.title}"`;
  await c.record({ target: `movie:${movie.id}`, summary, undo: { kind: "movie-mark", movie: movie.id, member: who.id, mark: before } });
  return { status: "applied", target: `movie:${movie.id}`, summary };
}

// ─── The registry ─────────────────────────────────────────────────────────────

const TRIP = { tier: "direct", scopes: ["trip", "ops"], trip: true };
const TRIP_CONFIRM = { tier: "confirm", scopes: ["trip", "ops"], trip: true };
const GROCERY = { tier: "direct", scopes: ["grocery", "household", "ops"], family: true };
const TASKS = { tier: "direct", scopes: ["household", "pets", "place", "ops"], family: true };
const FAMILY = { tier: "direct", scopes: ["household", "ops"], family: true };

export const OPS = {
  "trip.add-idea": {
    ...TRIP,
    run(c, args) {
      const text = field(args, "text", 400, { required: true });
      return tripAdd(c, "ideas", text, quote(text));
    },
  },
  "trip.add-restaurant": {
    ...TRIP,
    run(c, args) {
      const name = field(args, "name", 80, { required: true });
      const price = field(args, "price", 4);
      if (price && !PRICES.includes(price)) throw new OpError(`price: one of ${PRICES.join(", ")}, or leave it out`);
      return tripAdd(c, "restaurants", { name, price, type: field(args, "type", 40), note: field(args, "note", 400) }, `"${name}"`);
    },
  },
  "trip.add-activity": {
    ...TRIP,
    run(c, args) {
      const name = field(args, "name", 80, { required: true });
      return tripAdd(c, "activities", { emoji: field(args, "emoji", 16), name, note: field(args, "note", 400) }, `"${name}"`);
    },
  },
  "trip.remove-idea": tripRemove("ideas"),
  "trip.remove-restaurant": tripRemove("restaurants"),
  "trip.remove-activity": tripRemove("activities"),
  "trip.set-dates": {
    ...TRIP_CONFIRM,
    async prepare(c, args) {
      const { start, end } = datesArgs(args);
      const row = await loadTrip(c);
      if (row.start_date === start && row.end_date === end) throw new OpError(`${row.name} is already ${start} to ${end}`);
      return { target: `trip:${row.id}`, summary: `Change ${poss(row.name)} dates from ${row.start_date}–${row.end_date} to ${start}–${end}` };
    },
    async run(c, args) {
      const { start, end } = datesArgs(args);
      const row = await loadTrip(c);
      const trip = tripFromRow(row);
      const summary = `Changed ${poss(row.name)} dates from ${row.start_date}–${row.end_date} to ${start}–${end}`;
      await commitTrip(c, row, { ...trip, startDate: start, endDate: end },
        { target: `trip:${row.id}`, summary, undo: { kind: "trip-dates", trip: row.id, from: { start: row.start_date, end: row.end_date }, to: { start, end } } });
      return { status: "applied", target: `trip:${row.id}`, summary };
    },
  },

  "grocery.add": { ...GROCERY, run: groceryAdd },
  "grocery.check": { ...GROCERY, run: groceryCheck },
  "grocery.remove": {
    ...GROCERY, tier: "confirm",
    async prepare(c, args) {
      const { item } = await groceryToRemove(c, args);
      return { target: "grocery", summary: `Remove "${item.name}" from the grocery list` };
    },
    async run(c, args) {
      const { items, item } = await groceryToRemove(c, args);
      await saveGrocery(c.env, items.filter(i => i.id !== item.id));
      const summary = `Removed "${item.name}" from the grocery list`;
      await c.record({ target: "grocery", summary, undo: { kind: "grocery-restore", item } });
      return { status: "applied", target: "grocery", summary };
    },
  },

  "task.add": { ...TASKS, run: taskAdd },
  "task.done": { ...TASKS, run: taskDone },
  "task.archive": {
    ...TASKS, tier: "confirm",
    async prepare(c, args) {
      const task = await findTask(c, args);
      return { target: `task:${task.id}`, summary: `Archive the task "${taskName(task)}"` };
    },
    async run(c, args) {
      const task = await findTask(c, args);
      await c.household(`/tasks/${task.id}/archive`, { archived: true });
      const summary = `Archived the task "${taskName(task)}"`;
      await c.record({ target: `task:${task.id}`, summary, undo: { kind: "task-unarchive", id: task.id } });
      return { status: "applied", target: `task:${task.id}`, summary };
    },
  },
  "chore.done": { ...FAMILY, run: choreDone },
  "movie.mark": { ...FAMILY, scopes: ["movies", "household", "ops"], run: movieMark },
};

/**
 * Undoing a logged change, by the kind its undo data names. Returns { statement, landed }
 * for a trip change (agent.js runs it together with marking the log), or null when it
 * has made the change itself.
 */
export const UNDO = {
  "trip-remove": undoTrip,
  "trip-insert": undoTrip,
  "trip-dates": undoTrip,
  "grocery-delete": undoGrocery,
  "grocery-uncheck": undoGrocery,
  "grocery-restore": undoGrocery,
  "task-archive": async (c, u) => { await c.household(`/tasks/${u.id}/archive`, { archived: true }); return null; },
  "task-unarchive": async (c, u) => { await c.household(`/tasks/${u.id}/archive`, { archived: false }); return null; },
  "household-undo": async (c, u) => { await c.household("/undo", { actionId: u.actionId }); return null; },
  "movie-mark": async (c, u) => { await c.household(`/movies/${u.movie}/mark`, { member: u.member, mark: u.mark }); return null; },
};
