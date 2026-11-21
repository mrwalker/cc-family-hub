import { test } from "node:test";
import assert from "node:assert/strict";
import { albumKey, albumPhotosFor } from "../app/worker/photos.js";

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
