/**
 * The family's shared grocery list, stored in HUB_DATA. Every screen sees the
 * same list: the hub page edits it, the stream's `grocery` component shows it,
 * and the planner's shopping items are merged in when a plan is published.
 *
 *   GET  /api/grocery → { items: [item…], serverTime }
 *   POST /api/grocery   { upserts: [item…], deletes: [id…] } → { items, serverTime }
 *
 *   item: { id, name, quantity, store?, addedBy?, done, fromPlan?, updatedAt }
 *
 * The whole list is one KV value, so reading it is a single get(): every screen
 * reads it on every stream request, and KV's free tier allows 100,000 reads a
 * day but only 1,000 list() calls. An upsert only wins if its updatedAt is
 * newer than what's stored. (v0.11 and earlier kept one key per item; the
 * first read moves those into the single value.)
 */

import { json } from "./util.js";

const KEY = "grocery:list";
const OLD_PREFIX = "grocery:item:";             // v0.11 and earlier: one key per item
const PLAN_PREFIX = "grocery:plan:";            // names the planner already added
const PLAN_MEMORY_SECONDS = 30 * 86_400;        // so a deleted item doesn't come back
export const MAX_ITEMS = 300;
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

export async function handleGrocery(request, env, hub) {
  if (!env.HUB_DATA) return json({ error: "HUB_DATA KV binding not configured" }, 503);
  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Body is not valid JSON" }, 400); }
    const members = new Set(hub.members.map(m => m.id));
    const current = new Map((await listGrocery(env)).map(i => [i.id, i]));
    let changed = false;
    for (const raw of (Array.isArray(body.upserts) ? body.upserts : []).slice(0, 100)) {
      const item = cleanItem(raw, members);
      if (!item) continue;
      const old = current.get(item.id);
      if (old && old.updatedAt >= item.updatedAt) continue;
      if (!old && current.size >= MAX_ITEMS) break;
      if (old?.fromPlan) item.fromPlan = true;
      current.set(item.id, item);
      changed = true;
    }
    for (const id of (Array.isArray(body.deletes) ? body.deletes : []).slice(0, 100)) {
      if (typeof id === "string" && ID_RE.test(id) && current.delete(id)) changed = true;
    }
    if (changed) await saveGrocery(env, [...current.values()]);
    return json({ items: sortItems([...current.values()]), serverTime: Date.now() });
  }
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  return json({ items: sortItems(await listGrocery(env)), serverTime: Date.now() });
}

/** Every item on the list (unsorted). */
export async function listGrocery(env) {
  if (!env.HUB_DATA) return [];
  const stored = await env.HUB_DATA.get(KEY, "json");
  if (Array.isArray(stored?.items)) return stored.items;
  return migrateOldItems(env);
}

export async function saveGrocery(env, items) {
  await env.HUB_DATA.put(KEY, JSON.stringify({ items }));
}

/** Moves v0.11-and-earlier per-item keys into the single value, once. */
async function migrateOldItems(env) {
  const items = [];
  const keys = [];
  let cursor;
  do {
    const page = await env.HUB_DATA.list({ prefix: OLD_PREFIX, cursor });
    for (const k of page.keys) { keys.push(k.name); if (k.metadata) items.push(k.metadata); }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await saveGrocery(env, items);
  await Promise.all(keys.map(k => env.HUB_DATA.delete(k)));
  return items;
}

/** Still to buy first, in the order they were added; then what's done. */
export function sortItems(items) {
  return items.slice().sort((a, b) => (a.done === b.done ? a.addedAt - b.addedAt : a.done ? 1 : -1));
}

/**
 * Adds a published plan's shoppingList to the list. Skips anything already on it
 * (not yet bought), and anything the planner added in the last 30 days, so
 * deleting an item the planner suggested keeps it deleted.
 */
export async function mergePlanShopping(env, shoppingList, now = Date.now()) {
  if (!env.HUB_DATA || !Array.isArray(shoppingList) || !shoppingList.length) return 0;
  const items = await listGrocery(env);
  const onList = new Set(items.filter(i => !i.done).map(i => norm(i.name)));
  let added = 0;
  for (const [i, s] of shoppingList.slice(0, 50).entries()) {
    const name = typeof s?.name === "string" ? s.name.trim() : "";
    const key = norm(name);
    if (!key || onList.has(key)) continue;
    if (await env.HUB_DATA.get(PLAN_PREFIX + key)) continue;
    const qty = parseInt(s.quantity, 10);
    const numeric = /^\s*\d+\s*$/.test(String(s.quantity ?? ""));
    const item = {
      id: `plan-${hash(key)}-${now.toString(36)}`.slice(0, 40),
      name: (s.quantity && !numeric ? `${name} (${String(s.quantity).trim()})` : name).slice(0, 80),
      quantity: numeric && qty > 0 ? Math.min(qty, 99) : 1,
      ...(typeof s.store === "string" && s.store.trim() ? { store: s.store.trim().slice(0, 40) } : {}),
      done: false,
      fromPlan: true,
      addedAt: now + i,          // keeps the planner's order
      updatedAt: now,
    };
    items.push(item);
    await env.HUB_DATA.put(PLAN_PREFIX + key, "1", { expirationTtl: PLAN_MEMORY_SECONDS });
    onList.add(key);
    added++;
  }
  if (added) await saveGrocery(env, items);
  return added;
}

/** Validates an item from a client. Fields are kept short. */
export function cleanItem(c, members) {
  if (!c || typeof c.id !== "string" || !ID_RE.test(c.id)) return null;
  const name = typeof c.name === "string" ? c.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (!name) return null;
  const updatedAt = Number(c.updatedAt);
  if (!Number.isFinite(updatedAt)) return null;
  const addedAt = Number.isFinite(Number(c.addedAt)) ? Number(c.addedAt) : updatedAt;
  const quantity = Math.min(99, Math.max(1, parseInt(c.quantity, 10) || 1));
  const item = { id: c.id, name, quantity, done: c.done === true, addedAt, updatedAt };
  if (typeof c.store === "string" && c.store.trim()) item.store = c.store.trim().slice(0, 40);
  if (typeof c.addedBy === "string" && members.has(c.addedBy)) item.addedBy = c.addedBy;
  return item;
}

/** A name as the list compares it: "Whole Milk!" and "whole milk" are the same item. */
export function norm(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
