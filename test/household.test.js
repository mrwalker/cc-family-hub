import { test } from "node:test";
import assert from "node:assert/strict";
import { handleHousehold, loadDueTasks, addInterval, nextDue, cleanTask, cleanPet, canComplete, canManage, leadDays } from "../app/worker/household.js";
import { ensureSchema, SCHEMA_VERSION } from "../app/worker/db/migrations.js";
import { byId } from "../app/worker/components/index.js";
import { memoryD1, ctxWith, HUB, NO_SQLITE } from "./helpers.js";

const D1 = { skip: NO_SQLITE };
const BASE = "https://hub.example.com/api/household";

// DEV_MEMBER stands in for a verified sign-in (access.test.js covers the real check).
const as = (member, db) => ({ HUB_DB: db, ...(member ? { DEV_MEMBER: member } : {}) });
// "Now" in these tests is 2027-06-21, noon Pacific.
const NOW = { now: Date.parse("2027-06-21T19:00:00Z") };
const get = env => handleHousehold(new Request(BASE), env, HUB, "", NOW);
const JSON_BODY = { "Content-Type": "application/json" };
const post = (env, path, body) => handleHousehold(new Request(BASE + path, { method: "POST", headers: JSON_BODY, body: JSON.stringify(body ?? {}) }), env, HUB, path, NOW);

const PET = { id: "pet-biscuit", name: "Biscuit", species: "dog" };
const task = (extra = {}) => ({ id: "task-rabies", area: "pets", kind: "vaccination", title: "Rabies shot", petId: PET.id, dueDate: "2027-06-30", ...extra });

/** A database with one pet, as an adult. */
async function withPet() {
  const db = memoryD1();
  const env = as("alex", db);
  assert.equal((await post(env, "/pets", PET)).status, 200);
  return { db, env };
}

// ─── Dates ────────────────────────────────────────────────────────────────────

test("intervals keep the day of the month, or its last day", () => {
  assert.equal(addInterval("2027-06-21", 3, "day"), "2027-06-24");
  assert.equal(addInterval("2027-06-21", 2, "week"), "2027-07-05");
  assert.equal(addInterval("2027-01-31", 1, "month"), "2027-02-28");
  assert.equal(addInterval("2027-11-15", 3, "month"), "2028-02-15");
  assert.equal(addInterval("2028-02-29", 1, "year"), "2029-02-28");
});

test("a task repeats from the day it was done, or keeps to its schedule", () => {
  const filter = { repeatEvery: 3, repeatUnit: "month", repeatFrom: "done", dueDate: "2027-06-01" };
  assert.equal(nextDue(filter, "2027-06-21"), "2027-09-21", "three months after it was changed");
  const pill = { repeatEvery: 1, repeatUnit: "month", repeatFrom: "due", dueDate: "2027-06-01" };
  assert.equal(nextDue(pill, "2027-06-04"), "2027-07-01", "given late, still due on the 1st");
  assert.equal(nextDue(pill, "2027-05-30"), "2027-07-01", "given early, it counts for June's");
  assert.equal(nextDue(pill, "2027-08-15"), "2027-09-01", "skipped months aren't owed");
  assert.equal(nextDue({ dueDate: "2027-06-01" }, "2027-06-01"), null, "a one-off doesn't repeat");
});

// ─── Validation and permissions ───────────────────────────────────────────────

test("tasks and pets are validated", () => {
  const known = { memberIds: new Set(["alex", "sam"]), petIds: new Set([PET.id]) };
  assert.equal(cleanTask(task({ title: "  Rabies   shot " }), known).task.title, "Rabies shot");
  assert.match(cleanTask(task({ id: "x" }), known).error, /^id:/);
  assert.match(cleanTask(task({ area: "garden" }), known).error, /^area:/);
  assert.match(cleanTask(task({ kind: "chore" }), known).error, /^kind:/);
  assert.match(cleanTask(task({ title: " " }), known).error, /^title:/);
  assert.match(cleanTask(task({ petId: "pet-nobody" }), known).error, /^petId:/);
  assert.match(cleanTask(task({ petId: null }), known).error, /^petId:/);
  assert.match(cleanTask(task({ assignee: "pat" }), known).error, /^assignee:/);
  assert.match(cleanTask(task({ dueDate: "June 30" }), known).error, /^dueDate:/);
  assert.match(cleanTask(task({ dueDate: "2027-13-40" }), known).error, /^dueDate:/);
  assert.match(cleanTask(task({ dueTime: "3pm" }), known).error, /^dueTime:/);
  assert.match(cleanTask(task({ repeatEvery: 0, repeatUnit: "month" }), known).error, /^repeatEvery:/);
  assert.match(cleanTask(task({ repeatEvery: 2, repeatUnit: "fortnight" }), known).error, /^repeatUnit:/);
  assert.match(cleanTask(task({ leadDays: 400 }), known).error, /^leadDays:/);
  assert.match(cleanTask(task({ url: "javascript:alert(1)" }), known).error, /^url:/);
  assert.equal(cleanTask(task({ repeatUnit: "month" }), known).task.repeatUnit, null, "a unit without a number doesn't repeat");
  assert.match(cleanPet({ id: "pet-biscuit", name: "" }).error, /^name:/);
  assert.match(cleanPet({ ...PET, birthday: "last spring" }).error, /^birthday:/);
});

test("adults manage; a child completes only their own chore; guests don't write", () => {
  const adult = { id: "alex", role: "adult" }, child = { id: "sam", role: "child" }, guest = { id: "pat", role: "guest" };
  assert.equal(canManage(adult), true);
  for (const v of [child, guest, null]) assert.equal(canManage(v), false);
  const dishes = { kind: "chore", assignee: "sam" };
  assert.equal(canComplete(adult, dishes), true);
  assert.equal(canComplete(child, dishes), true);
  assert.equal(canComplete(child, { kind: "chore", assignee: "riley" }), false, "someone else's chore");
  assert.equal(canComplete(child, { kind: "vaccination", assignee: "sam" }), false, "not a chore");
  assert.equal(canComplete(guest, dishes), false);
  assert.equal(canComplete(null, dishes), false);
});

// ─── A hub without a database ─────────────────────────────────────────────────

test("without a database, household records are simply off", async () => {
  assert.deepEqual(await (await get({})).json(), { enabled: false });
  assert.equal((await post({ DEV_MEMBER: "alex" }, "/pets", PET)).status, 503);
  assert.equal(await loadDueTasks({}, "2027-06-21"), null);
  assert.deepEqual(await byId.pets.cards(ctxWith()), []);
});

// ─── The API ──────────────────────────────────────────────────────────────────

test("the schema is applied once, and again is a no-op", D1, async () => {
  const db = memoryD1();
  await ensureSchema(db);
  await ensureSchema(db);
  assert.equal((await db.prepare("SELECT MAX(version) AS v FROM schema_migrations").first()).v, SCHEMA_VERSION);
  // A second isolate against the same database finds it current.
  const again = { prepare: db.prepare, batch: db.batch };
  await ensureSchema(again);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").first()).n, SCHEMA_VERSION);
});

test("an empty database answers, and makes no cards", D1, async () => {
  const db = memoryD1();
  const body = await (await get(as("alex", db))).json();
  assert.equal(body.enabled, true);
  assert.deepEqual([body.pets, body.tasks, body.log], [[], [], []]);
  assert.deepEqual(body.viewer, { id: "alex", name: "Alex", role: "adult" });
  assert.deepEqual(await loadDueTasks({ HUB_DB: db }, "2027-06-21"), []);
});

test("an adult adds a pet and a task, and edits them", D1, async () => {
  const { db, env } = await withPet();
  let body = await (await post(env, "/tasks", task({ provider: "Oak Vet", phone: "555-0100" }))).json();
  assert.deepEqual(body.tasks.map(t => [t.title, t.petName, t.dueDate, t.provider]), [["Rabies shot", "Biscuit", "2027-06-30", "Oak Vet"]]);
  body = await (await post(env, "/tasks", task({ title: "Rabies booster", dueDate: "2027-07-02" }))).json();
  assert.deepEqual(body.tasks.map(t => [t.title, t.dueDate, t.provider]), [["Rabies booster", "2027-07-02", null]], "the same id is an edit");
  body = await (await post(env, "/pets", { ...PET, name: "Biscuit II" })).json();
  assert.deepEqual(body.pets.map(p => p.name), ["Biscuit II"]);
  const row = await db.prepare("SELECT created_by, updated_by FROM tasks").first();
  assert.deepEqual(row, { created_by: "alex", updated_by: "alex" }, "who changed it comes from the sign-in");
});

test("who made a change can't be set from the request", D1, async () => {
  const { db, env } = await withPet();
  await post(env, "/tasks", task({ createdBy: "sam", updatedBy: "sam", created_by: "sam" }));
  await post(env, "/tasks/task-rabies/done", { doneBy: "sam", done_by: "sam" });
  assert.equal((await db.prepare("SELECT created_by FROM tasks").first()).created_by, "alex");
  assert.equal((await db.prepare("SELECT done_by FROM task_log").first()).done_by, "alex");
});

test("bad input is refused with what's wrong", D1, async () => {
  const { env } = await withPet();
  const res = await post(env, "/tasks", task({ dueDate: "soon" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /^dueDate:/);
  const notJson = await handleHousehold(new Request(BASE + "/tasks", { method: "POST", headers: JSON_BODY, body: "{nope" }), env, HUB, "/tasks", NOW);
  assert.equal(notJson.status, 400);
  assert.equal((await post(env, "/tasks/task-missing/done")).status, 404);
  assert.equal((await post(env, "/nonsense")).status, 404);
  assert.equal((await handleHousehold(new Request(BASE, { method: "DELETE" }), env, HUB, "", NOW)).status, 405);
});

test("a form posted from another site can't write", D1, async () => {
  const { env } = await withPet();
  // What a cross-site <form enctype="text/plain"> can send: JSON-shaped text, but not as JSON.
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    const req = new Request(BASE + "/pets", { method: "POST", headers: { "Content-Type": type }, body: JSON.stringify({ id: "pet-other1", name: "Other" }) });
    assert.equal((await handleHousehold(req, env, HUB, "/pets", NOW)).status, 415, type);
  }
  assert.equal((await (await get(env)).json()).pets.length, 1);
});

test("children, guests and strangers can't manage records", D1, async () => {
  const { db, env } = await withPet();
  await post(env, "/tasks", task());
  for (const [who, label] of [["sam", "a child"], ["pat", "a guest"]]) {
    const e = as(who, db);
    assert.equal((await post(e, "/pets", { id: "pet-other1", name: "Other" })).status, 403, `${label}: pets`);
    assert.equal((await post(e, "/tasks", task({ id: "task-other" }))).status, 403, `${label}: tasks`);
    assert.equal((await post(e, "/tasks/task-rabies/archive")).status, 403, `${label}: archive`);
    assert.equal((await post(e, "/tasks/task-rabies/done")).status, 403, `${label}: done`);
    assert.equal((await post(e, "/tasks/task-rabies/undo")).status, 403, `${label}: undo`);
    assert.equal((await get(e)).status, 200, `${label} can still read`);
  }
  const body = await (await get(as("alex", db))).json();
  assert.deepEqual([body.pets.length, body.tasks.length, body.tasks[0].archived, body.log.length], [1, 1, false, 0], "nothing changed");
});

test("with no way to check the sign-in, writes are refused and reads say why", D1, async () => {
  const { db } = await withPet();
  const env = { HUB_DB: db };   // no DEV_MEMBER, and HUB has no hub.access
  const res = await post(env, "/pets", { id: "pet-other1", name: "Other" });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /hub\.access/);
  const body = await (await get(env)).json();
  assert.equal(body.viewer, null);
  assert.equal(body.can.manage, false);
  assert.match(body.problem, /hub\.access/);
  assert.equal(body.pets.length, 1, "reading still works");
});

test("DEV_MEMBER is ignored for a request that came through Cloudflare", D1, async () => {
  const { db } = await withPet();
  const req = new Request(BASE + "/pets", { method: "POST", headers: { ...JSON_BODY, "CF-Ray": "8a1b2c3d4e5f-DFW" }, body: JSON.stringify({ id: "pet-other1", name: "Other" }) });
  assert.equal((await handleHousehold(req, as("alex", db), HUB, "/pets", NOW)).status, 503);
});

test("done moves a repeating task on and logs it; undo puts it back", D1, async () => {
  const { env } = await withPet();
  await post(env, "/tasks", task({ dueDate: "2027-06-01", repeatEvery: 1, repeatUnit: "year", repeatFrom: "done" }));
  let body = await (await post(env, "/tasks/task-rabies/done", { doneOn: "2027-06-10", note: "3-year vaccine next time" })).json();
  assert.deepEqual(body.tasks.map(t => [t.dueDate, t.archived]), [["2028-06-10", false]]);
  assert.deepEqual(body.log.map(l => [l.title, l.doneOn, l.doneBy, l.note]), [["Rabies shot", "2027-06-10", "alex", "3-year vaccine next time"]]);
  body = await (await post(env, "/tasks/task-rabies/undo")).json();
  assert.deepEqual(body.tasks.map(t => [t.dueDate, t.archived]), [["2027-06-01", false]]);
  assert.deepEqual(body.log, []);
  assert.equal((await post(env, "/tasks/task-rabies/undo")).status, 400, "nothing left to undo");
});

test("done finishes a one-off; undo and archive bring it back or put it away", D1, async () => {
  const { env } = await withPet();
  await post(env, "/tasks", task({ id: "task-dental", kind: "vet-visit", title: "Dental cleaning", dueTime: "09:30" }));
  let body = await (await post(env, "/tasks/task-dental/done")).json();
  assert.equal(body.tasks[0].archived, true);
  assert.equal(body.log[0].doneOn, "2027-06-21", "done today unless told otherwise");
  assert.equal((await post(env, "/tasks/task-dental/done")).status, 400, "an archived task can't be done again");
  body = await (await post(env, "/tasks/task-dental/undo")).json();
  assert.deepEqual([body.tasks[0].archived, body.tasks[0].dueDate], [false, "2027-06-30"]);
  body = await (await post(env, "/tasks/task-dental/archive")).json();
  assert.equal(body.tasks[0].archived, true);
  body = await (await post(env, "/tasks/task-dental/archive", { archived: false })).json();
  assert.equal(body.tasks[0].archived, false);
  assert.equal((await post(env, "/tasks/task-dental/done", { doneOn: "2999-01-01" })).status, 400, "not in the future");
});

// ─── The house ────────────────────────────────────────────────────────────────

const houseTask = (extra = {}) => ({ id: "task-filter1", area: "house", kind: "maintenance", title: "HVAC filter", dueDate: "2027-06-18", repeatEvery: 3, repeatUnit: "month", ...extra });

test("house tasks: a fix can wait without a date; a pet can't be attached", D1, async () => {
  const { env } = await withPet();
  let res = await post(env, "/tasks", houseTask({ petId: PET.id }));
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.tasks[0].petId, null, "a house task belongs to no pet");
  assert.match((await (await post(env, "/tasks", houseTask({ id: "task-kind01", kind: "vaccination" }))).json()).error, /^kind:/);
  body = await (await post(env, "/tasks", { id: "task-squeak", area: "house", kind: "fix", title: "Squeaky door", dueDate: null, assignee: "alex" })).json();
  assert.deepEqual(body.tasks.filter(t => t.area === "house").map(t => [t.title, t.dueDate, t.assignee]), [["HVAC filter", "2027-06-18", null], ["Squeaky door", null, "alex"]]);
  body = await (await post(env, "/tasks/task-squeak/done")).json();
  assert.equal(body.tasks.find(t => t.id === "task-squeak").archived, true, "a fix is done once");
  body = await (await post(env, "/tasks/task-filter1/done", { doneOn: "2027-06-20" })).json();
  assert.equal(body.tasks.find(t => t.id === "task-filter1").dueDate, "2027-09-20");
  assert.deepEqual(body.log.map(l => [l.title, l.area]), [["HVAC filter", "house"], ["Squeaky door", "house"]]);
});

test("house cards: overdue maintenance, an upcoming service, and no card for a fix without a date", async () => {
  const t = (id, kind, title, dueDate, extra = {}) => ({ id, area: "house", kind, title, petName: null, dueDate, dueTime: null, assignee: null, leadDays: null, provider: null, ...extra });
  const household = [
    t("a", "maintenance", "HVAC filter", "2027-06-02", { repeatEvery: 3, repeatUnit: "month" }),
    t("b", "service", "Lawn", "2027-06-23", { dueTime: "08:00", provider: "Green Co" }),
    t("c", "service", "Cleaning", "2027-06-28", { provider: "Sparkle" }),     // past a service's 2 days
    t("d", "fix", "Squeaky door", null),
    t("e", "maintenance", "Smoke detector batteries", "2027-06-21", { assignee: "sam" }),
    { ...t("f", "vaccination", "Rabies shot", "2027-06-21"), area: "pets", petName: "Biscuit" },
  ];
  const cards = await byId.house.cards(ctxWith({ household }));
  assert.deepEqual(cards.map(c => [c.id, c.title, c.glance.headline, c.glance.detail]), [
    ["house:a", "House", "HVAC filter overdue", "Due Jun 2 · 19 days ago"],
    ["house:e", "House", "Smoke detector batteries due today", "Sam"],
    ["house:b", "House", "Lawn in 2 days", "Green Co · Wed, Jun 23 · 8:00 AM"],
  ]);
  assert.equal(cards[0].url, "https://hub.example.com/household/#house");
  const [alex, sam] = HUB.members;
  assert.deepEqual((await byId.house.cards(ctxWith({ household, view: alex }))).map(c => c.id), ["house:a", "house:b"]);
  assert.deepEqual((await byId.house.cards(ctxWith({ household, view: sam }))).map(c => c.id), ["house:e"]);
});

// ─── The planner's export ─────────────────────────────────────────────────────

const exportReq = (token, query = "") => new Request(`${BASE}/export${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const exportAs = (env, token, query) => handleHousehold(exportReq(token, query), { ...env, PUBLISH_TOKEN: "pub-secret" }, HUB, "/export", NOW);

test("the export needs the publish token, and a sign-in isn't enough", D1, async () => {
  const { env } = await withPet();
  assert.equal((await exportAs(env, null)).status, 401);
  assert.equal((await exportAs(env, "wrong")).status, 401);
  assert.equal((await handleHousehold(exportReq("pub-secret"), env, HUB, "/export", NOW)).status, 503, "no PUBLISH_TOKEN on the Worker");
  assert.equal((await exportAs(env, "pub-secret")).status, 200);
});

test("without a database the export says it's off", async () => {
  assert.deepEqual(await (await exportAs({}, "pub-secret")).json(), { enabled: false });
});

test("the export has what's due soon or overdue, and what was lately done, by name", D1, async () => {
  const { env } = await withPet();
  await post(env, "/tasks", task({ id: "task-late01", kind: "medication", title: "Heartworm pill", dueDate: "2027-06-01", repeatEvery: 1, repeatUnit: "month", repeatFrom: "due" }));
  await post(env, "/tasks", task({ id: "task-soon01", dueDate: "2027-06-30", provider: "Oak Vet" }));
  await post(env, "/tasks", task({ id: "task-far001", dueDate: "2027-09-01" }));
  await post(env, "/tasks", task({ id: "task-brush1", kind: "grooming", title: "Brush", dueDate: "2027-06-15", assignee: "sam", repeatEvery: 1, repeatUnit: "week" }));
  await post(env, "/tasks/task-brush1/done", { doneOn: "2027-06-20", note: "Matted behind the ears" });
  const body = await (await exportAs(env, "pub-secret")).json();
  assert.equal(body.today, "2027-06-21");
  assert.deepEqual(body.pets, [{ name: "Biscuit", species: "dog", birthday: null, notes: null }]);
  assert.deepEqual(body.tasks.map(t => [t.title, t.pet, t.dueDate, t.daysUntil, t.overdue, t.repeats]), [
    ["Heartworm pill", "Biscuit", "2027-06-01", -20, true, "every month"],
    ["Brush", "Biscuit", "2027-06-27", 6, false, "every week"],
    ["Rabies shot", "Biscuit", "2027-06-30", 9, false, null],
  ], "the far-off task waits");
  assert.equal(body.tasks[1].assignee, "Sam");
  assert.deepEqual(body.recent, [{ title: "Brush", area: "pets", pet: "Biscuit", place: null, doneOn: "2027-06-20", doneBy: "Alex", note: "Matted behind the ears" }]);
  const wider = await (await exportAs(env, "pub-secret", "?days=90")).json();
  assert.equal(wider.days, 60, "at most 60 days ahead");
  assert.equal(wider.tasks.length, 3, "September is still past 60 days");
  assert.ok(!JSON.stringify(body).includes("task-"), "names, not ids");
});

// ─── Cards ────────────────────────────────────────────────────────────────────

test("the stream reads what could show today, with one query's worth of rows", D1, async () => {
  const { db, env } = await withPet();
  await post(env, "/tasks", task({ id: "task-soon01", dueDate: "2027-07-10" }));
  await post(env, "/tasks", task({ id: "task-far001", dueDate: "2027-12-01" }));
  await post(env, "/tasks", task({ id: "task-nodate", dueDate: null }));
  await post(env, "/tasks", task({ id: "task-gone01", dueDate: "2027-06-22" }));
  await post(env, "/tasks/task-gone01/archive");
  const due = await loadDueTasks({ HUB_DB: db }, "2027-06-21");
  assert.deepEqual(due.map(t => [t.id, t.petName]), [["task-soon01", "Biscuit"]]);
});

test("a task gets a card when it's overdue or close, overdue first", async () => {
  const t = (id, kind, title, dueDate, extra = {}) => ({ id, area: "pets", kind, title, petName: "Biscuit", dueDate, dueTime: null, assignee: null, leadDays: null, ...extra });
  // Today is 2027-06-21.
  const household = [
    t("a", "medication", "Heartworm pill", "2027-06-04", { repeatEvery: 1, repeatUnit: "month" }),
    t("b", "grooming", "Nail trim", "2027-06-21"),
    t("c", "vet-visit", "Checkup", "2027-06-23", { booked: true, apptDate: "2027-06-22", apptTime: "15:30", provider: "Oak Vet", phone: "555-0100" }),
    t("d", "vaccination", "Rabies shot", "2027-06-30"),
    t("e", "grooming", "Bath", "2027-07-15"),                       // further off than grooming's 14 days
    t("f", "grooming", "Haircut", "2027-07-15", { leadDays: 30 }),  // its own lead time
  ];
  const cards = await byId.pets.cards(ctxWith({ household }));
  assert.deepEqual(cards.map(c => [c.id, c.glance.headline, c.glance.detail]), [
    ["pets:a", "Heartworm pill overdue", "Biscuit · Due Jun 4 · 17 days ago"],
    ["pets:b", "Nail trim due today", "Biscuit · not booked yet"],
    ["pets:c", "Checkup tomorrow", "Biscuit · 3:30 PM"],
    ["pets:d", "Rabies shot due in 9 days", "Biscuit · Wed, Jun 30 · not booked yet"],
    ["pets:f", "Haircut due in 24 days", "Biscuit · Thu, Jul 15 · not booked yet"],
  ]);
  assert.equal(cards[0].url, "https://hub.example.com/household/#pets");
  assert.deepEqual(cards[0].data.task, {
    id: "a", kind: "medication", title: "Heartworm pill", pet: "Biscuit", pets: ["Biscuit"], place: null, assignee: null,
    dueDate: "2027-06-04", dueTime: null, date: "2027-06-04", daysUntil: -17, overdue: true,
    booked: false, apptDate: null, apptTime: null, endDate: null, needsBooking: false,
    repeats: "Every month", provider: undefined, phone: undefined,
  });
  assert.equal(cards[2].data.task.date, "2027-06-22", "a booked appointment's date is what counts");
  assert.equal(leadDays(household[5]), 30);
});

test("a missed appointment asks whether it happened", async () => {
  const household = [{ id: "c", area: "pets", kind: "vet-visit", title: "Checkup", petName: "Biscuit", dueDate: "2027-06-20", booked: true, apptDate: "2027-06-20", assignee: null }];
  const [card] = await byId.pets.cards(ctxWith({ household }));
  assert.deepEqual([card.glance.headline, card.glance.detail], ["Checkup: done?", "Biscuit · Was Jun 20 · 1 day ago"]);
});

test("a member's view keeps what's theirs; unassigned tasks are for the adults", async () => {
  const [alex, sam] = HUB.members;
  const household = [
    { id: "a", area: "pets", kind: "grooming", title: "Brush", petName: "Biscuit", dueDate: "2027-06-21", assignee: "sam" },
    { id: "b", area: "pets", kind: "grooming", title: "Bath", petName: "Biscuit", dueDate: "2027-06-21", assignee: null },
  ];
  const ids = async view => (await byId.pets.cards(ctxWith({ household, view }))).map(c => c.id);
  assert.deepEqual(await ids(null), ["pets:a", "pets:b"]);
  assert.deepEqual(await ids(alex), ["pets:b"]);
  assert.deepEqual(await ids(sam), ["pets:a"]);
});

// ─── Places, groups, booking and stays (v2.3) ─────────────────────────────────

const DOGS = [["pet-peppr1", "Pepper"], ["pet-mochi1", "Mochi"], ["pet-waffl1", "Waffles"], ["pet-junip1", "Juniper"]];

/** A database with four dogs, as an adult. */
async function withDogs() {
  const db = memoryD1();
  const env = as("alex", db);
  for (const [id, name] of DOGS) assert.equal((await post(env, "/pets", { id, name, species: "Dog" })).status, 200);
  return { db, env };
}

/** The same task for several dogs, as the page sends it. */
const forDogs = (groupId, ids, extra) => ({ tasks: ids.map(id => ({ id: `${groupId}-${id.slice(4)}`, area: "pets", petId: id, groupId, ...extra })) });

test("places: a house task belongs to a place, and a card says which", D1, async () => {
  const { env } = await withDogs();
  let body = await (await post(env, "/places", { id: "place-home1", name: "Home", address: "1 Main St" })).json();
  body = await (await post(env, "/places", { id: "place-farm1", name: "The farm" })).json();
  assert.deepEqual(body.places.map(p => p.name), ["Home", "The farm"]);
  assert.match((await (await post(env, "/tasks", houseTask({ placeId: "place-nope1" }))).json()).error, /^placeId:/);
  body = await (await post(env, "/tasks", houseTask({ placeId: "place-farm1", dueDate: "2027-06-22" }))).json();
  assert.equal(body.tasks[0].placeName, "The farm");
  const [card] = await byId.house.cards(ctxWith({ household: body.tasks }));
  assert.deepEqual([card.glance.headline, card.glance.detail], ["HVAC filter due tomorrow", "The farm"]);
  assert.equal((await post(as("sam", env.HUB_DB), "/places", { id: "place-kid01", name: "Fort" })).status, 403, "only adults");
});

test("a task for several dogs: one card while they share a day, each dog its own history", D1, async () => {
  const { env } = await withDogs();
  const all = DOGS.map(d => d[0]);
  let body = await (await post(env, "/tasks", forDogs("grp-heart1", all, { kind: "medication", title: "Heartworm pill", dueDate: "2027-06-22", repeatEvery: 1, repeatUnit: "month", repeatFrom: "due" }))).json();
  assert.equal(body.tasks.length, 4);
  let cards = await byId.pets.cards(ctxWith({ household: body.tasks }));
  assert.deepEqual(cards.map(c => [c.id, c.glance.headline, c.glance.detail]), [["pets:grp-heart1:2027-06-22", "Heartworm pill due tomorrow", "4 dogs"]]);
  assert.deepEqual(cards[0].data.task.pets.sort(), ["Juniper", "Mochi", "Pepper", "Waffles"]);

  // Mochi gets hers early: just Mochi moves on.
  body = await (await post(env, "/tasks/grp-heart1-mochi1/done")).json();
  const mochi = body.tasks.find(t => t.petName === "Mochi");
  assert.equal(mochi.dueDate, "2027-07-22");
  cards = await byId.pets.cards(ctxWith({ household: body.tasks.filter(t => !t.archived) }));
  assert.deepEqual(cards.map(c => [c.glance.headline, c.glance.detail]), [["Heartworm pill due tomorrow", "Pepper, Waffles & Juniper"]]);

  // The rest together, then undo that in one go.
  body = await (await post(env, "/tasks/grp-heart1-peppr1/done", { group: true })).json();
  assert.deepEqual([...new Set(body.tasks.map(t => t.dueDate))], ["2027-07-22"], "every dog moved on, and Mochi, already there, didn't move again");
  const action = body.log[0].actionId;
  assert.equal(body.log.filter(l => l.actionId === action).length, 3, "the three that shared the card");
  body = await (await post(env, "/undo", { actionId: action })).json();
  assert.deepEqual(body.tasks.map(t => [t.petName, t.dueDate]).sort(), [["Juniper", "2027-06-22"], ["Mochi", "2027-07-22"], ["Pepper", "2027-06-22"], ["Waffles", "2027-06-22"]]);
  assert.equal(body.log.length, 1, "Mochi's own done stays");
});

test("booking: an appointment has its own date and time, and done uses it up", D1, async () => {
  const { env } = await withDogs();
  let body = await (await post(env, "/tasks", forDogs("grp-teeth1", ["pet-peppr1"], { kind: "dental", title: "Teeth cleaning", dueDate: "2027-07-01", repeatEvery: 1, repeatUnit: "year", provider: "Oak Vet" }))).json();
  let [card] = await byId.pets.cards(ctxWith({ household: body.tasks }));
  assert.deepEqual([card.glance.headline, card.glance.detail], ["Teeth cleaning due in 10 days", "Pepper · Thu, Jul 1 · not booked yet"]);
  assert.equal(card.data.task.needsBooking, true);
  const booked = { ...body.tasks[0], booked: true, apptDate: "2027-06-24", apptTime: "09:30" };
  body = await (await post(env, "/tasks", booked)).json();
  [card] = await byId.pets.cards(ctxWith({ household: body.tasks }));
  assert.deepEqual([card.glance.headline, card.glance.detail], ["Teeth cleaning in 3 days", "Pepper · Thu, Jun 24 · 9:30 AM"]);
  assert.match((await (await post(env, "/tasks", { ...booked, apptTime: "9:30am" })).json()).error, /^apptTime:/);
  body = await (await post(env, "/tasks/grp-teeth1-peppr1/done", { doneOn: "2027-06-21" })).json();
  assert.deepEqual([body.tasks[0].dueDate, body.tasks[0].booked, body.tasks[0].apptDate], ["2028-06-21", false, null], "next year's isn't booked yet");
  body = await (await post(env, "/tasks/grp-teeth1-peppr1/undo")).json();
  assert.deepEqual([body.tasks[0].dueDate, body.tasks[0].booked, body.tasks[0].apptDate, body.tasks[0].apptTime], ["2027-07-01", true, "2027-06-24", "09:30"], "undo restores the booking");
});

test("boarding: a stay for some of the dogs, shown until they're home", D1, async () => {
  const { env } = await withDogs();
  const stay = { kind: "boarding", title: "Boarding", dueDate: "2027-06-25", endDate: "2027-06-29", provider: "Paws Inn" };
  assert.match((await (await post(env, "/tasks", forDogs("grp-stay01", ["pet-peppr1"], { ...stay, endDate: "2027-06-20" }))).json()).error, /endDate:/);
  let body = await (await post(env, "/tasks", forDogs("grp-stay01", ["pet-peppr1", "pet-mochi1"], stay))).json();
  const card = async (today, tasks = body.tasks) => (await byId.pets.cards(ctxWith({ household: tasks, now: new Date(`${today}T19:00:00Z`) })))[0];
  let c = await card("2027-06-21");
  assert.deepEqual([c.glance.headline, c.glance.detail], ["Boarding in 4 days", "Pepper & Mochi · Jun 25 – 29 · not booked yet"]);
  body = await (await post(env, "/tasks", { tasks: body.tasks.map(t => ({ ...t, booked: true, apptDate: "2027-06-25", apptTime: "08:00" })) })).json();
  c = await card("2027-06-21");
  assert.deepEqual([c.glance.headline, c.glance.detail], ["Boarding in 4 days", "Pepper & Mochi · Jun 25 – 29 · Paws Inn · 8:00 AM"]);
  c = await card("2027-06-27");
  assert.deepEqual([c.glance.headline, c.glance.detail], ["Boarding: home Tue, Jun 29", "Pepper & Mochi · Paws Inn"]);
  c = await card("2027-06-29");
  assert.equal(c.glance.headline, "Boarding: home today");
  c = await card("2027-06-30");
  assert.deepEqual([c.glance.headline, c.glance.detail], ["Boarding: done?", "Pepper & Mochi · Ended Jun 29"]);
  body = await (await post(env, "/tasks/grp-stay01-peppr1/done", { group: true })).json();
  assert.ok(body.tasks.every(t => t.archived), "a one-off stay is finished");
});

test("editing a group: change them all, add a dog, take one out", D1, async () => {
  const { env } = await withDogs();
  let body = await (await post(env, "/tasks", forDogs("grp-rabie1", ["pet-peppr1", "pet-mochi1"], { kind: "vaccination", title: "Rabies", dueDate: "2027-08-01" }))).json();
  const edit = forDogs("grp-rabie1", ["pet-peppr1", "pet-waffl1"], { kind: "vaccination", title: "Rabies (3-year)", dueDate: "2027-08-01", repeatEvery: 3, repeatUnit: "year" });
  body = await (await post(env, "/tasks", { ...edit, archive: ["grp-rabie1-mochi1"] })).json();
  assert.deepEqual(body.tasks.map(t => [t.petName, t.title, t.archived]).sort(), [["Mochi", "Rabies", true], ["Pepper", "Rabies (3-year)", false], ["Waffles", "Rabies (3-year)", false]]);
  const tooMany = { tasks: Array.from({ length: 51 }, (_, i) => ({ ...edit.tasks[0], id: `task-many${String(i).padStart(2, "0")}` })) };
  assert.equal((await post(env, "/tasks", tooMany)).status, 400);
  const bad = await (await post(env, "/tasks", { tasks: [edit.tasks[0], { ...edit.tasks[1], dueDate: "soon" }] })).json();
  assert.match(bad.error, /^tasks\[1\]\.dueDate:/, "says which one");
});

test("the migration from v2.2 keeps tasks and their history", D1, async () => {
  const db = memoryD1();
  // A v2.2 database: migration 1 only, with a task done once.
  const { MIGRATIONS } = await import("../app/worker/db/migrations.js");
  db.sqlite.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const s of MIGRATIONS[0].statements) db.sqlite.exec(s);
  db.sqlite.exec("INSERT INTO schema_migrations VALUES (1, 0)");
  db.sqlite.exec("INSERT INTO tasks (id, area, kind, title, due_date, repeat_every, repeat_unit, created_at, updated_at) VALUES ('task-septic', 'house', 'service', 'Septic', '2027-09-01', 1, 'year', 0, 0)");
  db.sqlite.exec("INSERT INTO task_log (id, task_id, done_on, due_before, created_at) VALUES ('log-1', 'task-septic', '2026-09-01', '2026-09-01', 0)");
  const env = as("alex", db);
  let body = await (await get(env)).json();
  assert.deepEqual(body.tasks.map(t => [t.title, t.placeId, t.booked]), [["Septic", null, false]]);
  body = await (await post(env, "/tasks/task-septic/undo")).json();
  assert.equal(body.tasks[0].dueDate, "2026-09-01", "a pre-v2.3 log row still undoes");
});

test("a save that never arrived is reported, and logged", async () => {
  const logged = [];
  const log = console.log;
  console.log = s => logged.push(s);
  try {
    const res = await handleHousehold(new Request(`${BASE}/diag?path=%2Fpets&error=Load%20failed&name=TypeError`, { headers: { "User-Agent": "iPhone Safari" } }), {}, HUB, "/diag", NOW);
    assert.equal(res.status, 204);
  } finally { console.log = log; }
  assert.deepEqual(JSON.parse(logged[0]), { household: "save-failed", path: "/pets", error: "Load failed", name: "TypeError", online: "", page: "", ua: "iPhone Safari" });
});
