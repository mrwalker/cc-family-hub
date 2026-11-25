import { test } from "node:test";
import assert from "node:assert/strict";
import { albumKey, albumPhotosFor, albumSoon, warmAlbums } from "../app/worker/photos.js";
import { memoryKV, HUB } from "./helpers.js";

test("both kinds of iCloud shared-album link are recognised", () => {
  assert.equal(albumKey("https://photos.icloud.com/shared/album/B0abcdefghijKLMN"), "B0abcdefghijKLMN");
  assert.equal(albumKey("B0abcdefghijKLMN"), "B0abcdefghijKLMN", "a bare key is the photos.icloud.com kind");
  const token = "D2Wv3aaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccc";
  assert.equal(albumKey(`https://www.icloud.com/sharedalbum/#${token}`), `s:${token}`);
  assert.equal(albumKey(`https://www.icloud.com/sharedalbum/en-us/#${token}`), `s:${token}`, "a localized link");
  assert.equal(albumKey("https://example.com/album/abc"), null);
  assert.equal(albumKey("https://www.icloud.com/sharedalbum/"), null);
});

/** A photos.icloud.com album whose one photo is the given CPLMaster fields. */
async function cloudKitAlbumOf(masterFields) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const body = String(url).includes("/records/resolve")
      ? { results: [{ zoneID: { zoneName: "z" }, anonymousPublicAccess: { token: "t" } }] }
      : { records: [
          { recordType: "CPLMaster", recordName: "M1", fields: { itemType: { value: "public.jpeg" }, ...masterFields } },
          { recordType: "CPLAsset", recordName: "A1", fields: { masterRef: { value: { recordName: "M1" } } } },
        ] };
    return new Response(JSON.stringify(body));
  };
  try { return await albumPhotosFor("https://photos.icloud.com/shared/album/B0abcdefghijKLMN"); }
  finally { globalThis.fetch = realFetch; }
}
const res = (name, w, h, type = "public.jpeg") => ({
  [`${name}Res`]: { value: { downloadURL: `https://cvws.icloud-content.com/${name}/\${f}` } },
  [`${name}Width`]: { value: w }, [`${name}Height`]: { value: h }, [`${name}FileType`]: { value: type },
  [`${name}Fingerprint`]: { value: `fp-${name}` },
});

test("a photo with a medium JPEG uses it", async () => {
  const [p] = await cloudKitAlbumOf({ ...res("resJPEGMed", 1024, 768), ...res("resOriginal", 4032, 3024, "public.heic") });
  assert.match(p.downloadURL, /resJPEGMed/);
});

test("a small photo with no medium or full JPEG uses its original", async () => {
  // iCloud makes no medium or full JPEG for a photo this small.
  const photos = await cloudKitAlbumOf({ ...res("resOriginal", 1600, 1200), ...res("resJPEGThumb", 480, 360) });
  assert.equal(photos.length, 1);
  assert.match(photos[0].downloadURL, /resOriginal/);
  assert.equal(photos[0].width, 1600);
});

test("an original screens can't show falls back to the thumbnail", async () => {
  const [p] = await cloudKitAlbumOf({ ...res("resOriginal", 1600, 1200, "public.heic"), ...res("resJPEGThumb", 480, 360) });
  assert.match(p.downloadURL, /resJPEGThumb/);
});

// ─── Kept albums (v2.11.1): a slow album never holds up a screen ──────────────

/** A fake iCloud whose CloudKit albums each answer after `delays[key]` ms. Counts the reads. */
function fakeICloud(delays = {}) {
  const reads = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const key = new URL(String(url)).searchParams.get("sharing_url_key");
    if (String(url).includes("/records/resolve")) {
      reads[key] = (reads[key] ?? 0) + 1;
      await new Promise(r => setTimeout(r, delays[key] ?? 0));
      return new Response(JSON.stringify({ results: [{ zoneID: { zoneName: "z" }, anonymousPublicAccess: { token: "t" } }] }));
    }
    return new Response(JSON.stringify({ records: [
      { recordType: "CPLMaster", recordName: "M1", fields: { itemType: { value: "public.jpeg" }, ...res("resJPEGMed", 1024, 768) } },
      { recordType: "CPLAsset", recordName: `A-${key}`, fields: { masterRef: { value: { recordName: "M1" } } } },
    ] }));
  };
  return { reads, restore: () => { globalThis.fetch = realFetch; } };
}
const link = key => `https://photos.icloud.com/shared/album/${key}`;

test("a slow album that isn't kept doesn't hold up a screen, and is kept once it loads", async () => {
  const icloud = fakeICloud({ SlowAlbum0001: 300 });
  const env = { HUB_DATA: memoryKV() };
  try {
    const started = Date.now();
    assert.equal(await albumSoon(env, link("SlowAlbum0001"), { waitMs: 50 }), null, "not kept yet: nothing for now");
    assert.ok(Date.now() - started < 250, "the screen didn't wait for iCloud");
    await new Promise(r => setTimeout(r, 400));   // the read finishes on its own
    const photos = await albumSoon(env, link("SlowAlbum0001"), { waitMs: 50 });
    assert.equal(photos.length, 1, "kept: there right away");
    assert.equal(icloud.reads.SlowAlbum0001, 1, "read from iCloud once");
    assert.ok(env.HUB_DATA.store.has("album:SlowAlbum0001"));
  } finally { icloud.restore(); }
});

test("a quick album that isn't kept comes on the same request", async () => {
  const icloud = fakeICloud();
  try {
    assert.equal((await albumSoon({ HUB_DATA: memoryKV() }, link("QuickAlbum001"), { waitMs: 500 })).length, 1);
  } finally { icloud.restore(); }
});

test("warmAlbums loads albums that aren't kept first, then stale ones, and leaves fresh ones", async () => {
  const icloud = fakeICloud();
  const now = Date.now();
  const kept = at => JSON.stringify({ fetchedAt: at, photos: [] });
  const env = { HUB_DATA: memoryKV({ "album:FreshAlbum001": kept(now - 3_600_000), "album:StaleAlbum001": kept(now - 13 * 3_600_000) }) };
  try {
    const one = await warmAlbums(env, [link("FreshAlbum001"), link("StaleAlbum001"), link("NewAlbum00001"), null], { max: 1, now });
    assert.deepEqual([one.albums, one.due, one.done.length], [3, 2, 1]);
    assert.deepEqual(Object.keys(icloud.reads), ["NewAlbum00001"], "the album that isn't kept goes first");
    await warmAlbums(env, [link("FreshAlbum001"), link("StaleAlbum001"), link("NewAlbum00001")], { now });
    assert.deepEqual(Object.keys(icloud.reads).sort(), ["NewAlbum00001", "StaleAlbum001"], "a fresh album isn't read again");
  } finally { icloud.restore(); }
});

test("albumPhotosFor still waits for an album that isn't kept", async () => {
  const icloud = fakeICloud({ WaitAlbum0001: 100 });
  try { assert.equal((await albumPhotosFor(link("WaitAlbum0001"))).length, 1); } finally { icloud.restore(); }
});

// ─── The trip apps' Photos tab (v2.16) ───────────────────────────────────────

test("an older kept list is read again when asked for a newer one, and stands in if iCloud is slow", async () => {
  const icloud = fakeICloud({ SlowTrip00001: 300 });
  const kept = { fetchedAt: Date.now() - 3_600_000, photos: [{ id: "old" }] };
  const env = { HUB_DATA: memoryKV({ "album:QuickTrip0001": JSON.stringify(kept), "album:SlowTrip00001": JSON.stringify(kept) }) };
  const ids = async (key, opts) => (await albumSoon(env, link(key), opts)).map(p => p.id);
  try {
    assert.deepEqual(await ids("QuickTrip0001"), ["old"], "any age will do by default");
    assert.deepEqual(await ids("QuickTrip0001", { maxAgeMs: 600_000 }), ["A-QuickTrip0001"]);
    assert.deepEqual(await ids("SlowTrip00001", { maxAgeMs: 600_000, waitMs: 20 }), ["old"]);
    await new Promise(r => setTimeout(r, 400));
    globalThis.fetch = async () => new Response("", { status: 500 });
    assert.deepEqual(await ids("SlowTrip00001", { maxAgeMs: -1 }), ["A-SlowTrip00001"], "iCloud failing leaves the kept list");
  } finally { icloud.restore(); }
});

test("a trip app's photos: none without an album link, else the list without the link", async () => {
  const { createHub } = await import("../app/worker/index.js");
  const app = { trip: "beach", appId: "beach-app", path: "/beach/", players: [] };
  const hub = createHub({ ...HUB, guests: [], tripApps: [app] });
  const trips = album => JSON.stringify({ trips: [{ id: "beach", ...(album ? { album } : {}) }] });
  const get = async (env, path) => hub.fetch(new Request(`https://hub.example.com/api/trip/${path}`), env);
  const none = { HUB_DATA: memoryKV({ "data:family": trips() }) };
  assert.deepEqual(await (await get(none, "beach-app/photos")).json(), { album: false });
  assert.equal((await get(none, "beach-app/photos/x")).status, 404);
  assert.equal((await get(none, "other/photos")).status, 404);

  const kept = { fetchedAt: Date.now(), photos: [{ id: "p1", takenAt: "2027-06-21T10:00:00Z", fingerprint: "f", downloadURL: "https://cvws.example/full",
    thumb: { fingerprint: "t", downloadURL: "https://cvws.example/thumb" } }] };
  const env = { HUB_DATA: memoryKV({ "data:family": trips(link("BeachAlbum001")), "album:BeachAlbum001": JSON.stringify(kept) }) };
  assert.deepEqual(await (await get(env, "beach-app/photos")).json(), { album: true, photos: [{ id: "p1", takenAt: "2027-06-21T10:00:00Z" }] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(String(url));
  try {
    assert.equal(await (await get(env, "beach-app/photos/p1?size=thumb")).text(), "https://cvws.example/thumb");
    assert.equal(await (await get(env, "beach-app/photos/p1")).text(), "https://cvws.example/full");
  } finally { globalThis.fetch = realFetch; }
});
