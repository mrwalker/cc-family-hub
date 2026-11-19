import { test } from "node:test";
import assert from "node:assert/strict";
import { handleGrocery, mergePlanShopping, cleanItem, listGrocery } from "../app/worker/grocery.js";
import { memoryKV, HUB } from "./helpers.js";

const post = body => new Request("https://hub.example.com/api/grocery", { method: "POST", body: JSON.stringify(body) });

test("items are validated, and the newer edit wins", async () => {
  const env = { HUB_DATA: memoryKV() };
  await handleGrocery(post({ upserts: [{ id: "item-0001", name: "  Milk ", quantity: 2, addedBy: "sam", updatedAt: 10 }] }), env, HUB);
  await handleGrocery(post({ upserts: [{ id: "item-0001", name: "Oat milk", updatedAt: 5 }] }), env, HUB);
  let { items } = await (await handleGrocery(new Request("https://hub.example.com/api/grocery"), env, HUB)).json();
  assert.deepEqual(items.map(i => [i.name, i.quantity, i.addedBy]), [["Milk", 2, "sam"]], "the older edit is ignored");
  ({ items } = await (await handleGrocery(post({ upserts: [{ id: "item-0001", name: "Milk", done: true, updatedAt: 20 }], deletes: [] }), env, HUB)).json());
  assert.equal(items[0].done, true);
  ({ items } = await (await handleGrocery(post({ deletes: ["item-0001"] }), env, HUB)).json());
  assert.deepEqual(items, []);
});

test("bad items are dropped", () => {
  const members = new Set(["sam"]);
  assert.equal(cleanItem({ id: "x", name: "Milk", updatedAt: 1 }, members), null, "short id");
  assert.equal(cleanItem({ id: "item-0001", name: "  ", updatedAt: 1 }, members), null, "no name");
  assert.equal(cleanItem({ id: "item-0001", name: "Milk" }, members), null, "no timestamp");
  assert.equal(cleanItem({ id: "item-0001", name: "Milk", updatedAt: 1, addedBy: "nobody" }, members).addedBy, undefined);
  assert.equal(cleanItem({ id: "item-0001", name: "Milk", updatedAt: 1, quantity: 500 }, members).quantity, 99);
});

test("the plan's shopping list joins the grocery list once", async () => {
  const env = { HUB_DATA: memoryKV() };
  await handleGrocery(post({ upserts: [{ id: "item-0001", name: "Milk", updatedAt: 1 }] }), env, HUB);
  const added = await mergePlanShopping(env, [{ name: "milk" }, { name: "Candles", quantity: "1 box" }, { name: "Limes", quantity: "6" }], 1000);
  assert.equal(added, 2, "milk is already on the list");
  const names = (await listGrocery(env)).map(i => `${i.name} x${i.quantity}`).sort();
  assert.deepEqual(names, ["Candles (1 box) x1", "Limes x6", "Milk x1"]);

  // Deleting a planner suggestion keeps it deleted on the next publish.
  const candles = (await listGrocery(env)).find(i => i.name.startsWith("Candles"));
  await handleGrocery(post({ deletes: [candles.id] }), env, HUB);
  assert.equal(await mergePlanShopping(env, [{ name: "Candles", quantity: "1 box" }], 2000), 0);
});

test("a list kept one key per item (v0.11 and earlier) moves into the single value once", async () => {
  const env = { HUB_DATA: memoryKV() };
  await env.HUB_DATA.put("grocery:item:item-0001", "1", { metadata: { id: "item-0001", name: "Milk", quantity: 1, done: false, addedAt: 1, updatedAt: 1 } });
  assert.deepEqual((await listGrocery(env)).map(i => i.name), ["Milk"]);
  assert.equal([...env.HUB_DATA.store.keys()].filter(k => k.startsWith("grocery:item:")).length, 0, "old keys are gone");
  let lists = 0;
  const list = env.HUB_DATA.list.bind(env.HUB_DATA);
  env.HUB_DATA.list = (...a) => { lists++; return list(...a); };
  await listGrocery(env);
  await handleGrocery(post({ upserts: [{ id: "item-0002", name: "Eggs", updatedAt: 5 }] }), env, HUB);
  assert.equal(lists, 0, "reading and writing the list needs no KV list()");
  assert.deepEqual((await listGrocery(env)).map(i => i.name).sort(), ["Eggs", "Milk"]);
});
