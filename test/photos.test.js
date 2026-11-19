import { test } from "node:test";
import assert from "node:assert/strict";
import { albumKey } from "../app/worker/photos.js";

test("both kinds of iCloud shared-album link are recognised", () => {
  assert.equal(albumKey("https://photos.icloud.com/shared/album/B0abcdefghijKLMN"), "B0abcdefghijKLMN");
  assert.equal(albumKey("B0abcdefghijKLMN"), "B0abcdefghijKLMN", "a bare key is the photos.icloud.com kind");
  const token = "D2Wv3aaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccc";
  assert.equal(albumKey(`https://www.icloud.com/sharedalbum/#${token}`), `s:${token}`);
  assert.equal(albumKey(`https://www.icloud.com/sharedalbum/en-us/#${token}`), `s:${token}`, "a localized link");
  assert.equal(albumKey("https://example.com/album/abc"), null);
  assert.equal(albumKey("https://www.icloud.com/sharedalbum/"), null);
});
