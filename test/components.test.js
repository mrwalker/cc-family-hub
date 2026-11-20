import { test } from "node:test";
import assert from "node:assert/strict";
import { byId } from "../app/worker/components/index.js";
import { ctxWith, HUB } from "./helpers.js";

// "Now" in these tests is 2027-06-21, noon Pacific.
const ev = (title, startAt, endAt, memberId, extra = {}) => ({ id: `e-${title}`, title, startAt, endAt, allDay: false, memberId, ...extra });
const alex = HUB.members[0], sam = HUB.members[1];

test("every card has a complete envelope and glance", async () => {
  const ctx = ctxWith({
    events: [ev("Soccer", "2027-06-21T15:20:00-07:00", "2027-06-21T16:30:00-07:00", "sam")],
    data: {
      plan: { weekStarting: "2027-06-21", summary: "A busy week. Lots on.", flags: [], actionItems: [{ description: "Buy cleats", priority: "high" }] },
      family: {
        trips: [{ id: "beach", name: "Beach Week", startDate: "2027-07-03", endDate: "2027-07-09", emoji: "🏖️" },
                { id: "ski", name: "Ski Cabin", startDate: "2026-12-26", endDate: "2027-01-02" }],
        escapeRooms: [{ room: "Mystic Manor", venue: "Puzzle Co", solved: true, date: "2027-01-01" }],
        movies: [{ id: "odyssey", title: "The Odyssey", releaseDate: "2027-07-17", status: "want-to-watch" }],
      },
      strava: { members: { alex: [{ name: "Run", startDate: "2027-06-20T14:00:00Z", distance: 5000 }] } },
    },
    photos: [{ id: "p1", width: 1536, height: 1024, takenAt: "2027-06-01T18:00:00Z" }],
    grocery: [{ id: "g1abcd", name: "Milk", quantity: 1, done: false, addedAt: 1 }],
    household: [
      { id: "t1abcd", area: "pets", kind: "vaccination", title: "Rabies shot", petName: "Biscuit", dueDate: "2027-06-30", assignee: null },
      { id: "t2abcd", area: "house", kind: "maintenance", title: "HVAC filter", petName: null, dueDate: "2027-06-18", assignee: null },
    ],
    chores: { view: { day: "2027-06-21", week: "2027-06-21", jobs: [{ id: "job-dish", name: "Dishes", member: "sam" }],
      people: [{ id: "sam", name: "Sam", color: "#db2777", jobs: ["Dishes"], chores: [{ id: "dish01", title: "Dishes", cadence: "daily", status: "todo", when: "", time: null }] }] } },
    pets: [{ id: "pet-biscuit", name: "Biscuit", species: "Dog", birthday: "2023-01-10", photos: [] }],
  });
  for (const [id, c] of Object.entries(byId)) {
    const cards = await c.cards(ctx);
    assert.ok(cards.length, `${id} made a card`);
    for (const card of cards) {
      assert.equal(typeof card.id, "string", `${id}: id`);
      assert.equal(typeof card.title, "string", `${id}: title`);
      assert.match(card.url, /^https:\/\/hub\.example\.com\//, `${id}: url`);
      assert.equal(typeof card.glance.headline, "string", `${id}: glance.headline`);
      assert.ok(card.glance.headline.length, `${id}: glance.headline is not empty`);
      assert.equal(typeof card.glance.detail, "string", `${id}: glance.detail`);
      assert.equal(typeof card.data, "object", `${id}: data`);
    }
  }
});

test("components with nothing to show make no cards", async () => {
  const ctx = ctxWith();
  for (const id of ["week", "plan", "pets", "house", "chores", "pet-portraits", "photos", "trips", "past-trips", "grocery", "escape-rooms", "movies", "workouts"]) {
    assert.deepEqual(await byId[id].cards(ctx), [], id);
  }
  assert.equal((await byId.today.cards(ctx)).length, 1, "today always has a card");
});

test("today's glance is the next timed event, with how long until it starts", async () => {
  const ctx = ctxWith({ events: [
    ev("Breakfast", "2027-06-21T08:00:00-07:00", "2027-06-21T09:00:00-07:00", "alex"),
    ev("Soccer", "2027-06-21T12:25:00-07:00", "2027-06-21T13:30:00-07:00", "sam"),
    ev("Dentist", "2027-06-22T09:00:00-07:00", "2027-06-22T10:00:00-07:00", "alex"),
  ] });
  const [card] = await byId.today.cards(ctx);
  assert.equal(card.glance.headline, "Soccer");
  assert.equal(card.glance.detail, "12:25 PM · in 25 min");
  assert.deepEqual(card.glance.colors, ["#db2777"]);
  assert.deepEqual(card.data.events.map(e => [e.title, e.day]), [["Soccer", "Today"], ["Dentist", "Tomorrow"]], "finished events are gone");
});

test("a shared invite is one event with everyone's colors, and a member's view keeps only theirs", async () => {
  const events = [
    ev("Dinner", "2027-06-21T18:00:00-07:00", "2027-06-21T19:00:00-07:00", "alex"),
    ev("Dinner", "2027-06-21T18:00:00-07:00", "2027-06-21T19:00:00-07:00", "sam"),
    ev("Work call", "2027-06-21T14:00:00-07:00", "2027-06-21T15:00:00-07:00", "alex"),
    ev("Skipped", "2027-06-21T16:00:00-07:00", "2027-06-21T17:00:00-07:00", "sam", { declined: true }),
  ];
  const [family] = await byId.today.cards(ctxWith({ events }));
  assert.deepEqual(family.data.events.map(e => [e.title, e.members]), [["Work call", ["alex"]], ["Dinner", ["alex", "sam"]]]);
  const [samsDay] = await byId.today.cards(ctxWith({ events, view: sam }));
  assert.deepEqual(samsDay.data.events.map(e => e.title), ["Dinner"]);
});

test("urgent plan flags ride on the today card", async () => {
  const plan = { weekStarting: "2027-06-21", summary: "x.", flags: [
    { severity: "urgent", message: "Two pickups at 3pm", relatedMemberIds: ["sam"] },
    { severity: "warning", message: "Rain Thursday" },
  ] };
  const [card] = await byId.today.cards(ctxWith({ data: { plan } }));
  assert.deepEqual(card.data.flags, [{ severity: "urgent", message: "Two pickups at 3pm" }]);
  const [alexDay] = await byId.today.cards(ctxWith({ data: { plan }, view: alex }));
  assert.deepEqual(alexDay.data.flags, [], "a flag about Sam stays off Alex's card");
});

test("trips are upcoming, active or past by their dates; an active trip leads", async () => {
  const family = { trips: [
    { id: "lake", name: "Lake", startDate: "2027-06-20", endDate: "2027-06-23", who: ["alex", "sam"] },
    { id: "beach", name: "Beach", startDate: "2027-07-03", endDate: "2027-07-09", who: ["alex"], status: "past" },
    { id: "ski", name: "Ski", startDate: "2027-01-02", endDate: "2027-01-05", status: "upcoming" },
    { id: "conf", name: "Conference", startDate: "2027-06-25", endDate: "2027-06-27", type: "work" },
  ] };
  const ctx = ctxWith({ data: { family } });
  const trips = await byId.trips.cards(ctx);
  assert.deepEqual(trips.map(c => [c.id, c.glance.headline, !!c.leads]), [["trips:lake", "Day 2 of 4", true], ["trips:beach", "12 days", false]]);
  assert.deepEqual((await byId["past-trips"].cards(ctx)).map(c => c.id), ["past-trips:ski"], "status in trips.yaml doesn't override the dates; work trips stay out");
  const samTrips = await byId.trips.cards(ctxWith({ data: { family }, view: sam }));
  assert.deepEqual(samTrips.map(c => c.id), ["trips:lake"]);
});

test("a trip app adds its hero, leaderboard and link; after the trip, the final standings stay", async () => {
  const hub = { ...HUB, tripApps: [{ trip: "lake", path: "/lake/", appId: "lake-2027" }] };
  const app = { trip: "lake", path: "/lake/", start: "2027-06-01", end: "2027-06-05", hero: true, resort: "Cabin 4",
                leaderboard: [{ id: "sam", name: "Sam", color: "#db2777", points: 40, quests: 6 }], questsDone: 6, questsTotal: 20, today: [] };
  const ctx = ctxWith({ hub, data: { family: { trips: [{ id: "lake", name: "Lake", startDate: "2027-06-01", endDate: "2027-06-05" }] } }, trips: [app] });
  const [past] = await byId["past-trips"].cards(ctx);
  assert.equal(past.url, "https://hub.example.com/lake/");
  assert.equal(past.glance.image, "https://hub.example.com/api/stream/image/past-trips%3Alake");
  assert.match(past.glance.detail, /Sam won$/);
  assert.equal(past.data.leaderboard[0].points, 40);
});

test("movies list what you want to watch, soonest first", async () => {
  const family = { movies: [
    { id: "b", title: "Later", releaseDate: "2027-08-01", status: "want-to-watch" },
    { id: "a", title: "Sooner", releaseDate: "2027-06-01", status: "want-to-watch", format: "IMAX" },
    { id: "c", title: "Seen", releaseDate: "2027-05-01", status: "watched" },
  ] };
  const cards = await byId.movies.cards(ctxWith({ data: { family } }));
  assert.deepEqual(cards.map(c => [c.glance.headline, c.glance.detail]), [["Later", "Out Aug 1"], ["Sooner", "Out now · IMAX"]],
    "coming soon before what's already out");
});

test("grocery shows what's left to buy", async () => {
  const grocery = [
    { id: "a", name: "Eggs", quantity: 1, done: true, addedAt: 1 },
    { id: "b", name: "Milk", quantity: 2, done: false, addedAt: 2 },
    { id: "c", name: "Bread", quantity: 1, done: false, addedAt: 3 },
  ];
  const [card] = await byId.grocery.cards(ctxWith({ grocery }));
  assert.equal(card.glance.headline, "2 items");
  assert.equal(card.glance.detail, "Milk, Bread");
  assert.deepEqual(card.data.items.map(i => i.name), ["Milk", "Bread", "Eggs"]);
  assert.deepEqual(await byId.grocery.cards(ctxWith({ grocery: [grocery[0]] })), []);
});

const ALBUM = "https://photos.icloud.com/shared/album/B0aaaaaaaaaaaa";

test("a trip's own album gives its card photos, and the link never leaves the server", async () => {
  const family = { trips: [
    { id: "ski", name: "Ski", startDate: "2027-01-02", endDate: "2027-01-05", album: ALBUM },
    { id: "lake", name: "Lake", startDate: "2027-06-20", endDate: "2027-06-23", album: ALBUM },
    { id: "old", name: "Old", startDate: "2026-01-02", endDate: "2026-01-05" },
  ] };
  const photos = Array.from({ length: 20 }, (_, i) => ({ id: `P${i}`, width: 10, height: 10, takenAt: null }));
  const ctx = ctxWith({ data: { family }, albums: { [ALBUM]: photos } });
  const past = await byId["past-trips"].cards(ctx);
  const ski = past.find(c => c.id === "past-trips:ski");
  assert.match(ski.glance.image, /^https:\/\/hub\.example\.com\/api\/stream\/image\/trip-photo%3Aski%3AP\d+$/);
  assert.equal(ski.data.album.count, 20);
  assert.equal(ski.data.album.photos.length, 12);
  assert.equal(ski.data.album.photos[0], ski.glance.image);
  assert.equal(past.find(c => c.id === "past-trips:old").data.album, null, "a trip without an album has none");
  const [active] = await byId.trips.cards(ctx);
  assert.match(active.glance.image, /trip-photo%3Alake%3A/, "a trip that's on shows its album too");
  const all = JSON.stringify([past, active]);
  assert.ok(!all.includes("photos.icloud.com"), "no album link in any card");
});

test("an album that can't be read leaves the trip's card as it was", async () => {
  const family = { trips: [{ id: "ski", name: "Ski", startDate: "2027-01-02", endDate: "2027-01-05", album: ALBUM }] };
  const ctx = ctxWith({ data: { family } });
  ctx.album = async () => { throw new Error("iCloud answered 500"); };
  const [card] = await byId["past-trips"].cards(ctx);
  assert.equal(card.data.album, null);
  assert.equal(card.glance.image, undefined);
});
