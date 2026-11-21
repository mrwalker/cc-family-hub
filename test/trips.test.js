import { test } from "node:test";
import assert from "node:assert/strict";
import { handleHousehold } from "../app/worker/household.js";
import { cleanTrip, cleanBbox, findMap, tripId, tripAlbumLink, HIGHLIGHT_COLORS } from "../app/worker/trip-records.js";
import { byId } from "../app/worker/components/index.js";
import { memoryD1, memoryKV, HUB, NO_SQLITE, ctxWith } from "./helpers.js";

const D1 = { skip: NO_SQLITE };
const BASE = "https://hub.example.com/api/household";
const NOW = { now: Date.parse("2027-06-21T19:00:00Z") };
const ALBUM = "https://www.icloud.com/sharedalbum/#B0aGWZuqDGQyoAb";
const members = { memberIds: new Set(["alex", "sam"]) };

// ─── Checking a trip ──────────────────────────────────────────────────────────

test("a trip is checked and tidied", () => {
  const ok = cleanTrip({
    id: "lake-jul-2027", name: " Lake  week ", startDate: "2027-07-01T00:00:00.000Z", endDate: "2027-07-05",
    who: ["alex", "nobody", "alex"], album: ALBUM, type: "work",
    highlights: [{ emoji: "🛶", label: "Canoe", caption: "Dawn paddle" }, { label: "" }, { label: "Pie", bg: "url(javascript:x)" }],
    restaurants: [{ name: "Diner", price: "$$", type: "American" }, { name: "Odd", price: "cheap" }],
    ideas: ["Bring bug spray", "", 3],
  }, members);
  assert.equal(ok.error, undefined);
  const t = ok.trip;
  assert.equal(t.name, "Lake week");
  assert.equal(t.startDate, "2027-07-01", "a date published from YAML as a timestamp");
  assert.deepEqual(t.who, ["alex"]);
  assert.equal(t.type, "work");
  assert.deepEqual(t.highlights.map(h => [h.label, h.bg]), [["Canoe", HIGHLIGHT_COLORS[0]], ["Pie", HIGHLIGHT_COLORS[1]]], "a color that isn't a plain gradient is replaced");
  assert.deepEqual(t.restaurants.map(r => r.price), ["$$", ""]);
  assert.deepEqual(t.ideas, ["Bring bug spray"]);

  const base = { id: "lake-jul-2027", name: "Lake", startDate: "2027-07-01", endDate: "2027-07-05" };
  assert.match(cleanTrip({ ...base, id: "Lake Trip" }, members).error, /^id:/);
  assert.match(cleanTrip({ ...base, name: "" }, members).error, /^name:/);
  assert.match(cleanTrip({ ...base, endDate: "2027-06-30" }, members).error, /^endDate: on or after/);
  assert.match(cleanTrip({ ...base, album: "https://example.com/album" }, members).error, /^album:/);
  assert.match(cleanTrip({ ...base, mapBbox: "1,2,3" }, members).error, /^mapBbox:/);
  assert.match(cleanTrip({ ...base, ideas: Array(41).fill("x") }, members).error, /^ideas: no more than 40/);
});

test("map areas, and ids from a name and date", () => {
  assert.equal(cleanBbox("-75.8001,35.2,-75.4,36.2"), "-75.8,35.2,-75.4,36.2");
  assert.equal(cleanBbox("10,0,5,1"), null, "west must be west of east");
  assert.equal(tripId("Beach Week!", "2026-12-24"), "beach-week-dec-2026");
  assert.equal(tripId("Ski", null), "ski");
});

test("the map comes from the geocoder, and nothing when it can't be reached", async () => {
  const geocoder = async url => {
    assert.match(String(url), /nominatim\.openstreetmap\.org\/search\?format=json&limit=1&q=Outer%20Banks%2C%20NC/);
    return Response.json([{ boundingbox: ["35.2", "36.2", "-75.8", "-75.4"] }]);
  };
  assert.equal(await findMap("Outer Banks, NC", { fetcher: geocoder }), "-75.8,35.2,-75.4,36.2");
  assert.equal(await findMap("Nowhere", { fetcher: async () => Response.json([]) }), null);
  assert.equal(await findMap("Anywhere", { fetcher: async () => { throw new Error("offline"); } }), null);
});

// ─── The trips API ────────────────────────────────────────────────────────────

function setup(published = null, hub = HUB) {
  const db = memoryD1();
  const env = { HUB_DB: db, DEV_MEMBER: "alex", HUB_DATA: memoryKV(published ? { "data:family": { trips: published } } : {}) };
  const lookups = [];
  const geocoder = async url => {
    const q = decodeURIComponent(String(url).split("q=")[1]);
    lookups.push(q);
    return Response.json(q === "Nowhere" ? [] : [{ boundingbox: ["10", "11", "20", "21"] }]);
  };
  const opts = { ...NOW, fetcher: geocoder };
  const as = member => async (path, body) => {
    env.DEV_MEMBER = member;
    const res = await handleHousehold(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }), env, hub, path, opts);
    return { status: res.status, body: await res.json() };
  };
  const get = async (path, member = "alex") => { env.DEV_MEMBER = member; return (await handleHousehold(new Request(BASE + path), env, hub, path, opts)).json(); };
  return { db, env, as, get, lookups };
}

const trip = extra => ({ id: "lake-jul-2027", name: "Lake week", destination: "Lake Tahoe, CA", startDate: "2027-07-01", endDate: "2027-07-05", who: ["alex", "sam"], ...extra });

test("an adult adds a trip; its map is looked up once per destination", D1, async () => {
  const { as, get, lookups } = setup();
  const { status, body } = await as("alex")("/trips", trip({ isNew: true, album: ALBUM, ideas: ["Sunscreen"] }));
  assert.equal(status, 200);
  assert.equal(body.map, true);
  const [t] = body.trips;
  assert.equal(t.mapBbox, "20,10,21,11");
  assert.deepEqual(t.ideas, ["Sunscreen"]);
  assert.equal(t.album, ALBUM);
  // Saving again keeps the map without asking; a new destination looks again.
  await as("alex")("/trips", trip({ description: "Cabin by the water" }));
  assert.deepEqual(lookups, ["Lake Tahoe, CA"]);
  const moved = (await as("alex")("/trips", trip({ destination: "Nowhere" }))).body;
  assert.deepEqual([moved.map, moved.trips[0].mapBbox], [false, null]);
  // A map given outright is kept as given.
  const given = (await as("alex")("/trips", trip({ mapBbox: "-75.8,35.2,-75.4,36.2", album: ALBUM }))).body.trips[0];
  assert.equal(given.mapBbox, "-75.8,35.2,-75.4,36.2");
  // Only adults see the album link.
  const kid = (await get("/trips", "sam")).trips[0];
  assert.deepEqual([kid.album, kid.hasAlbum], [undefined, true]);
});

test("only adults change trips; a new trip can't take another's id", D1, async () => {
  const { as } = setup();
  assert.equal((await as("sam")("/trips", trip({ isNew: true }))).status, 403);
  assert.equal((await as("pat")("/trips", trip({ isNew: true }))).status, 403);
  assert.equal((await as("alex")("/trips", trip({ startDate: "July 1" }))).status, 400);
  await as("alex")("/trips", trip({ isNew: true }));
  assert.equal((await as("alex")("/trips", trip({ isNew: true, name: "Another" }))).status, 409);
  assert.equal((await as("sam")("/trips/lake-jul-2027/archive", { archived: true })).status, 403);
  const { body } = await as("alex")("/trips/lake-jul-2027/archive", { archived: true });
  assert.equal(body.trips[0].archived, true);
  assert.equal((await as("alex")("/trips/no-such-trip/archive", {})).status, 404);
});

test("the published trips.yaml list is imported once, keeping ids and maps", D1, async () => {
  const published = [
    { id: "beach-jul-2027", name: "Beach", destination: "Cannon Beach, OR", startDate: "2027-07-10", endDate: "2027-07-14",
      who: ["alex", "sam"], status: "upcoming", featured: true, mapBbox: "-124,45.8,-123.9,45.95",
      highlights: [{ emoji: "🌊", label: "Haystack Rock", caption: "Tide pools", bg: "linear-gradient(135deg,#0891b2,#1d4ed8)" }],
      activities: [{ emoji: "🪁", name: "Kites", note: "Windy afternoons" }] },
    { id: "Ski Trip!", name: "Ski", startDate: "2025-12-26", endDate: "2026-01-02", album: ALBUM },
    { id: "conf", name: "Conference", type: "work", startDate: "2027-03-01", endDate: "2027-03-03" },
  ];
  const hub = { ...HUB, tripApps: [{ trip: "beach-jul-2027", path: "/beach/", appId: "beach-2027" }] };
  const { as, get, lookups } = setup(published, hub);
  const before = await get("/trips");
  assert.equal(before.canImportTrips, true);
  assert.deepEqual(before.tripApps, { "beach-jul-2027": "/beach/" });
  assert.equal((await as("sam")("/trips/import", {})).status, 403, "adults only");
  const { body } = await as("alex")("/trips/import", {});
  assert.equal(body.imported, 3);
  assert.deepEqual(body.trips.map(t => [t.id, t.type]).sort(), [["beach-jul-2027", "family"], ["conf", "work"], ["ski-dec-2025", "family"]]);
  const beach = body.trips.find(t => t.id === "beach-jul-2027");
  assert.equal(beach.mapBbox, "-124,45.8,-123.9,45.95");
  assert.equal(beach.highlights[0].bg, "linear-gradient(135deg,#0891b2,#1d4ed8)");
  assert.equal("featured" in beach || "status" in beach, false, "unused fields are left behind");
  assert.deepEqual(lookups, [], "an imported map isn't looked up");
  assert.equal(body.canImportTrips, false);
  assert.equal((await as("alex")("/trips/import", {})).status, 409, "only once");
  // Editing an imported trip without changing its destination keeps its map.
  const kept = (await as("alex")("/trips", { ...beach, mapBbox: undefined, name: "Beach!" })).body.trips.find(t => t.id === "beach-jul-2027");
  assert.equal(kept.mapBbox, "-124,45.8,-123.9,45.95");
});

test("a bad trip in the published list stops the import and says which", D1, async () => {
  const { as } = setup([{ id: "ok-trip", name: "Fine", startDate: "2027-01-01", endDate: "2027-01-02" },
                        { id: "bad-trip", name: "Bad", startDate: "2027-01-05", endDate: "2027-01-01" }]);
  const { status, body } = await as("alex")("/trips/import", {});
  assert.equal(status, 400);
  assert.match(body.error, /^trips\[1\] \(bad-trip\)\.endDate/);
});

test("a trip's photos come from its album in the hub, or the published one before", D1, async () => {
  const OLD = "https://www.icloud.com/sharedalbum/#B0oldAlbumLink1";
  const { as, env } = setup([{ id: "beach-jul-2027", name: "Beach", startDate: "2027-07-10", endDate: "2027-07-14", album: OLD }]);
  assert.equal(await tripAlbumLink(env, "beach-jul-2027"), OLD, "before the hub has trips");
  await as("alex")("/trips", trip({ isNew: true, album: ALBUM }));
  assert.equal(await tripAlbumLink(env, "lake-jul-2027"), ALBUM, "a trip only the hub has");
  assert.equal(await tripAlbumLink(env, "beach-jul-2027"), null, "once the hub has trips, the published list is ignored");
  assert.equal(await tripAlbumLink({ HUB_DATA: env.HUB_DATA }, "beach-jul-2027"), OLD, "no database: the published list");
});

// ─── The components ──────────────────────────────────────────────────────────

test("trip cards use the hub's trips once it has any, and the published list before", async () => {
  const kept = [
    { id: "lake-jul-2027", name: "Lake week", destination: "Lake Tahoe, CA", emoji: "🛶", startDate: "2027-07-01", endDate: "2027-07-05", type: "family", who: ["alex"], highlights: [] },
    { id: "ski-dec-2026", name: "Ski", startDate: "2026-12-26", endDate: "2027-01-02", type: "family", who: [], highlights: [{ emoji: "⛷️", label: "Blues", caption: "" }] },
    { id: "conf", name: "Conference", startDate: "2027-07-02", endDate: "2027-07-03", type: "work", who: [] },
  ];
  const old = { trips: [{ id: "old", name: "Old list", startDate: "2027-08-01", endDate: "2027-08-02" }] };
  const ctx = ctxWith({ tripRecords: kept, data: { family: old } });
  assert.deepEqual((await byId.trips.cards(ctx)).map(c => [c.id, c.glance.headline]), [["trips:lake-jul-2027", "10 days"]]);
  assert.deepEqual((await byId["past-trips"].cards(ctx)).map(c => c.data.highlights[0].label), ["Blues"]);
  const before = await byId.trips.cards(ctxWith({ data: { family: old } }));
  assert.deepEqual(before.map(c => c.id), ["trips:old"]);
});
