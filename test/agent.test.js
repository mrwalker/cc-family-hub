import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAgent } from "../app/worker/agent.js";
import { ensureSchema } from "../app/worker/db/migrations.js";
import { listGrocery } from "../app/worker/grocery.js";
import { memoryD1, memoryKV, HUB, NO_SQLITE } from "./helpers.js";

const D1 = { skip: NO_SQLITE };
const BASE = "https://hub.example.com/api/agent";
const NOW = Date.parse("2027-06-21T19:00:00Z");   // noon Pacific, ten days before the lake trip
const TOKEN = "agent-secret";

const LAKE = "C0LAKE0001", BEACH = "C0BEACH001", HOME = "C0HOME0001", OPS = "C0OPS00001", FOOD = "C0FOOD0001";
const ALEX = { slack: "U0ALEX0001" }, GRANDMA = { slack: "U0GRANDMA1" }, STRANGER = { slack: "U0NOBODY01", name: "Pat" };

const APP = {
  trip: "lake-jul-2027", path: "/lake/", appId: "lake-2027", players: ["alex", "sam", "grandma"],
  summary: {
    title: "Lake", start: "2027-07-01", end: "2027-07-05", tz: "America/Los_Angeles",
    members: [{ id: "alex", name: "Alex", color: "#2563eb" }, { id: "sam", name: "Sam", color: "#db2777" }],
    scoring: { firstBonus: 0, varietyBonus: 0 }, categories: [], quests: { canoe: { pts: 10, cat: "water" } },
    days: [
      { date: "2027-07-01", title: "Arrive", items: [{ time: "15:00", emoji: "🔑", title: "Check in" }] },
      { date: "2027-07-02", title: "On the water", items: [{ time: "09:00", emoji: "🛶", title: "Canoe rental" }] },
    ],
    packing: [{ id: "sunscreen" }, { id: "lifejacket" }, { id: "goggles", who: ["sam"] }],
    flags: [{ date: "2027-07-02", title: "Canoe rental", flag: "Book two canoes" }],
  },
};

const hubWith = (extra = {}) => ({
  ...HUB,
  tripApps: [APP],
  build: { toolkit: "2.12.0", builtAt: "2027-06-20T00:00:00.000Z", commit: null },
  agent: {
    name: "Assistant",
    channels: {
      [LAKE]: { scope: "trip", trip: "lake-jul-2027" }, [BEACH]: { scope: "trip", trip: "beach-aug-2027" },
      [HOME]: { scope: "household" }, [OPS]: { scope: "ops" }, [FOOD]: { scope: "grocery" },
    },
    people: {
      U0ALEX0001: { id: "alex", role: "adult", name: "Alex" },
      U0GRANDMA1: { id: "grandma", role: "guest", name: "Grandma" },
    },
    names: { alex: { id: "alex", role: "adult", name: "Alex" }, sam: { id: "sam", role: "child", name: "Sam" }, grandma: { id: "grandma", role: "guest", name: "Grandma" } },
  },
  ...extra,
});

async function setup(hub = hubWith()) {
  const db = memoryD1();
  await ensureSchema(db);
  const trip = (id, name, start, end) => db.prepare(`INSERT INTO trips (id, name, start_date, end_date, kind, who, details, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'family', '[]', ?, 0, 1, 1)`).bind(id, name, start, end, JSON.stringify({ restaurants: [{ name: "Diner", price: "$", type: "", note: "" }] })).run();
  await trip("lake-jul-2027", "Lake week", "2027-07-01", "2027-07-05");
  await trip("beach-aug-2027", "Beach", "2027-08-10", "2027-08-14");
  const env = { HUB_DB: db, HUB_DATA: memoryKV(), TRIP_KV: memoryKV(), AGENT_TOKEN: TOKEN, PUBLISH_TOKEN: "publish-secret" };
  const call = async (path, { body, token = TOKEN } = {}) => {
    const res = await handleAgent(new Request(`${BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }), env, hub, path.split("?")[0], { now: NOW });
    return { status: res.status, body: await res.json() };
  };
  const op = (op, args, channel = LAKE, actor = ALEX) => call("/ops", { body: { op, args, channel, actor } });
  const lists = async id => JSON.parse((await db.prepare("SELECT details FROM trips WHERE id = ?").bind(id).first()).details);
  return { db, env, call, op, lists };
}

// ─── Who may ask ──────────────────────────────────────────────────────────────

test("the assistant needs its own token, and a hub that's set up for it", D1, async () => {
  const { call } = await setup();
  assert.equal((await call(`/trips?channel=${LAKE}`, { token: null })).status, 401);
  assert.equal((await call(`/trips?channel=${LAKE}`, { token: "publish-secret" })).status, 401, "the publish token isn't the agent's");
  assert.equal((await call(`/trips?channel=${LAKE}`)).status, 200);

  const bare = await setup(hubWith({ agent: null }));
  const r = await bare.call(`/trips?channel=${LAKE}`);
  assert.equal(r.status, 503);
  assert.match(r.body.error, /hub\.agent\.channels/);
});

test("a channel the hub doesn't know is refused, and says where to add it", D1, async () => {
  const { op, call } = await setup();
  const r = await op("trip.add-idea", { text: "Bring bug spray" }, "C0UNKNOWN1");
  assert.equal(r.status, 403);
  assert.match(r.body.error, /hub\.agent\.channels in family\.yaml/);
  assert.equal((await call("/trips?channel=lake")).status, 400, "a channel's name isn't its id");
});

// ─── Trips ────────────────────────────────────────────────────────────────────

test("a trip channel adds to its own trip, once, and anyone there may ask", D1, async () => {
  const { op, lists, call } = await setup();
  const added = await op("trip.add-restaurant", { name: "Casa Luna", price: "$$", type: "Mexican" }, LAKE, GRANDMA);
  assert.equal(added.status, 200);
  assert.equal(added.body.status, "applied");
  assert.match(added.body.summary, /Added "Casa Luna" to Lake week's restaurants/);
  assert.deepEqual((await lists("lake-jul-2027")).restaurants.map(r => r.name), ["Diner", "Casa Luna"]);

  const again = await op("trip.add-restaurant", { name: "casa luna!" }, LAKE, STRANGER);
  assert.equal(again.body.status, "unchanged", "the same name isn't added twice");
  assert.equal((await lists("lake-jul-2027")).restaurants.length, 2);

  assert.equal((await op("trip.add-idea", { text: "Bring bug spray" }, LAKE, STRANGER)).body.status, "applied", "someone the hub doesn't know");
  assert.equal((await op("trip.add-activity", { name: "Sunset paddle", emoji: "🛶" })).body.status, "applied");

  const log = (await call(`/log?channel=${LAKE}`)).body.log;
  assert.deepEqual(log.map(l => l.by).sort(), ["Alex", "Grandma", "Pat"]);
  assert.ok(log.every(l => l.scope === "trip:lake-jul-2027"));
});

test("a trip channel can't reach another trip; the ops channel can, by name", D1, async () => {
  const { op, lists, call } = await setup();
  const r = await op("trip.add-idea", { text: "Kites", trip: "beach-aug-2027" });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /can't touch "beach-aug-2027"/);
  assert.equal((await lists("beach-aug-2027")).ideas, undefined);
  assert.equal((await call(`/trip?channel=${LAKE}&trip=beach-aug-2027`)).status, 403);
  assert.deepEqual((await call(`/trips?channel=${LAKE}`)).body.trips.map(t => t.id), ["lake-jul-2027"]);

  assert.equal((await op("trip.add-idea", { text: "Kites" }, HOME)).status, 403, "the household channel reads trips but doesn't change them");
  const unnamed = await op("trip.add-idea", { text: "Kites" }, OPS);
  assert.equal(unnamed.status, 400);
  assert.match(unnamed.body.error, /say which trip.*beach-aug-2027/);
  assert.equal((await op("trip.add-idea", { text: "Kites", trip: "beach-aug-2027" }, OPS)).body.status, "applied");
  assert.deepEqual((await lists("beach-aug-2027")).ideas, ["Kites"]);
});

test("what doesn't fit is refused, never shortened", D1, async () => {
  const { op, db, lists } = await setup();
  assert.match((await op("trip.add-idea", { text: "x".repeat(401) })).body.error, /^text: no more than 400 characters/);
  assert.match((await op("trip.add-restaurant", { name: "" })).body.error, /^name: required/);
  assert.match((await op("trip.add-restaurant", { name: "Odd", price: "cheap" })).body.error, /^price:/);
  assert.match((await op("trip.remove-everything", {})).body.error, /^op: unknown/);
  assert.equal((await op("trip.add-idea", { text: "x" }, LAKE, {})).status, 400, "it has to say who asked");

  const full = JSON.stringify({ ideas: Array.from({ length: 40 }, (_, i) => `Idea ${i}`) });
  await db.prepare("UPDATE trips SET details = ? WHERE id = 'lake-jul-2027'").bind(full).run();
  const r = await op("trip.add-idea", { text: "One more" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already has 40/);
  assert.equal((await lists("lake-jul-2027")).ideas.length, 40);
});

test("an added entry is undone without touching what came after", D1, async () => {
  const { op, call, lists } = await setup();
  const first = await op("trip.add-restaurant", { name: "Casa Luna" });
  await op("trip.add-restaurant", { name: "Pie Shop" });
  const id = first.body.logId;

  const elsewhere = await call(`/log/${id}/undo`, { body: { channel: FOOD, actor: ALEX } });
  assert.equal(elsewhere.status, 403, "only from the channel it was made for, or ops");
  const undone = await call(`/log/${id}/undo`, { body: { channel: LAKE, actor: ALEX } });
  assert.equal(undone.body.status, "applied");
  assert.deepEqual((await lists("lake-jul-2027")).restaurants.map(r => r.name), ["Diner", "Pie Shop"]);
  assert.equal((await call(`/log/${id}/undo`, { body: { channel: LAKE, actor: ALEX } })).body.status, "unchanged");
  assert.equal((await call(`/log?channel=${LAKE}`)).body.log.find(l => l.id === id).undone, true);
});

// ─── The grocery list ─────────────────────────────────────────────────────────

test("groceries: family adds and checks off from the household channels", D1, async () => {
  const { op, env, call } = await setup();
  assert.equal((await op("grocery.add", { name: "Oat milk" }, LAKE)).status, 403, "not from a trip channel");
  const stranger = await op("grocery.add", { name: "Oat milk" }, FOOD, STRANGER);
  assert.equal(stranger.status, 403);
  assert.match(stranger.body.error, /Only a family member/);

  assert.equal((await op("grocery.add", { name: "Bread" }, FOOD, { name: "Grandma" })).status, 403, "a guest, by name");
  const byName = await op("grocery.add", { name: "Apples" }, FOOD, { name: " SAM " });
  assert.equal(byName.body.status, "applied", "a family member known only by name");
  await call(`/log/${byName.body.logId}/undo`, { body: { channel: FOOD, actor: { name: "Sam" } } });

  const added = await op("grocery.add", { name: "Oat milk", quantity: 2, store: "Co-op" }, FOOD);
  assert.equal(added.body.status, "applied");
  assert.equal((await op("grocery.add", { name: "oat milk" }, HOME)).body.status, "unchanged");
  await op("grocery.add", { name: "Oatmeal" }, HOME);
  const [milk] = await listGrocery(env);
  assert.deepEqual([milk.name, milk.quantity, milk.store, milk.addedBy, milk.done], ["Oat milk", 2, "Co-op", "alex", false]);

  assert.match((await op("grocery.check", { name: "oat" }, HOME)).body.error, /matches several/);
  assert.match((await op("grocery.check", { name: "eggs" }, HOME)).body.error, /No "eggs" left to buy\. On the list: "Oat milk", "Oatmeal"/);
  const checked = await op("grocery.check", { name: "Oat milk" }, HOME);
  assert.equal(checked.body.status, "applied");
  assert.deepEqual((await call(`/grocery?channel=${FOOD}`)).body.items.map(i => [i.name, i.done]), [["Oatmeal", false], ["Oat milk", true]]);

  await call(`/log/${checked.body.logId}/undo`, { body: { channel: HOME, actor: ALEX } });
  await call(`/log/${added.body.logId}/undo`, { body: { channel: OPS, actor: ALEX } });
  assert.deepEqual((await listGrocery(env)).map(i => i.name), ["Oatmeal"]);
});

// ─── Briefing facts and health ────────────────────────────────────────────────

test("a trip's facts: where it is in time, the plan, packing, and what's unbooked", D1, async () => {
  const { call, env, op, db } = await setup();
  await env.TRIP_KV.put("trip:lake-2027:pack:sam", JSON.stringify({ checked: ["sunscreen", "goggles", "not-on-the-list"], ts: 1 }));
  await op("trip.add-idea", { text: "Bring bug spray" });

  const f = (await call(`/facts/trip?channel=${LAKE}`)).body;
  assert.deepEqual([f.phase, f.daysUntil, f.days, f.today], ["before", 10, 5, "2027-06-21"]);
  assert.equal(f.name, "Lake week");
  assert.deepEqual(f.unbooked, [{ date: "2027-07-02", title: "Canoe rental", flag: "Book two canoes" }]);
  assert.deepEqual(f.empty, ["activities"]);
  assert.deepEqual(f.packing, [{ member: "alex", name: "Alex", packed: 0, total: 2 }, { member: "sam", name: "Sam", packed: 2, total: 3 }]);
  assert.equal(f.questsTotal, 1);
  assert.equal(f.datesMismatch, null);
  assert.equal(f.recentChanges.length, 1);
  assert.equal(f.record.album, undefined);

  await db.prepare("UPDATE trips SET end_date = '2027-07-06' WHERE id = 'lake-jul-2027'").run();
  const during = (await handleAgent(new Request(`${BASE}/facts/trip?channel=${LAKE}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
    env, hubWith(), "/facts/trip", { now: Date.parse("2027-07-01T19:00:00Z") }));
  const d = await during.json();
  assert.deepEqual([d.phase, d.day, d.schedule.today.title, d.schedule.tomorrow.items[0].title], ["during", 1, "Arrive", "Canoe rental"]);
  assert.deepEqual(d.datesMismatch, { record: { start: "2027-07-01", end: "2027-07-06" }, app: { start: "2027-07-01", end: "2027-07-05" } });

  assert.equal((await call(`/facts/trip?channel=${FOOD}`)).status, 403);
  assert.equal((await call(`/facts/trip?channel=${HOME}&trip=beach-aug-2027`)).body.phase, "before", "a trip without an app still has facts");
});

test("health says what's deployed and how fresh the data is, to either token", D1, async () => {
  const { call, env, op } = await setup();
  await env.HUB_DATA.put("data:plan", "{}", { metadata: { publishedAt: "2027-06-21T13:00:00.000Z", bytes: 2 } });
  await op("trip.add-idea", { text: "Bring bug spray" });
  assert.equal((await call("/health", { token: "wrong" })).status, 401);
  const h = (await call("/health", { token: "publish-secret" })).body;
  assert.equal(h.build.toolkit, "2.12.0");
  assert.equal(h.schema.code, h.schema.db);
  assert.equal(h.data.plan.publishedAt, "2027-06-21T13:00:00.000Z");
  assert.equal(h.data.family, null);
  assert.deepEqual(h.tripApps, [{ trip: "lake-jul-2027", path: "/lake/", known: true }]);
  assert.equal(h.agent.channels, 5);
  assert.equal(h.agent.lastWriteAt, new Date(NOW).toISOString());
});
