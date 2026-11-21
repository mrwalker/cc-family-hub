import { test } from "node:test";
import assert from "node:assert/strict";
import { pickImage, findImage, imageResponse, nameWords } from "../app/worker/link-image.js";
import { handleHousehold } from "../app/worker/household.js";
import { byId } from "../app/worker/components/index.js";
import { memoryD1, memoryKV, HUB, NO_SQLITE, ctxWith } from "./helpers.js";

const D1 = { skip: NO_SQLITE };
const BASE = "https://hub.example.com/api/household";
const NOW = { now: Date.parse("2027-06-21T19:00:00Z") };

// ─── Pictures from pages ──────────────────────────────────────────────────────

test("a room's own picture beats the page's preview, which beats a big one", () => {
  const page = `<html><head>
    <meta property="og:image" content="/img/whole-venue.jpg">
    </head><body>
    <img src="/img/logo.png" alt="Puzzle Co" width="900">
    <img src="/img/big-lobby.jpg" width="1600">
    <img
      src="/rooms/thumb.jpg" alt="The Pirate's Lagoon Quest room">
    </body></html>`;
  assert.equal(pickImage(page, "https://puzzle.example/rooms/x", "Pirate's Lagoon Quest"), "https://puzzle.example/rooms/thumb.jpg");
  assert.equal(pickImage(page, "https://puzzle.example/rooms/x", "Sunken Temple"), "https://puzzle.example/img/whole-venue.jpg");
  assert.equal(pickImage(`<img src="/a.jpg" width="1200"><img src="/b.jpg" width="100">`, "https://x.example/", ""), "https://x.example/a.jpg");
});

test("preview tags in any order and form, structured data, and what's skipped", () => {
  assert.equal(pickImage(`<meta content="https://cdn.example/p.jpg?a=1&amp;b=2" name="twitter:image">`, "https://x.example/"), "https://cdn.example/p.jpg?a=1&b=2");
  assert.equal(pickImage(`<link rel="image_src" href="//cdn.example/q.png">`, "https://x.example/"), "https://cdn.example/q.png");
  assert.equal(pickImage(`<script type="application/ld+json">{"image":{"url":"https:\\/\\/cdn.example\\/ld.jpg"}}</script>`, "https://x.example/"), "https://cdn.example/ld.jpg");
  const skipped = `<meta property="og:image" content="/logo.svg"><img src="/hero.jpg?w=16&h=11&blur=10" width="1600">
    <img src="/x/_next/image?url=%2Fchar.svg&w=256" alt="Sunken Temple"><img src="data:image/png;base64,AAA" width="2000">`;
  assert.equal(pickImage(skipped, "https://x.example/", "Sunken Temple"), null);
  assert.deepEqual(nameWords("The Pirate's Lagoon Quest Escape Room"), ["pirate", "lagoon", "quest"]);
});

test("a page that can't be read, or isn't a page, gives no picture", async () => {
  const fail = async () => { throw new Error("blocked"); };
  assert.equal(await findImage("https://x.example/", { fetcher: fail }), null);
  const json = async () => new Response("{}", { headers: { "Content-Type": "application/json" } });
  assert.equal(await findImage("https://x.example/", { fetcher: json }), null);
  assert.equal(await findImage("not a link"), null);
});

test("a picture is served only when it really is one", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const ok = await imageResponse("https://cdn.example/p.png", { fetcher: async () => new Response(png, { headers: { "Content-Type": "image/png" } }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Content-Type"), "image/png");
  const html = await imageResponse("https://cdn.example/p.png", { fetcher: async () => new Response("<html>", { headers: { "Content-Type": "text/html" } }) });
  assert.equal(html.status, 404);
  const svg = await imageResponse("https://cdn.example/p.svg", { fetcher: async () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }) });
  assert.equal(svg.status, 404, "an SVG could carry script");
});

// ─── The rooms API ────────────────────────────────────────────────────────────

/** A stand-in for the venues' sites. */
const site = async url => {
  if (String(url).startsWith("https://venue.example/pics/")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } });
  if (String(url).startsWith("https://venue.example/")) {
    return new Response(`<meta property="og:image" content="/pics/${String(url).split("/").pop()}.jpg">`, { headers: { "Content-Type": "text/html" } });
  }
  return new Response("nope", { status: 404 });
};

function setup(published = null) {
  const db = memoryD1();
  const env = { HUB_DB: db, DEV_MEMBER: "alex", HUB_DATA: memoryKV(published ? { "data:family": { escapeRooms: published } } : {}) };
  const opts = { ...NOW, fetcher: site };
  const as = member => async (path, body) => {
    env.DEV_MEMBER = member;
    const res = await handleHousehold(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }), env, HUB, path, opts);
    return { status: res.status, body: await res.json() };
  };
  const get = async path => handleHousehold(new Request(BASE + path), env, HUB, path, opts);
  return { db, env, as, get };
}

const room = extra => ({ id: "room-temple1", room: "Sunken Temple", venue: "Puzzle Co", city: "Portland, OR", date: "2027-05-01", who: ["alex", "sam", "nobody"], solved: true, escapeTime: "52 min", ...extra });

test("anyone in the family adds a room; its picture comes from its link", D1, async () => {
  const { as, get } = setup();
  const { status, body } = await as("sam")("/rooms", room({ url: "https://venue.example/sunken-temple" }));
  assert.equal(status, 200);
  const [r] = body.rooms;
  assert.deepEqual(r.who, ["alex", "sam"], "only family members");
  assert.equal(r.imageUrl, "https://venue.example/pics/sunken-temple.jpg");
  const pic = await get(`/image/rooms/${r.id}`);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get("Content-Type"), "image/jpeg");
  // Editing without changing the link keeps the picture; a new link finds a new one.
  let after = (await as("alex")("/rooms", room({ url: "https://venue.example/sunken-temple", notes: "So close" }))).body.rooms[0];
  assert.equal(after.imageUrl, "https://venue.example/pics/sunken-temple.jpg");
  after = (await as("alex")("/rooms", room({ url: "https://venue.example/sunken-temple-2" }))).body.rooms[0];
  assert.equal(after.imageUrl, "https://venue.example/pics/sunken-temple-2.jpg");
  // A picture can be given by hand.
  after = (await as("sam")("/rooms/room-temple1/image", { imageUrl: "https://cdn.example/mine.jpg" })).body.rooms[0];
  assert.equal(after.imageUrl, "https://cdn.example/mine.jpg");
});

test("a room can name the trip it was played on", D1, async () => {
  const { as } = setup();
  let r = (await as("sam")("/rooms", room({ trip: "beach-jul-2027" }))).body.rooms[0];
  assert.equal(r.trip, "beach-jul-2027");
  r = (await as("sam")("/rooms", room({ trip: null }))).body.rooms[0];
  assert.equal(r.trip, null, "and be taken off it");
  assert.equal((await as("sam")("/rooms", room({ trip: "Beach Trip!" }))).status, 400);
  const ctx = ctxWith({ rooms: [{ id: "room-a00001", room: "Sunken Temple", solved: true, who: [], trip: "beach-jul-2027" }] });
  assert.equal((await byId["escape-rooms"].cards(ctx))[0].data.room.trip, "beach-jul-2027");
});

test("rooms are checked; guests can't add them; only adults archive", D1, async () => {
  const { as } = setup();
  assert.equal((await as("alex")("/rooms", room({ room: "" }))).status, 400);
  assert.equal((await as("alex")("/rooms", room({ url: "javascript:alert(1)" }))).status, 400);
  assert.equal((await as("alex")("/rooms", room({ date: "May 1" }))).status, 400);
  assert.equal((await as("pat")("/rooms", room())).status, 403);
  await as("alex")("/rooms", room());
  assert.equal((await as("sam")("/rooms/room-temple1/archive", { archived: true })).status, 403);
  const { body } = await as("alex")("/rooms/room-temple1/archive", { archived: true });
  assert.equal(body.rooms[0].archived, true);
});

test("the old published list is imported once, with pictures", D1, async () => {
  const published = [
    { id: "er-one-room", room: "Sunken Temple", venue: "Puzzle Co", date: "2026-01-02", url: "https://venue.example/sunken-temple", who: ["alex"], solved: true },
    { id: "er-two-room", room: "Clockwork Heist", date: "2025-03-04", approxDate: true, solved: false, failNote: "Ran out of time" },
  ];
  const { as, get } = setup(published);
  const before = await (await get("/rooms")).json();
  assert.equal(before.canImportRooms, true);
  assert.equal((await as("sam")("/rooms/import", {})).status, 403, "adults only");
  const { body } = await as("alex")("/rooms/import", {});
  assert.deepEqual(body.rooms.map(r => [r.id, r.imageUrl, r.approxDate]), [
    ["er-one-room", "https://venue.example/pics/sunken-temple.jpg", false], ["er-two-room", null, true]]);
  assert.equal(body.canImportRooms, false);
  assert.equal((await as("alex")("/rooms/import", {})).status, 409, "only once");
});

test("missing pictures are looked for again, not more than once a day", D1, async () => {
  let up = false;
  const flaky = async url => (up ? site(url) : new Response("down", { status: 503 }));
  const { as, env } = setup();
  const opts = { ...NOW, fetcher: flaky };
  const post = async (path, body, o = opts) => (await handleHousehold(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, HUB, path, o)).json();
  await post("/rooms", room({ url: "https://venue.example/sunken-temple" }));
  up = true;
  let body = await post("/rooms/images", {});
  assert.deepEqual([body.looked, body.rooms[0].imageUrl], [0, null], "looked at less than a day ago");
  body = await post("/rooms/images", {}, { ...opts, now: NOW.now + 25 * 3_600_000 });
  assert.deepEqual([body.found, body.rooms[0].imageUrl], [1, "https://venue.example/pics/sunken-temple.jpg"]);
});

// ─── The component ───────────────────────────────────────────────────────────

test("the escape-rooms card uses the hub's rooms and shows a room's picture", async () => {
  const rooms = [
    { id: "room-a00001", room: "Sunken Temple", venue: "Puzzle Co", date: "2027-05-01", solved: true, who: ["alex"], imageUrl: "https://cdn.example/a.jpg", imageVersion: "v1" },
    { id: "room-b00001", room: "Clockwork Heist", date: "2026-05-01", solved: false, who: ["sam"], imageUrl: null },
  ];
  const ctx = ctxWith({ rooms, data: { family: { escapeRooms: [{ room: "Old list" }] } } });
  ctx.turn = 0;
  const [card] = await byId["escape-rooms"].cards(ctx);
  assert.equal(card.title, "Escape rooms · 1 of 2");
  assert.equal(card.glance.headline, "Sunken Temple");
  assert.equal(card.glance.detail, "Escaped · Puzzle Co · May 2027");
  assert.equal(card.glance.emoji, undefined, "no emoji over a picture");
  assert.equal(card.glance.image, "https://hub.example.com/api/stream/image/escape-rooms%3Aroom-a00001?v=v1");
  assert.equal(card.data.room.image, card.glance.image);
  // Before the import: the published list.
  const [old] = await byId["escape-rooms"].cards(ctxWith({ data: { family: { escapeRooms: [{ room: "Old list", solved: true }] } } }));
  assert.equal(old.title, "Escape rooms · 1 of 1");
  assert.equal(old.glance.headline, "Old list");
  assert.equal(old.glance.emoji, "🔐");
  assert.equal(old.glance.image, undefined);
});

test("a new picture gets a new link, so no browser keeps showing the old one", D1, async () => {
  const { as } = setup();
  const first = (await as("alex")("/rooms", room({ url: "https://venue.example/sunken-temple" }))).body.rooms[0];
  const second = (await as("alex")("/rooms/room-temple1/image", { imageUrl: "https://cdn.example/new.jpg" })).body.rooms[0];
  assert.ok(first.imageVersion && second.imageVersion);
  assert.notEqual(first.imageVersion, second.imageVersion);
});

test("pictures are asked for as JPEG first, not AVIF", async () => {
  let accept = "";
  await imageResponse("https://cdn.example/p.jpg?auto=format", { fetcher: async (url, init) => { accept = init.headers.Accept; return new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/jpeg" } }); } });
  assert.match(accept, /^image\/jpeg/);
  assert.doesNotMatch(accept, /avif/);
});

test("an AVIF from an auto-format CDN is asked for again as JPEG", async () => {
  const asked = [];
  const cdn = async url => {
    asked.push(url);
    return url.includes("fm=jpg")
      ? new Response(new Uint8Array([0xff, 0xd8]), { headers: { "Content-Type": "image/jpeg" } })
      : new Response(new Uint8Array([0]), { headers: { "Content-Type": "image/avif" } });
  };
  const res = await imageResponse("https://cdn.example/a.jpg?w=1920&auto=format", { fetcher: cdn });
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.deepEqual(asked, ["https://cdn.example/a.jpg?w=1920&auto=format", "https://cdn.example/a.jpg?w=1920&fm=jpg"]);
});
