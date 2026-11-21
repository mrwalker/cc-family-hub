import { test } from "node:test";
import assert from "node:assert/strict";
import { compose, resolveConfig, takeTurns, dwellFor } from "../app/worker/stream.js";
import { COMPONENT_IDS } from "../app/worker/components/index.js";
import { HUB } from "./helpers.js";

const card = (component, id, extra = {}) => ({ id: `${component}:${id}`, title: id, glance: { headline: id, detail: "" }, data: {}, ...extra });

test("the default stream is every component, in the documented order", () => {
  assert.deepEqual(resolveConfig(HUB, null).components,
    ["today", "week", "plan", "pets", "house", "chores", "pet-portraits", "house-portraits", "photos", "trips", "past-trips", "grocery", "escape-rooms", "movies", "workouts"]);
  assert.deepEqual(COMPONENT_IDS, resolveConfig(HUB, null).components);
});

test("an output's settings layer over the family's, after its built-in defaults", () => {
  const hub = { ...HUB, stream: { components: ["today", "trips", "nonsense"], dwell: 20, max: { movies: 1 } },
                outputs: { roku: { stream: { dwell: { today: 30 } } } } };
  const roku = resolveConfig(hub, "roku");
  assert.deepEqual(roku.components, ["today", "trips"], "unknown components are dropped");
  assert.equal(roku.photosBetween, 3, "the Roku defaults to three photos between cards");
  assert.equal(dwellFor(roku.dwell, "today"), 30);
  assert.equal(dwellFor(roku.dwell, "trips"), 10, "the Roku's default dwell beats the family's");
  assert.deepEqual(roku.max, { "pet-portraits": 12, "house-portraits": 12, movies: 1 }, "a component's own default, then the family's");
  assert.equal(dwellFor(resolveConfig(hub, "hub-page").dwell, "trips"), 20);
});

test("long components take turns, a few cards per turn", () => {
  const list = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(takeTurns(list, 3, 0), [1, 2, 3]);
  assert.deepEqual(takeTurns(list, 3, 1), [4, 5, 6]);
  assert.deepEqual(takeTurns(list, 3, 2), [7, 1, 2]);
  assert.deepEqual(takeTurns([1, 2], 3, 5), [1, 2]);
});

test("compose keeps order, skips empty components, and sets each card's dwell", () => {
  const cfg = { components: ["today", "plan", "trips", "movies"], dwell: { default: 15, today: 60 }, photosBetween: 0, max: { movies: 1 } };
  const cards = compose({ cfg, turn: 1, cardsBy: {
    today: [card("today", "t")], plan: [], trips: [card("trips", "a"), card("trips", "b")],
    movies: [card("movies", "m1"), card("movies", "m2"), card("movies", "m3")],
  } });
  assert.deepEqual(cards.map(c => c.id), ["today:t", "trips:a", "trips:b", "movies:m2"]);
  assert.deepEqual(cards.map(c => c.dwell), [60, 15, 15, 15]);
  assert.equal(cards[1].component, "trips");
});

test("an active trip leads the stream, even when its component would leave it out", () => {
  const cfg = { components: ["today", "trips"], dwell: 15, photosBetween: 0, max: { trips: 1 } };
  const cards = compose({ cfg, turn: 0, cardsBy: {
    today: [card("today", "t")],
    trips: [card("trips", "next"), card("trips", "now", { leads: true })],
  } });
  assert.deepEqual(cards.map(c => c.id), ["trips:now", "today:t", "trips:next"]);
  assert.equal("leads" in cards[0], false, "the hint isn't sent to screens");
});

test("photos between cards replace the photos component's own place", () => {
  const cfg = { components: ["today", "photos", "trips"], dwell: { default: 10 }, photosBetween: 2, max: {} };
  const pool = [card("photos", "p1"), card("photos", "p2"), card("photos", "p3")];
  const cards = compose({ cfg, turn: 0, photoPool: pool, cardsBy: { today: [card("today", "t")], photos: pool, trips: [card("trips", "a")] } });
  assert.deepEqual(cards.map(c => c.id), ["today:t", "photos:p1", "photos:p2", "trips:a", "photos:p3", "photos:p1"]);
});

test("photos between cards with an empty album is just the cards", () => {
  const cfg = { components: ["today"], dwell: 10, photosBetween: 3, max: {} };
  assert.deepEqual(compose({ cfg, cardsBy: { today: [card("today", "t")] } }).map(c => c.id), ["today:t"]);
});

test("components= narrows the stream and all=1 returns every card", async () => {
  const { handleStream } = await import("../app/worker/stream.js");
  const { memoryKV } = await import("./helpers.js");
  const trips = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, name: `Trip ${i}`, startDate: `2099-0${i + 1}-01`, endDate: `2099-0${i + 1}-03` }));
  const env = { HUB_DATA: memoryKV({ "data:family": { trips } }) };
  const get = async q => (await handleStream(new Request(`https://hub.example.com/api/stream?${q}`), env, HUB, async () => [], "")).json();
  let d = await get("components=trips");
  assert.deepEqual(d.cards.map(c => c.component), ["trips", "trips", "trips"]);
  d = await get("components=trips,today&all=1");
  assert.deepEqual(d.cards.map(c => c.id), ["trips:t0", "trips:t1", "trips:t2", "trips:t3", "trips:t4", "today"]);
  d = await get("components=gossip");
  assert.match(d.error, /Unknown component "gossip"/);
});

test("the hub page's path gives image links under the same path", async () => {
  const { handleStream } = await import("../app/worker/stream.js");
  const { memoryKV } = await import("./helpers.js");
  const env = { HUB_DATA: memoryKV({ "data:family": { trips: [] } }) };
  const hub = { ...HUB, tripApps: [{ trip: "lake", path: "/lake/", appId: "lake-2027", summary: { hero: "/lake/img/hero.jpg" } }] };
  const ctxImage = base => import("../app/worker/stream.js").then(m =>
    m.makeContext({ request: new Request("https://hub.example.com/x"), env, hub, loadEvents: async () => [], base }).image("trips:lake"));
  assert.equal(await ctxImage(undefined), "https://hub.example.com/api/stream/image/trips%3Alake");
  assert.equal(await ctxImage("/api/page/stream"), "https://hub.example.com/api/page/stream/image/trips%3Alake");
  const res = await handleStream(new Request("https://hub.example.com/api/page/stream?components=today"), env, HUB, async () => [], "", "/api/page/stream");
  assert.equal(res.status, 200);
});
