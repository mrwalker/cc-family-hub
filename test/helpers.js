/** Test doubles: a KV namespace and a D1 database in memory, a hub config, and a stream context. */

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

/** node:sqlite (Node 22.5+) backs the D1 double; without it, D1 tests skip. */
const sqlite = await import("node:sqlite").catch(() => null);
export const NO_SQLITE = sqlite ? false : "needs node:sqlite (Node 22.5 or newer)";

/** A D1 database in memory: prepare/bind/all/first/run and batch, as the Worker uses them. */
export function memoryD1() {
  const db = new sqlite.DatabaseSync(":memory:");
  const plain = row => (row ? { ...row } : null);
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    exec() {
      const st = db.prepare(sql);
      if (/^\s*(select|with)\b/i.test(sql)) return { results: st.all(...args).map(plain), success: true };
      const r = st.run(...args);
      return { results: [], success: true, meta: { changes: Number(r.changes) } };
    },
    async all() { return this.exec(); },
    async run() { return this.exec(); },
    async first() { return plain(db.prepare(sql).get(...args)); },
  });
  return {
    sqlite: db,
    prepare: sql => statement(sql),
    // Like D1, a batch is one transaction: all of it or none.
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out = statements.map(s => s.exec());
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

export const HUB = {
  title: "Rivera Family Hub",
  timezone: "America/Los_Angeles",
  locale: "en-US",
  members: [
    { id: "alex", name: "Alex", color: "#2563eb", role: "adult", calendars: [], emails: ["alex@example.com"] },
    { id: "sam", name: "Sam", color: "#db2777", role: "child", calendars: [], emails: ["sam@example.com"] },
  ],
  emailToMember: { "alex@example.com": "alex", "sam@example.com": "sam", "pat@example.com": "pat" },
  tripApps: [],
  stream: {},
  outputs: {},
  photosAlbum: null,
};

/** A context at `now` (default: noon Pacific on 2027-06-21) with the given data. */
export function ctxWith({ data = {}, events = [], trips = [], photos = null, grocery = [], household = null, albums = {}, view = null, now = new Date("2027-06-21T19:00:00Z"), hub = HUB } = {}) {
  const env = { HUB_DATA: memoryKV(Object.fromEntries(Object.entries(data).map(([k, v]) => [`data:${k}`, v]))) };
  const ctx = makeContext({ request: new Request("https://hub.example.com/api/stream"), env, hub, loadEvents: async () => events, now, view });
  ctx.trips = async () => trips;
  ctx.photos = async () => photos;
  ctx.grocery = async () => grocery;
  ctx.household = async () => household;
  ctx.album = async link => albums[link] ?? null;
  return ctx;
}
