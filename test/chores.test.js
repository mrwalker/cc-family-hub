import { test } from "node:test";
import assert from "node:assert/strict";
import { holders, occurrence, dayView, weekOf, cleanChore, assigneesOf } from "../app/worker/chores.js";
import { handleHousehold, householdExport } from "../app/worker/household.js";
import { byId } from "../app/worker/components/index.js";
import { ensureSchema } from "../app/worker/db/migrations.js";
import { memoryD1, HUB, NO_SQLITE, ctxWith } from "./helpers.js";

const D1 = { skip: NO_SQLITE };
const BASE = "https://hub.example.com/api/household";
// 2027-06-21 is a Monday; noon Pacific.
const MONDAY = "2027-06-21";
const NOON = { now: Date.parse("2027-06-21T19:00:00Z") };
const hub = {
  ...HUB,
  members: [
    ...HUB.members,
    { id: "riley", name: "Riley", color: "#16a34a", role: "child", calendars: [], emails: ["riley@example.com"] },
    { id: "kai", name: "Kai", color: "#d97706", role: "child", calendars: [], emails: ["kai@example.com"] },
  ],
};
const JOBS = [{ id: "job-trash", name: "Trash" }, { id: "job-dogs", name: "Dogs" }, { id: "job-dish", name: "Dishes" }];
const ROTATION = { people: ["sam", "riley", "kai"], anchorWeek: "2027-06-14", startsOn: 1, direction: 1 };

// ─── Pure ─────────────────────────────────────────────────────────────────────

test("weeks start on the rotation's day", () => {
  assert.equal(weekOf("2027-06-21", 1), "2027-06-21");
  assert.equal(weekOf("2027-06-27", 1), "2027-06-21", "Sunday belongs to the week before");
  assert.equal(weekOf("2027-06-27", 0), "2027-06-27");
});

test("jobs move one along each week, either way, and a swap changes one week", () => {
  assert.deepEqual(holders(ROTATION, JOBS, [], "2027-06-14"), { "job-trash": "sam", "job-dogs": "riley", "job-dish": "kai" });
  assert.deepEqual(holders(ROTATION, JOBS, [], "2027-06-21"), { "job-trash": "kai", "job-dogs": "sam", "job-dish": "riley" });
  assert.deepEqual(holders({ ...ROTATION, direction: -1 }, JOBS, [], "2027-06-21"), { "job-trash": "riley", "job-dogs": "kai", "job-dish": "sam" });
  assert.deepEqual(holders(ROTATION, JOBS, [], "2027-07-05"), holders(ROTATION, JOBS, [], "2027-06-14"), "three kids: back round in three weeks");
  const swaps = [{ week: "2027-06-21", jobId: "job-trash", member: "sam" }];
  assert.equal(holders(ROTATION, JOBS, swaps, "2027-06-21")["job-trash"], "sam");
  assert.equal(holders(ROTATION, JOBS, swaps, "2027-06-28")["job-trash"], "riley", "only that week");
});

test("a shared chore belongs to both job holders; a chore with people belongs to them", () => {
  const held = holders(ROTATION, JOBS, [], MONDAY);
  assert.deepEqual(assigneesOf({ jobIds: ["job-dogs", "job-dish"] }, held), ["sam", "riley"]);
  assert.deepEqual(assigneesOf({ jobIds: ["job-dogs"], people: ["kai"] }, held), ["kai"]);
});

test("each schedule comes round on the right days", () => {
  const c = extra => ({ id: "c1", title: "x", archived: false, everyWeeks: 1, ...extra });
  assert.deepEqual(occurrence(c({ cadence: "daily" }), MONDAY), { period: MONDAY });
  assert.equal(occurrence(c({ cadence: "daily", days: [6, 0] }), MONDAY), null, "weekends only");
  const tuesday = c({ cadence: "weekly", days: [2] });
  assert.equal(occurrence(tuesday, MONDAY), null);
  assert.deepEqual(occurrence(tuesday, "2027-06-22"), { period: "2027-06-22" });
  // Every other Tuesday, from the week of the 21st.
  const recycling = c({ cadence: "weekly", days: [2], everyWeeks: 2, anchorWeek: "2027-06-23" });
  assert.ok(occurrence(recycling, "2027-06-22"));
  assert.equal(occurrence(recycling, "2027-06-29"), null);
  assert.ok(occurrence(recycling, "2027-07-06"));
  assert.ok(occurrence(recycling, "2027-06-08"), "and backwards");
  assert.deepEqual(occurrence(c({ cadence: "weekly" }), "2027-06-24"), { period: MONDAY, anyDay: true, dueBy: "2027-06-27" });
  const summer = c({ cadence: "daily", seasonFrom: "06-01", seasonTo: "09-30" });
  assert.ok(occurrence(summer, MONDAY));
  assert.equal(occurrence(summer, "2027-10-01"), null);
  assert.ok(occurrence(c({ cadence: "daily", seasonFrom: "11-01", seasonTo: "02-28" }), "2027-12-25"), "a season across the new year");
  assert.equal(occurrence(c({ cadence: "when-asked" }), MONDAY), null, "not asked");
  assert.deepEqual(occurrence(c({ cadence: "when-asked", askedFor: "2027-06-26" }), MONDAY), { period: "2027-06-26" });
  assert.equal(occurrence(c({ cadence: "daily", archived: true }), MONDAY), null);
});

test("the day's view: late after its time, done when ticked, missed once the day is over, nothing owed twice", () => {
  const state = {
    jobs: JOBS.map((j, i) => ({ ...j, position: i, archived: false })),
    rotation: ROTATION, swaps: [],
    chores: [
      { id: "feed01", title: "Feed the dogs", jobIds: ["job-dogs"], people: [], cadence: "daily", time: "16:30", timeKind: "at", everyWeeks: 1, archived: false },
      { id: "dish01", title: "Dishes", jobIds: ["job-dish"], people: [], cadence: "daily", everyWeeks: 1, archived: false },
      { id: "trash1", title: "Kitchen trash", jobIds: ["job-trash"], people: [], cadence: "as-needed", everyWeeks: 1, archived: false },
      { id: "bins01", title: "Bins to the curb", jobIds: ["job-trash"], people: [], cadence: "weekly", days: [2], everyWeeks: 1, archived: false },
    ],
    log: [
      { choreId: "dish01", period: MONDAY, createdAt: 1, doneBy: "alex" },
      { choreId: "trash1", period: MONDAY, createdAt: 2, doneBy: "kai" },
      { choreId: "trash1", period: MONDAY, createdAt: 3, doneBy: "kai" },
    ],
  };
  const members = hub.members;
  const status = (view, who, id) => view.people.find(p => p.id === who).chores.find(c => c.id === id)?.status;

  let view = dayView(state, MONDAY, { minutes: 12 * 60, members });
  assert.deepEqual(view.people.map(p => p.id), ["sam", "riley", "kai"], "rotation order");
  assert.deepEqual(view.people.find(p => p.id === "sam").jobs, ["Dogs"]);
  assert.equal(status(view, "sam", "feed01"), "todo");
  assert.equal(status(view, "riley", "dish01"), "done");
  assert.equal(view.people.find(p => p.id === "kai").chores.find(c => c.id === "trash1").count, 2);
  assert.equal(view.people.find(p => p.id === "sam").chores[0].when, "at 4:30 PM");

  view = dayView(state, MONDAY, { minutes: 17 * 60 + 5, members });
  assert.equal(status(view, "sam", "feed01"), "late");
  assert.equal(status(view, "kai", "bins01"), "tomorrow", "from 5 PM, tomorrow's bins show");

  view = dayView(state, MONDAY, { minutes: null, members });
  assert.equal(status(view, "sam", "feed01"), "missed");
  view = dayView(state, "2027-06-22", { minutes: 8 * 60, members });
  assert.equal(view.people.find(p => p.id === "sam").chores.filter(c => c.id === "feed01").length, 1, "one feed today, not two");
  assert.equal(status(view, "sam", "feed01"), "todo");
});

test("a chore is checked as it's saved", () => {
  const known = { memberIds: new Set(["sam"]), jobIds: new Set(["job-dogs"]), today: MONDAY };
  assert.match(cleanChore({ id: "c00001", title: "x", cadence: "daily" }, known).error, /a job or a person/);
  assert.match(cleanChore({ id: "c00001", title: "x", cadence: "hourly", jobIds: ["job-dogs"] }, known).error, /cadence/);
  assert.match(cleanChore({ id: "c00001", title: "x", cadence: "daily", jobIds: ["job-nope"] }, known).error, /not a job/);
  assert.match(cleanChore({ id: "c00001", title: "x", cadence: "daily", jobIds: ["job-dogs"], seasonFrom: "06-01" }, known).error, /season/);
  const { chore } = cleanChore({ id: "c00001", title: " Bins ", cadence: "weekly", days: [2], everyWeeks: 2, jobIds: ["job-dogs"], time: "07:00" }, known);
  assert.deepEqual([chore.title, chore.days, chore.anchorWeek, chore.timeKind], ["Bins", [2], MONDAY, "at"]);
});

// ─── The API ──────────────────────────────────────────────────────────────────

function setup() {
  const db = memoryD1();
  const env = { HUB_DB: db, DEV_MEMBER: "alex" };
  const as = member => async (path, body, opts = NOON) => {
    env.DEV_MEMBER = member;
    const res = await handleHousehold(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }), env, hub, path, opts);
    return { status: res.status, body: await res.json() };
  };
  const get = async (path = "", opts = NOON) => (await handleHousehold(new Request(BASE + path), env, hub, path.split("?")[0], opts)).json();
  return { db, env, as, get };
}

async function setUp(alex) {
  await alex("/chores/jobs", { jobs: JOBS });
  await alex("/chores/rotation", { people: ["sam", "riley", "kai"], anchorWeek: "2027-06-23", direction: 1 });
  const { body } = await alex("/chores", { chores: [
    { id: "feed01", title: "Feed the dogs", jobIds: ["job-dogs"], cadence: "daily", time: "16:30" },
    { id: "poop01", title: "Pick up the yard", jobIds: ["job-dogs", "job-dish"], cadence: "weekly" },
    { id: "mow001", title: "Mow the neighbor's yard", people: ["riley", "kai"], cadence: "when-asked" },
  ] });
  return body;
}

test("adults set chores up; the page sees who has which job and today's chores", D1, async () => {
  const { as } = setup();
  const body = await setUp(as("alex"));
  assert.equal(body.chores.setUp, true);
  assert.deepEqual(body.chores.view.jobs.map(j => j.member), ["sam", "riley", "kai"], "anchored this week");
  const sam = body.chores.view.people.find(p => p.id === "sam");
  assert.deepEqual(sam.chores.map(c => c.id).sort(), []);
  const riley = body.chores.view.people.find(p => p.id === "riley");
  assert.deepEqual(riley.chores.map(c => c.id).sort(), ["feed01", "poop01"]);
  assert.deepEqual(riley.chores.find(c => c.id === "poop01").with, ["kai"]);
  assert.equal(body.can.tick, true);
  // Next week the jobs move on.
  assert.deepEqual(Object.values(body.chores.holders["2027-06-28"]), ["kai", "sam", "riley"]);
});

test("kids can't set chores up", D1, async () => {
  const { as } = setup();
  for (const [path, body] of [["/chores/jobs", { jobs: JOBS }], ["/chores", { id: "c00001", title: "x", cadence: "daily", people: ["sam"] }],
    ["/chores/rotation", { people: ["sam"], anchorWeek: MONDAY }], ["/chores/swap", { week: MONDAY, jobId: "job-trash", member: "sam" }]]) {
    assert.equal((await as("sam")(path, body)).status, 403, path);
  }
});

test("anyone in the family ticks any chore, once; the log keeps whose it was and who ticked it", D1, async () => {
  const { as, db } = setup();
  await setUp(as("alex"));
  // Sam ticks Riley's feed: the honor system, as at the wall tablet.
  const first = await as("sam")("/chores/feed01/done", {});
  assert.equal(first.status, 200);
  assert.ok(first.body.actionId);
  const riley = first.body.chores.view.people.find(p => p.id === "riley");
  assert.equal(riley.chores.find(c => c.id === "feed01").status, "done");
  const row = await db.prepare("SELECT * FROM chore_log").first();
  assert.deepEqual([JSON.parse(row.done_for), row.done_by, row.period], [["riley"], "sam", MONDAY]);
  assert.equal((await as("riley")("/chores/feed01/done", {})).status, 409, "already done");
  // A guest can't.
  assert.equal((await as("pat")("/chores/feed01/done", {})).status, 403);
  // Not due that day, or too long ago.
  assert.equal((await as("sam")("/chores/mow001/done", {})).status, 400, "not asked for");
  assert.equal((await as("sam")("/chores/feed01/done", { day: "2027-06-01" })).status, 400);
  // Yesterday's, forgotten, can still be ticked.
  assert.equal((await as("sam")("/chores/feed01/done", { day: "2027-06-20" })).status, 200);
});

test("a tick is taken back by whoever made it that day, or by an adult", D1, async () => {
  const { as } = setup();
  await setUp(as("alex"));
  const { body } = await as("sam")("/chores/feed01/done", {});
  assert.equal((await as("riley")("/undo", { actionId: body.actionId })).status, 403, "not Riley's tick");
  const undone = await as("sam")("/undo", { actionId: body.actionId });
  assert.equal(undone.status, 200);
  assert.equal(undone.body.chores.view.people.find(p => p.id === "riley").chores.find(c => c.id === "feed01").status, "todo");
  const again = await as("sam")("/chores/feed01/done", {});
  const nextDay = { now: NOON.now + 86_400_000 };
  assert.equal((await as("sam")("/undo", { actionId: again.body.actionId }, nextDay)).status, 403, "not the next day");
  assert.equal((await as("alex")("/undo", { actionId: again.body.actionId }, nextDay)).status, 200, "an adult can");
});

test("a when-asked chore shows once asked, goes when done, and comes back on undo", D1, async () => {
  const { as } = setup();
  await setUp(as("alex"));
  let { body } = await as("alex")("/chores/mow001/ask", { by: "2027-06-26" });
  const kai = () => body.chores.view.people.find(p => p.id === "kai").chores.find(c => c.id === "mow001");
  assert.equal(kai().status, "todo");
  ({ body } = await as("kai")("/chores/mow001/done", {}));
  assert.equal(kai(), undefined);
  ({ body } = await as("kai")("/undo", { actionId: body.actionId }));
  assert.equal(kai().status, "todo");
  assert.equal((await as("kai")("/chores/mow001/ask", { by: MONDAY })).status, 403, "only adults ask");
});

test("a swap gives one week's job to someone else", D1, async () => {
  const { as } = setup();
  await setUp(as("alex"));
  const { body } = await as("alex")("/chores/swap", { week: "2027-06-23", jobId: "job-dogs", member: "kai" });
  assert.equal(body.chores.view.jobs.find(j => j.id === "job-dogs").member, "kai");
  assert.ok(body.chores.view.people.find(p => p.id === "kai").chores.some(c => c.id === "feed01"));
  const back = await as("alex")("/chores/swap", { week: MONDAY, jobId: "job-dogs", member: null });
  assert.equal(back.body.chores.view.jobs.find(j => j.id === "job-dogs").member, "riley");
});

test("another day's chores can be looked at", D1, async () => {
  const { as, get } = setup();
  await setUp(as("alex"));
  const body = await get("/chores?day=2027-06-20");
  assert.equal(body.chores.day, "2027-06-20");
  assert.equal(body.chores.view.people.find(p => p.id === "kai").chores.find(c => c.id === "feed01").status, "missed", "the week before, Kai had the dogs; Sunday's feed was missed");
});

test("the planner hears who has which job, today's chores, and this week's misses", D1, async () => {
  const { as, env } = setup();
  await setUp(as("alex"));
  const out = await householdExport(env, hub, { now: NOON.now + 2 * 86_400_000 });
  assert.deepEqual(out.chores.jobs, [{ job: "Trash", member: "Sam" }, { job: "Dogs", member: "Riley" }, { job: "Dishes", member: "Kai" }]);
  assert.deepEqual(out.chores.missedThisWeek.map(m => [m.person, m.chore, m.day]), [["Riley", "Feed the dogs", "2027-06-21"], ["Riley", "Feed the dogs", "2027-06-22"]]);
  assert.ok(out.chores.today.find(p => p.person === "Riley").chores.some(c => c.title === "Feed the dogs"));
});

test("without chores, the export says so", D1, async () => {
  const { env } = setup();
  await ensureSchema(env.HUB_DB);
  assert.equal((await householdExport(env, hub, NOON)).chores, null);
});

// ─── The component ───────────────────────────────────────────────────────────

const VIEW = {
  day: MONDAY, week: MONDAY,
  jobs: [{ id: "job-trash", name: "Trash", member: "sam" }, { id: "job-dogs", name: "Dogs", member: "riley" }],
  people: [
    { id: "sam", name: "Sam", color: "#db2777", jobs: ["Trash"], chores: [
      { id: "bins01", title: "Bins to the curb", cadence: "weekly", status: "done", when: "", time: null },
      { id: "trash1", title: "Kitchen trash", cadence: "as-needed", status: "todo", when: "", time: null, count: 0 },
    ] },
    { id: "riley", name: "Riley", color: "#16a34a", jobs: ["Dogs"], chores: [
      { id: "feed01", title: "Feed the dogs", cadence: "daily", status: "todo", when: "at 4:30 PM", time: "16:30" },
      { id: "poop01", title: "Pick up the yard", cadence: "weekly", status: "todo", when: "", time: null },
    ] },
  ],
};

test("the family sees how many are done and who's next; on the week's first day, the new jobs", async () => {
  // 3 PM Pacific: the 4:30 feed is within two hours, so it's next.
  const ctx = ctxWith({ chores: { view: VIEW }, now: new Date("2027-06-21T22:00:00Z") });
  const [today, week] = await byId.chores.cards(ctx);
  assert.equal(today.glance.headline, "1 of 3 chores done");
  assert.equal(today.glance.detail, "Next: Riley · Feed the dogs at 4:30 PM");
  assert.deepEqual(today.glance.colors, ["#16a34a"]);
  assert.equal(today.url, "https://hub.example.com/household/#chores");
  assert.equal(week.glance.detail, "Sam: Trash · Riley: Dogs");
  // Tuesday: no new-jobs card.
  const tue = await byId.chores.cards(ctxWith({ chores: { view: { ...VIEW, day: "2027-06-22" } }, now: new Date("2027-06-22T22:00:00Z") }));
  assert.equal(tue.length, 1);
});

test("a kid's view shows only their chores", async () => {
  const riley = hub.members.find(m => m.id === "riley");
  const [card] = await byId.chores.cards(ctxWith({ chores: { view: VIEW }, view: riley, now: new Date("2027-06-21T22:00:00Z") }));
  assert.equal(card.title, "Your chores");
  assert.equal(card.glance.headline, "Feed the dogs at 4:30 PM");
  assert.equal(card.glance.detail, "0 of 2 done · Dogs");
  assert.deepEqual(card.data.people.map(p => p.id), ["riley"]);
  const alex = hub.members.find(m => m.id === "alex");
  assert.equal((await byId.chores.cards(ctxWith({ chores: { view: VIEW }, view: alex })))[0].id, "chores:today", "an adult sees the family's");
  assert.deepEqual(await byId.chores.cards(ctxWith({ chores: null })), []);
});

test("next is a late chore, then one due soon, then today's, then later ones, then this week's", async () => {
  const { nextUp } = await import("../app/worker/chores.js");
  const p = (id, chores) => ({ id, name: id, chores });
  const ch = (id, extra) => ({ id, title: id, cadence: "daily", status: "todo", time: null, ...extra });
  const view = chores => ({ people: [p("sam", chores)] });
  const week = ch("yard", { cadence: "weekly", anyDay: true });
  const dishes = ch("dishes");
  const feed = ch("feed", { time: "16:30" });
  assert.equal(nextUp(view([week, dishes, feed]), 10 * 60).id, "dishes", "the 4:30 feed is hours away");
  assert.equal(nextUp(view([week, dishes, feed]), 15 * 60).id, "feed", "within two hours");
  assert.equal(nextUp(view([week, ch("late", { status: "late", time: "07:00" }), feed]), 15 * 60).id, "late");
  assert.equal(nextUp(view([week, feed]), 10 * 60).id, "feed", "a timed one today beats this week's");
  assert.equal(nextUp(view([ch("x", { status: "done" })]), 0), null);
});
