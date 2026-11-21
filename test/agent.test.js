import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAgent } from "../app/worker/agent.js";
import { handleHousehold } from "../app/worker/household.js";
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
  assert.match((await op("grocery.check", { name: "eggs" }, HOME)).body.error, /Nothing called "eggs" among the items left to buy\. There are: "Oat milk", "Oatmeal"/);
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

// ─── Changes that wait for a yes ──────────────────────────────────────────────

const SAM = { name: "Sam" };

test("removing and re-dating wait for an adult's yes, given from ops or the hub", D1, async () => {
  const { op, call, lists, db, env } = await setup();
  const asked = await op("trip.remove-restaurant", { name: "diner" }, LAKE, GRANDMA);
  assert.equal(asked.status, 200);
  assert.equal(asked.body.status, "pending");
  assert.match(asked.body.summary, /Remove "Diner" from Lake week's restaurants/);
  assert.deepEqual((await lists("lake-jul-2027")).restaurants.map(r => r.name), ["Diner"], "nothing changes yet");
  assert.match((await op("trip.remove-restaurant", { name: "Nowhere" })).body.error, /Nothing called "Nowhere"/, "a mistake is said at once");

  const pid = asked.body.proposalId;
  assert.deepEqual((await call(`/proposals?channel=${LAKE}`)).body.proposals.map(p => [p.id, p.by]), [[pid, "Grandma"]]);
  const fromTrip = await call(`/proposals/${pid}/approve`, { body: { channel: LAKE, actor: ALEX } });
  assert.equal(fromTrip.status, 403, "not from the channel that asked");
  assert.equal((await call(`/proposals/${pid}/approve`, { body: { channel: OPS, actor: SAM } })).status, 403, "not by a child");

  const yes = await call(`/proposals/${pid}/approve`, { body: { channel: OPS, actor: ALEX } });
  assert.equal(yes.body.status, "approved");
  assert.deepEqual((await lists("lake-jul-2027")).restaurants, []);
  const [entry] = (await call(`/log?channel=${LAKE}`)).body.log;
  assert.deepEqual([entry.by, entry.approvedBy], ["Grandma", "alex"]);
  assert.equal((await call(`/proposals/${pid}/approve`, { body: { channel: OPS, actor: ALEX } })).status, 409, "only once");

  await call(`/log/${entry.id}/undo`, { body: { channel: LAKE, actor: ALEX } });
  assert.deepEqual((await lists("lake-jul-2027")).restaurants.map(r => r.name), ["Diner"], "undo puts it back");

  // New dates, approved on the household page with a real sign-in.
  const dates = await op("trip.set-dates", { start: "2027-07-02", end: "2027-07-06" });
  assert.equal(dates.body.status, "pending");
  const page = async (path, member = "alex") => {
    const res = await handleHousehold(new Request(`https://hub.example.com/api/household${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      { ...env, DEV_MEMBER: member }, hubWith(), path, { now: NOW });
    return { status: res.status, body: await res.json() };
  };
  const snap = await page(`/agent/proposals/${dates.body.proposalId}/approve`, "sam");
  assert.equal(snap.status, 403, "only adults approve");
  const ok = await page(`/agent/proposals/${dates.body.proposalId}/approve`);
  assert.equal(ok.status, 200);
  assert.match(ok.body.result, /Changed Lake week's dates from 2027-07-01–2027-07-05 to 2027-07-02–2027-07-06/);
  assert.equal(ok.body.assistant.pending.length, 0);
  const row = await db.prepare("SELECT start_date, end_date FROM trips WHERE id = 'lake-jul-2027'").first();
  assert.deepEqual([row.start_date, row.end_date], ["2027-07-02", "2027-07-06"]);
  const undone = await page(`/agent/log/${ok.body.assistant.log[0].id}/undo`);
  assert.equal(undone.status, 200);
  assert.equal((await db.prepare("SELECT start_date FROM trips WHERE id = 'lake-jul-2027'").first()).start_date, "2027-07-01");
});

test("a waiting change is checked again when approved, and expires", D1, async () => {
  const { op, call, db } = await setup();
  const asked = await op("trip.remove-idea", { text: "Kites" }, LAKE);
  assert.equal(asked.status, 404, "there's no such idea yet");
  await op("trip.add-idea", { text: "Kites" });
  const p = (await op("trip.remove-idea", { text: "kites" })).body.proposalId;
  await db.prepare("UPDATE trips SET details = '{}' WHERE id = 'lake-jul-2027'").run();
  const stale = await call(`/proposals/${p}/approve`, { body: { channel: OPS, actor: ALEX } });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /no longer applies/);

  const later = (await op("trip.set-dates", { start: "2027-07-02", end: "2027-07-06" })).body.proposalId;
  await db.prepare("UPDATE agent_proposals SET expires_at = ? WHERE id = ?").bind(NOW - 1, later).run();
  assert.match((await call(`/proposals/${later}/approve`, { body: { channel: OPS, actor: ALEX } })).body.error, /expired/);
  assert.equal((await call(`/proposals/${later}/reject`, { body: { channel: OPS, actor: ALEX } })).status, 409);
});

test("removing a grocery item waits too, and undo brings it back", D1, async () => {
  const { op, call, env } = await setup();
  await op("grocery.add", { name: "Oat milk" }, FOOD);
  const p = (await op("grocery.remove", { name: "oat milk" }, FOOD)).body;
  assert.equal(p.status, "pending");
  assert.equal((await listGrocery(env)).length, 1);
  const yes = (await call(`/proposals/${p.proposalId}/approve`, { body: { channel: OPS, actor: ALEX } })).body;
  assert.equal((await listGrocery(env)).length, 0);
  await call(`/log/${yes.logId}/undo`, { body: { channel: OPS, actor: ALEX } });
  assert.deepEqual((await listGrocery(env)).map(i => i.name), ["Oat milk"]);
});

// ─── The household's own records ──────────────────────────────────────────────

test("tasks, by the household's own rules, as the person who asked", D1, async () => {
  const PETS = "C0PETS0001", HOUSE = "C0HOUSE001";
  const hub = hubWith();
  hub.agent.channels[PETS] = { scope: "pets" };
  hub.agent.channels[HOUSE] = { scope: "place", place: "place-lake01" };
  const { db, call } = await setup(hub);
  await db.prepare("INSERT INTO pets (id, name, archived, created_at, updated_at) VALUES ('pet-biscuit1', 'Biscuit', 0, 1, 1)").run();
  await db.prepare("INSERT INTO places (id, name, archived, created_at, updated_at) VALUES ('place-lake01', 'Lake house', 0, 1, 1)").run();
  const op = (o, args, channel, actor = ALEX) => call("/ops", { body: { op: o, args, channel, actor } });

  const vet = await op("task.add", { title: "Rabies shot", pet: "biscuit", kind: "vaccination", due: "2027-07-10" }, PETS);
  assert.equal(vet.body.status, "applied", JSON.stringify(vet.body));
  const t = await db.prepare("SELECT * FROM tasks WHERE title = 'Rabies shot'").first();
  assert.deepEqual([t.area, t.kind, t.pet_id, t.due_date, t.updated_by], ["pets", "vaccination", "pet-biscuit1", "2027-07-10", "alex"]);

  assert.equal((await op("task.add", { title: "Mow" }, PETS)).status, 400, "the pets' channel adds pets' tasks");
  assert.equal((await op("task.add", { title: "Fix the gate" }, HOUSE, SAM)).status, 403, "a child can't add a task, as on /household/");
  const gate = await op("task.add", { title: "Fix the gate" }, HOUSE);
  assert.equal((await db.prepare("SELECT place_id, kind FROM tasks WHERE title = 'Fix the gate'").first()).place_id, "place-lake01", "the house's channel picks the house");

  const seen = (await call(`/tasks?channel=${HOUSE}`)).body;
  assert.equal(seen.place, "Lake house");
  assert.deepEqual(seen.tasks.map(x => x.title), [], "an undated fix isn't due");

  const done = await op("task.done", { title: "rabies" }, PETS);
  assert.equal(done.body.status, "applied");
  assert.equal((await db.prepare("SELECT archived FROM tasks WHERE id = ?").bind(t.id).first()).archived, 1, "a one-off is finished");
  await call(`/log/${done.body.logId}/undo`, { body: { channel: PETS, actor: ALEX } });
  assert.equal((await db.prepare("SELECT archived FROM tasks WHERE id = ?").bind(t.id).first()).archived, 0, "undo through the household's own undo");

  const p = (await op("task.archive", { title: "Fix the gate" }, HOUSE)).body;
  assert.equal(p.status, "pending");
  await call(`/proposals/${p.proposalId}/approve`, { body: { channel: OPS, actor: ALEX } });
  assert.equal((await db.prepare("SELECT archived FROM tasks WHERE title = 'Fix the gate'").first()).archived, 1);
  await call(`/log/${gate.body.logId}/undo`, { body: { channel: OPS, actor: ALEX } });
});

test("movies: a family member's mark, and undo restores the one before", D1, async () => {
  const { db, op, call } = await setup();
  await db.prepare("INSERT INTO movies (id, title, kind, source, archived, created_at, updated_at) VALUES ('movie-pond1', 'The Pond', 'movie', 'agent', 0, 1, 1)").run();
  assert.equal((await op("movie.mark", { title: "pond" }, LAKE)).status, 403, "not from a trip channel");
  assert.equal((await op("movie.mark", { title: "pond" }, HOME, GRANDMA)).status, 403, "family only");
  const want = await op("movie.mark", { title: "pond", who: "Sam" }, HOME);
  assert.match(want.body.summary, /Marked "The Pond" as wanted by Sam/);
  await op("movie.mark", { title: "The Pond", mark: "seen" }, HOME, SAM);
  assert.deepEqual((await call(`/movies?channel=${HOME}`)).body.movies[0].seen, ["Sam"]);
  const log = (await call(`/log?channel=${HOME}`)).body.log;
  await call(`/log/${log[0].id}/undo`, { body: { channel: HOME, actor: ALEX } });
  assert.deepEqual((await call(`/movies?channel=${HOME}`)).body.movies[0].want, ["Sam"]);
});

test("the trip form can't quietly undo what the assistant added", D1, async () => {
  const { db, op, env } = await setup();
  const before = (await db.prepare("SELECT updated_at FROM trips WHERE id = 'lake-jul-2027'").first()).updated_at;
  await op("trip.add-idea", { text: "Kites" });
  const save = async updatedAt => handleHousehold(new Request("https://hub.example.com/api/household/trips", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "lake-jul-2027", name: "Lake week", startDate: "2027-07-01", endDate: "2027-07-05", ideas: [], updatedAt }),
  }), { ...env, DEV_MEMBER: "alex" }, hubWith(), "/trips", { now: NOW + 1000 });
  const stale = await save(before);
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /changed since you opened it \(the assistant added to it\)/);
  const fresh = (await db.prepare("SELECT updated_at FROM trips WHERE id = 'lake-jul-2027'").first()).updated_at;
  assert.equal((await save(fresh)).status, 200);
});
