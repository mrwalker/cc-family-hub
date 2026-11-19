/** Test doubles: a KV namespace in memory, a hub config, and a stream context. */

import { makeContext } from "../app/worker/stream.js";

export function memoryKV(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, { value: typeof v === "string" ? v : JSON.stringify(v), metadata: null }]));
  return {
    store,
    async get(key, type) {
      const e = store.get(key);
      if (!e) return null;
      return type === "json" ? JSON.parse(e.value) : e.value;
    },
    async getWithMetadata(key, type) {
      const e = store.get(key);
      if (!e) return { value: null, metadata: null };
      return { value: type === "json" ? JSON.parse(e.value) : e.value, metadata: e.metadata };
    },
    async put(key, value, opts = {}) { store.set(key, { value, metadata: opts.metadata ?? null }); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "" } = {}) {
      const keys = [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata }));
      return { keys, list_complete: true };
    },
  };
}

export const HUB = {
  title: "Rivera Family Hub",
  timezone: "America/Los_Angeles",
  locale: "en-US",
  members: [
    { id: "alex", name: "Alex", color: "#2563eb", calendars: [], emails: [] },
    { id: "sam", name: "Sam", color: "#db2777", calendars: [], emails: [] },
  ],
  tripApps: [],
  stream: {},
  outputs: {},
  photosAlbum: null,
};

/** A context at `now` (default: noon Pacific on 2027-06-21) with the given data. */
export function ctxWith({ data = {}, events = [], trips = [], photos = null, grocery = [], view = null, now = new Date("2027-06-21T19:00:00Z"), hub = HUB } = {}) {
  const env = { HUB_DATA: memoryKV(Object.fromEntries(Object.entries(data).map(([k, v]) => [`data:${k}`, v]))) };
  const ctx = makeContext({ request: new Request("https://hub.example.com/api/stream"), env, hub, loadEvents: async () => events, now, view });
  ctx.trips = async () => trips;
  ctx.photos = async () => photos;
  ctx.grocery = async () => grocery;
  return ctx;
}
