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
const post = (env, path, body) => handleHousehold(new Request(BASE + path, { method: "POST", body: JSON.stringify(body ?? {}) }), env, HUB, path, NOW);

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
  assert.equal(nextDue(pill, "2027-05-30"), "2027-06-01", "given early, the date it was for stands");
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
  const notJson = await handleHousehold(new Request(BASE + "/tasks", { method: "POST", body: "{nope" }), env, HUB, "/tasks", NOW);
  assert.equal(notJson.status, 400);
  assert.equal((await post(env, "/tasks/task-missing/done")).status, 404);
  assert.equal((await post(env, "/nonsense")).status, 404);
  assert.equal((await handleHousehold(new Request(BASE, { method: "DELETE" }), env, HUB, "", NOW)).status, 405);
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
  const req = new Request(BASE + "/pets", { method: "POST", headers: { "CF-Ray": "8a1b2c3d4e5f-DFW" }, body: JSON.stringify({ id: "pet-other1", name: "Other" }) });
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
    t("c", "vet-visit", "Checkup", "2027-06-22", { dueTime: "15:30", provider: "Oak Vet", phone: "555-0100" }),
    t("d", "vaccination", "Rabies shot", "2027-06-30"),
    t("e", "grooming", "Bath", "2027-07-15"),                       // further off than grooming's 7 days
    t("f", "grooming", "Haircut", "2027-07-15", { leadDays: 30 }),  // its own lead time
  ];
  const cards = await byId.pets.cards(ctxWith({ household }));
  assert.deepEqual(cards.map(c => [c.id, c.glance.headline, c.glance.detail]), [
    ["pets:a", "Heartworm pill overdue", "Biscuit · Due Jun 4 · 17 days ago"],
    ["pets:b", "Nail trim due today", "Biscuit"],
    ["pets:c", "Checkup tomorrow", "Biscuit · 3:30 PM"],
    ["pets:d", "Rabies shot due in 9 days", "Biscuit · Wed, Jun 30"],
    ["pets:f", "Haircut due in 24 days", "Biscuit · Thu, Jul 15"],
  ]);
  assert.equal(cards[0].url, "https://hub.example.com/household/#pets");
  assert.deepEqual(cards[0].data.task, {
    id: "a", kind: "medication", title: "Heartworm pill", pet: "Biscuit", assignee: null,
    dueDate: "2027-06-04", dueTime: null, daysUntil: -17, overdue: true, repeats: "Every month", provider: undefined, phone: undefined,
  });
  assert.equal(leadDays(household[5]), 30);
});

test("a missed appointment asks whether it happened", async () => {
  const household = [{ id: "c", area: "pets", kind: "vet-visit", title: "Checkup", petName: "Biscuit", dueDate: "2027-06-20", assignee: null }];
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
