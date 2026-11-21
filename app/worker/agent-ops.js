/**
 * What the family's assistant can change through POST /api/agent/ops (agent.js): one
 * small, checked change per op, never a whole record.
 *
 *   op: { tier, scopes, family?, run(c, args) }
 *     tier    "direct" (applied at once). Later: "confirm" (waits for an adult's yes).
 *             The request can't choose it.
 *     scopes  the kinds of channel that may ask for it (hub.agent.channels in family.yaml)
 *     family  only a family member may ask (the Slack id maps to one)
 *     run     makes the change and returns { status: "applied" | "unchanged", target, summary }
 *
 * An op refuses with an OpError that says what to do next: an assistant acts on the
 * message. It never shortens what it was given to make it fit.
 *
 * Every applied change is written to agent_log with what undoes it (UNDO below): the
 * inverse of that one change, not a copy of the record, so undoing it leaves everything
 * that happened since in place.
 */

import { cleanTrip, tripFromRow, LIMITS } from "./trip-records.js";
import { listGrocery, saveGrocery, norm as groceryKey, MAX_ITEMS } from "./grocery.js";

export class OpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const PRICES = ["$", "$$", "$$$", "$$$$"];
const LIST_NAMES = { ideas: "ideas", restaurants: "restaurants", activities: "things to do" };

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

/** How two entries on a trip's list are told apart: by name, ignoring case and punctuation. */
const key = s => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const itemKey = x => key(typeof x === "string" ? x : x?.name);

const randomId = (prefix = "") => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return prefix + [...bytes].map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
};

// ─── Trips ────────────────────────────────────────────────────────────────────

async function loadTrip(c) {
  const row = await c.db.prepare("SELECT * FROM trips WHERE id = ?").bind(c.tripId).first();
  if (!row) throw new OpError(`The hub has no trip "${c.tripId}". An adult adds it on /household/ › Trips`, 404);
  return row;
}

const detailsOf = t => JSON.stringify({ highlights: t.highlights, activities: t.activities, restaurants: t.restaurants, ideas: t.ideas });

/** Saves a trip's lists if nobody changed the trip since `row` was read. */
function saveLists(c, row, trip) {
  // A later time than the row's, so "did my change land" can be read back from it.
  const at = Math.max(c.now, row.updated_at + 1);
  return {
    statement: c.db.prepare("UPDATE trips SET details = ?, updated_at = ?, updated_by = 'assistant' WHERE id = ? AND updated_at = ?")
      .bind(detailsOf(trip), at, row.id, row.updated_at),
    landed: { sql: "SELECT 1 FROM trips WHERE id = ? AND updated_at = ?", binds: [row.id, at] },
  };
}

/** Adds one entry to one of a trip's lists. */
async function tripAdd(c, list, item, label) {
  const row = await loadTrip(c);
  if (row.archived) throw new OpError(`"${row.name}" is archived; an adult brings it back on /household/ › Trips`, 409);
  const trip = tripFromRow(row);
  const target = `trip:${row.id}`;
  if (trip[list].some(x => itemKey(x) === itemKey(item))) {
    return { status: "unchanged", target, summary: `${label} is already in ${row.name}'s ${LIST_NAMES[list]}` };
  }
  if (trip[list].length >= LIMITS[list]) {
    throw new OpError(`${list}: ${row.name} already has ${LIMITS[list]}, the most a trip holds. An adult removes one on /household/ › Trips`);
  }
  const memberIds = new Set(c.hub.members.map(m => m.id));
  const { trip: clean, error } = cleanTrip({ ...trip, [list]: [...trip[list], item] }, { memberIds });
  if (error) throw new OpError(error);
  const { statement, landed } = saveLists(c, row, clean);
  const summary = `Added ${label} to ${row.name}'s ${LIST_NAMES[list]}`;
  const ok = await c.commit(statement, landed, { target, summary, undo: { kind: "trip-remove", trip: row.id, list, key: itemKey(item) } });
  if (!ok) throw new OpError("Someone changed the trip at the same moment. Run the same command again", 409);
  return { status: "applied", target, summary };
}

async function undoTripAdd(c, u) {
  const row = await c.db.prepare("SELECT * FROM trips WHERE id = ?").bind(u.trip).first();
  if (!row) throw new OpError("That trip is gone", 409);
  const trip = tripFromRow(row);
  const kept = trip[u.list].filter(x => itemKey(x) !== u.key);
  if (kept.length === trip[u.list].length) throw new OpError("It's already gone from the trip", 409);
  return saveLists(c, row, { ...trip, [u.list]: kept });
}

// ─── The grocery list ─────────────────────────────────────────────────────────

/** The one item still to buy that `name` means, or an OpError that lists the choices. */
function findToBuy(items, name) {
  const open = items.filter(i => !i.done);
  const k = groceryKey(name);
  const exact = open.filter(i => groceryKey(i.name) === k);
  const hits = exact.length ? exact : open.filter(i => groceryKey(i.name).includes(k));
  const names = xs => xs.slice(0, 12).map(i => `"${i.name}"`).join(", ");
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new OpError(`"${name}" matches several: ${names(hits)}. Say which, by its full name`);
  throw new OpError(open.length ? `No "${name}" left to buy. On the list: ${names(open)}` : "The list has nothing left to buy", 404);
}

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
    id: randomId("agent-"), name, quantity, ...(store ? { store } : {}),
    ...(c.actor.family ? { addedBy: c.actor.id } : {}),
    done: false, addedAt: c.now, updatedAt: c.now,
  };
  await saveGrocery(c.env, [...items, item]);
  const summary = `Added ${quantity > 1 ? `${quantity} × ` : ""}"${name}" to the grocery list`;
  await c.record({ target: "grocery", summary, undo: { kind: "grocery-delete", id: item.id } });
  return { status: "applied", target: "grocery", summary };
}

async function groceryCheck(c, args) {
  const name = field(args, "name", 80, { required: true });
  const items = await listGrocery(c.env);
  const item = findToBuy(items, name);
  await saveGrocery(c.env, items.map(i => (i.id === item.id ? { ...i, done: true, updatedAt: c.now } : i)));
  const summary = `Checked "${item.name}" off the grocery list`;
  await c.record({ target: "grocery", summary, undo: { kind: "grocery-uncheck", id: item.id } });
  return { status: "applied", target: "grocery", summary };
}

async function undoGrocery(c, u) {
  const items = await listGrocery(c.env);
  if (!items.some(i => i.id === u.id)) throw new OpError("That item is already off the list", 409);
  await saveGrocery(c.env, u.kind === "grocery-delete"
    ? items.filter(i => i.id !== u.id)
    : items.map(i => (i.id === u.id ? { ...i, done: false, updatedAt: c.now } : i)));
  return null;
}

// ─── The registry ─────────────────────────────────────────────────────────────

const TRIP = { tier: "direct", scopes: ["trip", "ops"], trip: true };
const GROCERY = { tier: "direct", scopes: ["grocery", "household", "ops"], family: true };

export const OPS = {
  "trip.add-idea": {
    ...TRIP,
    run(c, args) {
      const text = field(args, "text", 400, { required: true });
      return tripAdd(c, "ideas", text, `"${text.length > 60 ? `${text.slice(0, 57)}…` : text}"`);
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
  "grocery.add": { ...GROCERY, run: groceryAdd },
  "grocery.check": { ...GROCERY, run: groceryCheck },
};

/**
 * Undoing a logged change, by the kind its undo data names. Returns { statement, landed }
 * for a change in the database (agent.js runs it together with marking the log), or null
 * when it has already made the change itself (the grocery list is in KV).
 */
export const UNDO = {
  "trip-remove": undoTripAdd,
  "grocery-delete": undoGrocery,
  "grocery-uncheck": undoGrocery,
};
