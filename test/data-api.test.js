import { test } from "node:test";
import assert from "node:assert/strict";
import { handleDataApi } from "../app/worker/data-api.js";
import { memoryKV } from "./helpers.js";

const ALBUM = "https://photos.icloud.com/shared/album/B0aaaaaaaaaaaa";
const put = (env, kind, body) => handleDataApi(new Request(`https://hub.example.com/api/data/${kind}`, {
  method: "PUT", headers: { Authorization: "Bearer t" }, body: JSON.stringify(body),
}), env);

test("trip album links are validated on publish and kept from pages", async () => {
  const env = { HUB_DATA: memoryKV(), PUBLISH_TOKEN: "t" };
  const bad = await put(env, "family", { trips: [{ id: "a", name: "A", startDate: "2027-01-01", endDate: "2027-01-02", album: "https://example.com/x" }] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).errors[0], /^family\.trips\[0\]\.album: expected an iCloud shared album link/);

  const ok = await put(env, "family", { trips: [{ id: "a", name: "A", startDate: "2027-01-01", endDate: "2027-01-02", album: ALBUM }] });
  assert.equal(ok.status, 200);
  const script = await (await handleDataApi(new Request("https://hub.example.com/api/data.js"), env)).text();
  assert.ok(!script.includes("icloud"), "the page script has no album link");
  assert.match(script, /"hasAlbum":true/);
  const api = await (await handleDataApi(new Request("https://hub.example.com/api/data/family"), env)).json();
  assert.equal(api.data.trips[0].album, undefined);
  assert.ok((await env.HUB_DATA.get("data:family", "json")).trips[0].album, "the Worker keeps it");
});
