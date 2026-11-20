import { test } from "node:test";
import assert from "node:assert/strict";
import { handleHousehold } from "../app/worker/household.js";
import { wantedEvents } from "../app/worker/household-calendar.js";
import { memoryD1, HUB, NO_SQLITE } from "./helpers.js";

const D1 = { skip: NO_SQLITE };
const BASE = "https://hub.example.com/api/household";
const CAL = "household@group.calendar.google.com";
const hub = { ...HUB, householdCalendar: CAL };
const NOW = { now: Date.parse("2027-06-21T19:00:00Z") };

/** A Google Calendar in memory. Deleting an event leaves it, cancelled, as Google does. */
function fakeCalendar() {
  const events = new Map();
  let n = 0;
  const calls = [];
  return {
    events, calls,
    live: () => [...events.values()].filter(e => e.status !== "cancelled"),
    async list(calendarId) { calls.push("list"); assert.equal(calendarId, CAL); return [...events.values()].map(e => structuredClone(e)); },
    async insert(calendarId, event) { calls.push("insert"); const e = { ...structuredClone(event), id: `ev${++n}`, status: "confirmed" }; events.set(e.id, e); return e; },
    async patch(calendarId, id, event) {
      calls.push("patch");
      const e = events.get(id);
      if (!e || e.status === "cancelled") throw new Error("Google Calendar 404: gone");
      Object.assign(e, structuredClone(event));
      return e;
    },
    async remove(calendarId, id) { calls.push("remove"); const e = events.get(id); if (e) e.status = "cancelled"; return null; },
    // What someone does in Google Calendar.
    move(id, start, end) { Object.assign(events.get(id), { start, end }); },
    delete(id) { events.get(id).status = "cancelled"; },
  };
}

function setup(google = fakeCalendar(), h = hub) {
  const db = memoryD1();
  const env = { HUB_DB: db, DEV_MEMBER: "alex" };
  const opts = { ...NOW, google };
  const post = async (path, body) => {
    const res = await handleHousehold(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }), env, h, path, opts);
    return res.json();
  };
  const get = async () => (await handleHousehold(new Request(BASE), env, h, "", opts)).json();
  return { db, env, google, post, get };
}

const pets = async post => {
  await post("/pets", { id: "pet-peppr1", name: "Pepper", species: "Dog" });
  await post("/pets", { id: "pet-mochi1", name: "Mochi", species: "Dog" });
};
const pair = extra => ({ tasks: [["task-a-peppr", "pet-peppr1"], ["task-a-mochi", "pet-mochi1"]].map(([id, petId]) => ({ id, petId, area: "pets", groupId: "grp-a00001", ...extra })) });

test("a booked appointment for two pets is one timed event; nothing unbooked goes on", D1, async () => {
  const { post, google } = setup();
  await pets(post);
  await post("/tasks", pair({ kind: "dental", title: "Teeth cleaning", dueDate: "2027-07-01", provider: "Oak Vet", phone: "555-0100" }));
  assert.equal(google.live().length, 0, "not booked: not on the calendar");
  await post("/tasks", pair({ kind: "dental", title: "Teeth cleaning", dueDate: "2027-07-01", provider: "Oak Vet", phone: "555-0100", booked: true, apptDate: "2027-06-24", apptTime: "23:30" }));
  const [e] = google.live();
  assert.equal(google.live().length, 1);
  assert.equal(e.summary, "🦷 Teeth cleaning: Mochi & Pepper");
  assert.deepEqual(e.start, { dateTime: "2027-06-24T23:30:00", timeZone: "America/Los_Angeles" });
  assert.deepEqual(e.end, { dateTime: "2027-06-25T00:30:00", timeZone: "America/Los_Angeles" }, "an hour, past midnight");
  assert.match(e.description, /With: Oak Vet \(555-0100\)/);
  assert.match(e.description, /On the hub: https:\/\/hub\.example\.com\/household\/#pets/);
  assert.deepEqual(e.extendedProperties.private, { hub: "household", hubKey: "task-a-mochi,task-a-peppr" });
});

test("changing a booking updates its event; finishing removes it, and undo brings it back", D1, async () => {
  const { post, get, google } = setup();
  await pets(post);
  const booked = { kind: "vet-visit", title: "Checkup", dueDate: "2027-07-01", repeatEvery: 1, repeatUnit: "year", booked: true, apptDate: "2027-06-24", apptTime: "09:00" };
  await post("/tasks", pair(booked));
  await post("/tasks", pair({ ...booked, apptTime: "10:15" }));
  assert.deepEqual(google.calls.filter(c => c !== "list"), ["insert", "patch"]);
  assert.equal(google.live()[0].start.dateTime, "2027-06-24T10:15:00");
  // Saving again with nothing changed writes nothing.
  await post("/tasks", pair({ ...booked, apptTime: "10:15" }));
  assert.equal(google.calls.filter(c => c === "patch").length, 1);
  // Done for both: next year's isn't booked, so the event goes.
  await post("/tasks/task-a-peppr/done", { group: true });
  assert.equal(google.live().length, 0);
  // Undo brings the booking, and the event, back.
  const body = await post("/undo", { actionId: (await get()).log[0].actionId });
  assert.equal(body.tasks.filter(t => t.booked).length, 2);
  assert.equal(google.live().length, 1);
});

test("a stay is an all-day event from drop-off through pick-up", D1, async () => {
  const { post, google } = setup();
  await pets(post);
  await post("/tasks", pair({ kind: "boarding", title: "Boarding", dueDate: "2027-06-25", endDate: "2027-06-29", booked: true, apptDate: "2027-06-25", apptTime: "08:00", provider: "Paws Inn" }));
  const [e] = google.live();
  assert.deepEqual([e.start, e.end], [{ date: "2027-06-25" }, { date: "2027-06-30" }], "Google's end date is the day after");
  assert.match(e.description, /Drop off: 08:00/);
});

test("moving an event in Google Calendar moves the booking, and the hub doesn't move it back", D1, async () => {
  const { post, get, google } = setup();
  await pets(post);
  await post("/tasks", pair({ kind: "grooming", title: "Grooming", dueDate: "2027-07-01", booked: true, apptDate: "2027-06-24", apptTime: "09:00" }));
  const [e] = google.live();
  google.move(e.id, { dateTime: "2027-06-26T14:00:00-07:00" }, { dateTime: "2027-06-26T15:00:00-07:00" });
  const body = await get();
  assert.deepEqual(body.tasks.map(t => [t.apptDate, t.apptTime]), [["2027-06-26", "14:00"], ["2027-06-26", "14:00"]]);
  assert.equal(body.calendar.problem, null);
  const [after] = google.live();
  assert.equal(after.start.dateTime.slice(0, 16), "2027-06-26T14:00", "still where it was moved to");
  assert.equal(google.live().length, 1, "the same event, not a new one");
});

test("moving a stay in Google Calendar changes its dates", D1, async () => {
  const { post, get, google } = setup();
  await pets(post);
  await post("/tasks", pair({ kind: "boarding", title: "Boarding", dueDate: "2027-06-25", endDate: "2027-06-29", booked: true, apptDate: "2027-06-25" }));
  google.move(google.live()[0].id, { date: "2027-06-26" }, { date: "2027-07-02" });
  const body = await get();
  assert.deepEqual(body.tasks.map(t => [t.dueDate, t.apptDate, t.endDate]), [["2027-06-26", "2027-06-26", "2027-07-01"], ["2027-06-26", "2027-06-26", "2027-07-01"]]);
  assert.deepEqual([google.live()[0].start, google.live()[0].end], [{ date: "2027-06-26" }, { date: "2027-07-02" }]);
});

test("deleting a booking's event in Google Calendar leaves it not booked", D1, async () => {
  const google = fakeCalendar();
  const { post, get } = setup(google);
  await pets(post);
  await post("/tasks", pair({ kind: "vet-visit", title: "Checkup", dueDate: "2027-07-01", booked: true, apptDate: "2027-06-24", apptTime: "09:00" }));
  google.delete(google.live()[0].id);
  const body = await get();
  assert.deepEqual(body.tasks.map(t => [t.booked, t.apptDate]), [[false, null], [false, null]]);
  assert.equal(google.live().length, 0, "and it isn't put back");
});

test("a service visit goes on by its date; deleted there, it stays off until the date changes", D1, async () => {
  const google = fakeCalendar();
  const { post, get } = setup(google);
  await post("/places", { id: "place-home1", name: "Home", address: "1 Main St" });
  const lawn = { id: "task-lawn01", area: "house", kind: "service", title: "Lawn", placeId: "place-home1", dueDate: "2027-06-23", dueTime: "08:00", provider: "Green Co" };
  await post("/tasks", lawn);
  let [e] = google.live();
  assert.equal(e.summary, "🧹 Lawn (Home)");
  assert.equal(e.location, "1 Main St");
  google.delete(e.id);
  await get();
  await post("/tasks", { ...lawn, notes: "Gate code 1234" });
  assert.equal(google.live().length, 0, "an edit that doesn't change the day leaves it off");
  await post("/tasks", { ...lawn, dueDate: "2027-06-30" });
  [e] = google.live();
  assert.equal(e.start.dateTime, "2027-06-30T08:00:00");
});

test("when the calendar fails, the save still happens and the page says why", D1, async () => {
  const broken = { ...fakeCalendar(), insert: async () => { throw new Error('Google Calendar 403: forbidden. Is the calendar shared with sa@example.com ("Make changes to events")?'); } };
  const { post } = setup(broken);
  await pets(post);
  const body = await post("/tasks", pair({ kind: "vet-visit", title: "Checkup", dueDate: "2027-07-01", booked: true, apptDate: "2027-06-24" }));
  assert.equal(body.tasks.length, 2, "saved");
  assert.match(body.calendar.problem, /shared with/);
});

test("without a household calendar, Google is never called", D1, async () => {
  const google = fakeCalendar();
  const { post, get } = setup(google, HUB);
  await pets(post);
  await post("/tasks", pair({ kind: "vet-visit", title: "Checkup", dueDate: "2027-07-01", booked: true, apptDate: "2027-06-24" }));
  const body = await get();
  assert.deepEqual(google.calls, []);
  assert.deepEqual(body.calendar, { on: false, problem: null });
});

test("unbooked tasks, archived ones and plain deadlines aren't events", () => {
  const t = extra => ({ id: "t1", area: "pets", kind: "vaccination", title: "Rabies", dueDate: "2027-07-01", archived: false, ...extra });
  const opts = { timezone: "UTC", hubUrl: "https://hub/" };
  assert.deepEqual(wantedEvents([t({})], opts), {});
  assert.deepEqual(wantedEvents([t({ booked: true, apptDate: "2027-06-30", archived: true })], opts), {});
  assert.deepEqual(wantedEvents([t({ kind: "medication" })], opts), {});
  assert.equal(Object.keys(wantedEvents([t({ booked: true, apptDate: "2027-06-30" })], opts)).length, 1);
});
