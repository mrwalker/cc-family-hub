import { test } from "node:test";
import assert from "node:assert/strict";
import { movieId } from "../app/worker/movies.js";
import { handleHousehold } from "../app/worker/household.js";
import { byId } from "../app/worker/components/index.js";
import { memoryD1, HUB, NO_SQLITE, ctxWith } from "./helpers.js";

const D1 = { skip: NO_SQLITE };
const BASE = "https://hub.example.com/api/household";
const NOW = { now: Date.parse("2027-06-21T19:00:00Z") };   // today: 2027-06-21

/** Movie pages with a poster each, and the posters. */
const site = async url => {
  const u = String(url);
  if (u.startsWith("https://films.example/poster/")) return new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/jpeg" } });
  if (u.startsWith("https://films.example/")) return new Response(`<meta property="og:image" content="/poster/${u.split("/").pop()}.jpg">`, { headers: { "Content-Type": "text/html" } });
  return new Response("no", { status: 404 });
};

function setup() {
  const db = memoryD1();
  const env = { HUB_DB: db, DEV_MEMBER: "alex", PUBLISH_TOKEN: "tok" };
  const opts = { ...NOW, fetcher: site };
  const pipeline = async (path, body, o = opts) => {
    const init = body ? { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer tok" }, body: JSON.stringify(body) } : { headers: { Authorization: "Bearer tok" } };
    const res = await handleHousehold(new Request(BASE + path, init), env, HUB, path, o);
    return { status: res.status, body: await res.json() };
  };
  const as = member => async (path, body) => {
    env.DEV_MEMBER = member;
    const res = await handleHousehold(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }), env, HUB, path, opts);
    return { status: res.status, body: await res.json() };
  };
  const get = async path => handleHousehold(new Request(BASE + path), env, HUB, path, opts);
  return { db, env, pipeline, as, get };
}

const PICKS = {
  batch: "2027-07",
  picks: [
    { title: "Starfall", kind: "movie", releaseDate: "2027-07-16", where: "theaters", format: "IMAX", blurb: "Big space adventure.", forWhom: "Everyone", url: "https://films.example/starfall" },
    { title: "The Long Quiet", kind: "show", releaseDate: "2027-07-02", where: "Netflix", blurb: "A cozy mystery series.", url: "https://films.example/long-quiet" },
    { title: "Starfall", releaseDate: "2027-07-16" },
  ],
};

test("a movie keeps its id from month to month", () => {
  assert.equal(movieId("Starfall: Part Two!", "2027"), "mv-starfall-part-two-2027");
  assert.equal(movieId("", null), "mv-movie");
});

test("the month's picks need the publish token, and come in with posters", D1, async () => {
  const { pipeline, env } = setup();
  const res = await handleHousehold(new Request(BASE + "/movies/picks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(PICKS) }), env, HUB, "/movies/picks", NOW);
  assert.equal(res.status, 401);
  const { status, body } = await pipeline("/movies/picks", PICKS);
  assert.equal(status, 200);
  assert.deepEqual([body.added, body.updated, body.archived, body.pictured], [2, 0, 0, 2], "the repeated pick counts once");
  assert.equal((await pipeline("/movies/picks", { picks: [{ title: "" }] })).status, 400);
  assert.equal((await pipeline("/movies/picks", { picks: [{ title: "X", releaseDate: "July" }] })).status, 400);
});

test("next month: picked again is updated; last month's are retired unless still to come or marked", D1, async () => {
  const { pipeline, as, get } = setup();
  await pipeline("/movies/picks", { batch: "2027-05", picks: [
    { title: "Old Hit", releaseDate: "2027-05-01", url: "https://films.example/old-hit" },
    { title: "Loved It", releaseDate: "2027-05-10" },
    { title: "Still Coming", releaseDate: "2027-08-01" },
    { title: "Again", releaseDate: "2027-06-30" },
  ] });
  await as("sam")("/movies/mv-loved-it-2027/mark", { member: "sam", mark: "seen" });
  const { body } = await pipeline("/movies/picks", { batch: "2027-06", picks: [{ title: "Again", releaseDate: "2027-07-02", format: "70mm" }] });
  assert.deepEqual([body.added, body.updated, body.archived], [0, 1, 1], "the same title and year: the same movie, updated");
  const titles = (await (await get("/movies")).json()).movies.map(m => m.title).sort();
  assert.deepEqual(titles, ["Again", "Loved It", "Still Coming"], "Old Hit retired; the marked and the upcoming stay");
});

test("anyone in the family marks for anyone; guests can't; marks cycle and clear", D1, async () => {
  const { pipeline, as, get } = setup();
  await pipeline("/movies/picks", PICKS);
  let { status, body } = await as("sam")("/movies/mv-starfall-2027/mark", { member: "alex", mark: "want" });
  assert.equal(status, 200);
  assert.deepEqual(body.movies.find(m => m.id === "mv-starfall-2027").marks, { alex: "want" });
  ({ body } = await as("alex")("/movies/mv-starfall-2027/mark", { member: "alex", mark: "seen" }));
  assert.deepEqual(body.movies.find(m => m.id === "mv-starfall-2027").marks, { alex: "seen" });
  ({ body } = await as("alex")("/movies/mv-starfall-2027/mark", { member: "alex", mark: null }));
  assert.deepEqual(body.movies.find(m => m.id === "mv-starfall-2027").marks, {});
  assert.equal((await as("pat")("/movies/mv-starfall-2027/mark", { member: "alex", mark: "want" })).status, 403);
  assert.equal((await as("alex")("/movies/mv-starfall-2027/mark", { member: "nobody", mark: "want" })).status, 400);
  assert.equal((await as("alex")("/movies/mv-starfall-2027/mark", { member: "alex", mark: "loved" })).status, 400);
  const poster = await get("/image/movies/mv-starfall-2027");
  assert.equal(poster.headers.get("Content-Type"), "image/jpeg");
});

test("only adults add movies by hand or archive them", D1, async () => {
  const { as } = setup();
  assert.equal((await as("sam")("/movies", { title: "Mine" })).status, 403);
  const { body } = await as("alex")("/movies", { title: "Family Night", kind: "movie", where: "Disney+", url: "https://films.example/family-night" });
  const m = body.movies.find(x => x.title === "Family Night");
  assert.equal(m.source, "family");
  assert.equal(m.imageUrl, "https://films.example/poster/family-night.jpg");
  assert.equal((await as("sam")(`/movies/${m.id}/archive`, {})).status, 403);
  assert.equal((await as("alex")(`/movies/${m.id}/archive`, {})).body.movies.length, 0);
});

test("the assistant reads past picks with who wanted and saw them", D1, async () => {
  const { pipeline, as } = setup();
  await pipeline("/movies/picks", PICKS);
  await as("sam")("/movies/mv-starfall-2027/mark", { member: "sam", mark: "seen" });
  await as("sam")("/movies/mv-the-long-quiet-2027/mark", { member: "alex", mark: "want" });
  const { body } = await pipeline("/movies/history");
  assert.deepEqual(body.seenCounts, { Alex: 0, Sam: 1 });
  assert.deepEqual(body.movies.find(m => m.title === "Starfall").seen, ["Sam"]);
  assert.deepEqual(body.movies.find(m => m.title === "The Long Quiet").want, ["Alex"]);
});

// ─── The component ───────────────────────────────────────────────────────────

const MOVIES = [
  { id: "mv-starfall-2027", title: "Starfall", kind: "movie", releaseDate: "2027-07-16", where: "theaters", format: "IMAX", imageUrl: "https://x/p.jpg", imageVersion: "p1", marks: { sam: "want" } },
  { id: "mv-quiet-2027", title: "The Long Quiet", kind: "show", releaseDate: "2027-06-25", where: "Netflix", imageUrl: null, marks: { alex: "seen" } },
  { id: "mv-now-2027", title: "Out Already", kind: "movie", releaseDate: "2027-06-01", where: "theaters", marks: {} },
  { id: "mv-tba-2027", title: "Date TBA", kind: "show", releaseDate: null, where: "Hulu", marks: {} },
  { id: "mv-old-2027", title: "Long Gone", kind: "movie", releaseDate: "2027-03-01", where: "theaters", marks: {} },
];

test("movies: coming soon first with posters, then what's out; long-gone ones drop off", async () => {
  const cards = await byId.movies.cards(ctxWith({ movies: MOVIES }));
  assert.deepEqual(cards.map(c => c.glance.headline), ["The Long Quiet", "Starfall", "Out Already", "Date TBA"]);
  assert.deepEqual(cards.map(c => c.glance.detail), ["On Netflix Jun 25", "In theaters Jul 16 · IMAX", "In theaters now", "On Hulu"]);
  assert.equal(cards[1].glance.image, "https://hub.example.com/api/stream/image/movies%3Amv-starfall-2027?v=p1");
  assert.deepEqual(cards[1].glance.colors, ["#db2777"], "who wants to see it");
  assert.equal(cards[0].glance.emoji, "📺");
  assert.deepEqual(cards[1].data.movie.want, ["sam"]);
  // Sam's view: what Sam wants to see.
  const sam = HUB.members.find(m => m.id === "sam");
  assert.deepEqual((await byId.movies.cards(ctxWith({ movies: MOVIES, view: sam }))).map(c => c.glance.headline), ["Starfall"]);
});

test("a pick can bring its poster's own link, for sites that won't show it to the hub", D1, async () => {
  const { pipeline, get } = setup();
  const { body } = await pipeline("/movies/picks", { picks: [{ title: "Blocked Site", releaseDate: "2027-07-01", url: "https://blocked.example/x", imageUrl: "https://films.example/poster/given.jpg" }] });
  assert.equal(body.pictured, 1);
  const movies = (await (await get("/movies")).json()).movies;
  assert.equal(movies[0].imageUrl, "https://films.example/poster/given.jpg");
  assert.equal((await pipeline("/movies/picks", { picks: [{ title: "Bad", imageUrl: "ftp://x" }] })).status, 400);
});
