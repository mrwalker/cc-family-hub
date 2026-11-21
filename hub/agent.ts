/**
 * The assistant's commands: what an agent in the family's chat runs to read and change
 * the hub (app/worker/agent.js). One command is one checked change.
 *
 *   family-hub trip list | show | brief [--json]
 *   family-hub trip add-idea --text T
 *   family-hub trip add-restaurant --name N [--price '$$'] [--type T] [--note T]
 *   family-hub trip add-activity --name N [--emoji E] [--note T]
 *   family-hub grocery list
 *   family-hub grocery add --name N [--qty 2] [--store S]
 *   family-hub grocery check --name N
 *   family-hub log list [--limit 20]
 *   family-hub log undo <id>
 *   family-hub doctor [--max-age-hours 26] [--json]
 *
 * Every command but doctor says where it's working: --channel <id> (or HUB_AGENT_CHANNEL).
 * The channel decides what it may touch (family.yaml → hub.agent.channels). In a trip's
 * channel the trip is that one; elsewhere name it with --trip <id>. A change also says who
 * asked: --for <their chat id, or their name> (or HUB_AGENT_FOR); with a chat id,
 * --for-name adds a name for someone the hub doesn't know. A value of - reads that text
 * from stdin, so quotes can't break a command.
 *
 * The last line is "<WHAT> OK: …" or "<WHAT> FAILED: …". Exit codes: 0 done (or nothing to
 * do); 1 refused, don't retry as it is; 2 the command was mistyped; 3 the hub couldn't be
 * reached or isn't set up, try later.
 */

import { readFileSync } from "fs";
import { hubFetch, hubSecrets, HubError } from "./hub-client.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

class Usage extends Error {}

interface Flags { [k: string]: string | undefined }

function parse(argv: string[]): { words: string[]; flags: Flags } {
  const words: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { words.push(a); continue; }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (name === "json") { flags.json = "1"; continue; }
    const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new Usage(`--${name} needs a value`);
    flags[name] = value === "-" ? readFileSync(0, "utf8").trim() : value;
  }
  return { words, flags };
}

const query = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return q ? `?${q}` : "";
};

function channel(flags: Flags): string {
  const c = flags.channel ?? process.env.HUB_AGENT_CHANNEL;
  if (!c) throw new Usage("Say where you're working: --channel <the channel's id, like C0123ABCD>");
  return c;
}

/** Who asked: --for takes their chat id (U0123ABCD) or, without one, their name. */
function actor(flags: Flags): { slack?: string; name?: string } {
  const who = flags.for ?? process.env.HUB_AGENT_FOR;
  const name = flags["for-name"];
  if (!who && !name) throw new Usage("Say who asked: --for <their chat id like U0123ABCD, or their name>");
  const isId = !!who && /^[UW][A-Z0-9]{5,19}$/.test(who);
  return { ...(isId ? { slack: who } : {}), ...(name || (who && !isId) ? { name: name ?? who } : {}) };
}

function need(flags: Flags, name: string, form: string): string {
  const v = flags[name];
  if (!v) throw new Usage(`Usage: family-hub ${form}`);
  return v;
}

interface OpResult { status: "applied" | "unchanged"; summary: string; logId?: string }

/** One change. Prints what happened; the caller prints the last line. */
async function change(op: string, args: Record<string, unknown>, flags: Flags): Promise<string> {
  const body = { op, args: { ...args, ...(flags.trip ? { trip: flags.trip } : {}) }, channel: channel(flags), actor: actor(flags), source: "cli" };
  const r = await hubFetch<OpResult>("/api/agent/ops", { token: "agent", method: "POST", body });
  return r.status === "applied" ? `${r.summary} (log ${r.logId}; undo with: family-hub log undo ${r.logId})` : `nothing to do. ${r.summary}`;
}

const out = (line = "") => console.log(line);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ─── Trips ────────────────────────────────────────────────────────────────────

interface Trip {
  id: string; name: string; destination: string | null; startDate: string; endDate: string; who: string[];
  description: string | null; highlights: { label: string }[]; activities: { emoji: string; name: string; note: string }[];
  restaurants: { name: string; price: string; type: string; note: string }[]; ideas: string[];
}
interface PlanDay { date: string; title: string | null; items: { time: string | null; emoji: string | null; title: string | null }[] }
interface Facts {
  trip: string; name: string; destination: string | null; timezone: string; today: string; start: string; end: string;
  phase: "before" | "during" | "after"; daysUntil: number; day?: number; endedDaysAgo?: number; days: number;
  datesMismatch: { record: { start: string; end: string }; app: { start: string; end: string } } | null;
  schedule: { asOf: string | null; today: PlanDay | null; tomorrow: PlanDay | null } | null;
  unbooked: { date: string | null; title: string | null; flag: string }[]; empty: string[];
  packing: { name: string; packed: number; total: number }[];
  leaderboard: { name: string; points: number }[]; questsDone: number; questsTotal: number;
  recentChanges: { summary: string; by: string | null }[];
  record: { ideas: string[]; restaurants: string[]; activities: string[] } | null;
}

async function trip(verb: string | undefined, flags: Flags): Promise<string> {
  if (verb === "list") {
    const { trips } = await hubFetch<{ trips: Trip[] }>(`/api/agent/trips${query({ channel: channel(flags) })}`, { token: "agent" });
    for (const t of trips) out(`- ${t.id}: ${t.name}${t.destination ? ` (${t.destination})` : ""}, ${t.startDate} to ${t.endDate}`);
    return plural(trips.length, "trip");
  }
  if (verb === "show") {
    const { trip: t } = await hubFetch<{ trip: Trip }>(`/api/agent/trip${query({ channel: channel(flags), trip: flags.trip })}`, { token: "agent" });
    if (flags.json) { out(JSON.stringify(t, null, 2)); return t.name; }
    out(`trip: ${t.name} (${t.id})${t.destination ? `, ${t.destination}` : ""}`);
    out(`when: ${t.startDate} to ${t.endDate}`);
    if (t.who.length) out(`who: ${t.who.join(", ")}`);
    if (t.description) out(`about: ${t.description}`);
    out(`restaurants (${t.restaurants.length}):`);
    for (const r of t.restaurants) out(`- ${[r.name, r.price, r.type].filter(Boolean).join(", ")}${r.note ? `: ${r.note}` : ""}`);
    out(`things to do (${t.activities.length}):`);
    for (const a of t.activities) out(`- ${a.name}${a.note ? `: ${a.note}` : ""}`);
    out(`ideas (${t.ideas.length}):`);
    for (const i of t.ideas) out(`- ${i}`);
    return t.name;
  }
  if (verb === "brief") {
    const f = await hubFetch<Facts>(`/api/agent/facts/trip${query({ channel: channel(flags), trip: flags.trip })}`, { token: "agent" });
    if (flags.json) { out(JSON.stringify(f, null, 2)); return `facts for ${f.name}`; }
    const when = f.phase === "before" ? `starts in ${plural(f.daysUntil, "day")}`
      : f.phase === "during" ? `day ${f.day} of ${f.days}` : `ended ${plural(f.endedDaysAgo ?? 0, "day")} ago`;
    out(`trip: ${f.name} (${f.trip})${f.destination ? `, ${f.destination}` : ""}`);
    out(`when: ${f.start} to ${f.end} (${plural(f.days, "day")}); ${when}`);
    out(`today there: ${f.today} (${f.timezone})`);
    const plan = (label: string, d: PlanDay | null) => {
      if (!d) return;
      out(`${label} (${d.date}${d.title ? `, ${d.title}` : ""}):`);
      for (const i of d.items) out(`- ${[i.time, i.title].filter(Boolean).join(" ")}`);
    };
    plan("today's plan", f.schedule?.today ?? null);
    plan("tomorrow's plan", f.schedule?.tomorrow ?? null);
    if (f.unbooked.length) {
      out("still to book or ask:");
      for (const u of f.unbooked) out(`- ${[u.date, u.title].filter(Boolean).join(" ")}: ${u.flag}`);
    }
    if (f.empty.length) out(`nothing listed yet under: ${f.empty.join(", ")}`);
    if (f.packing.length) out(`packed: ${f.packing.map(p => `${p.name} ${p.packed}/${p.total}`).join(", ")}`);
    if (f.questsTotal) out(`quests: ${f.questsDone} of ${f.questsTotal} done${f.leaderboard.some(l => l.points) ? `. ${f.leaderboard.filter(l => l.points).map(l => `${l.name} ${l.points}`).join(", ")}` : ""}`);
    if (f.record) out(`on the hub: ${plural(f.record.restaurants.length, "restaurant")}, ${plural(f.record.activities.length, "thing", "things")} to do, ${plural(f.record.ideas.length, "idea")}`);
    if (f.datesMismatch) out(`dates differ: the hub's record says ${f.datesMismatch.record.start} to ${f.datesMismatch.record.end}, the trip app says ${f.datesMismatch.app.start} to ${f.datesMismatch.app.end}. Tell an adult`);
    if (f.recentChanges.length) {
      out("changed lately:");
      for (const c of f.recentChanges) out(`- ${c.summary}${c.by ? ` (for ${c.by})` : ""}`);
    }
    return `facts for ${f.name}`;
  }
  if (verb === "add-idea") return change("trip.add-idea", { text: need(flags, "text", "trip add-idea --text T") }, flags);
  if (verb === "add-restaurant") {
    return change("trip.add-restaurant", { name: need(flags, "name", "trip add-restaurant --name N [--price '$$'] [--type T] [--note T]"), price: flags.price, type: flags.type, note: flags.note }, flags);
  }
  if (verb === "add-activity") {
    return change("trip.add-activity", { name: need(flags, "name", "trip add-activity --name N [--emoji E] [--note T]"), emoji: flags.emoji, note: flags.note }, flags);
  }
  throw new Usage("Usage: family-hub trip list | show | brief | add-idea | add-restaurant | add-activity");
}

// ─── Groceries, the log, the doctor ───────────────────────────────────────────

async function grocery(verb: string | undefined, flags: Flags): Promise<string> {
  if (verb === "list") {
    const { items } = await hubFetch<{ items: { name: string; quantity: number; store: string | null; done: boolean }[] }>(`/api/agent/grocery${query({ channel: channel(flags) })}`, { token: "agent" });
    const open = items.filter(i => !i.done);
    for (const i of open) out(`- ${i.quantity > 1 ? `${i.quantity} × ` : ""}${i.name}${i.store ? ` (${i.store})` : ""}`);
    return `${plural(open.length, "item")} to buy, ${items.length - open.length} bought`;
  }
  if (verb === "add") {
    const qty = flags.qty ?? flags.quantity;
    return change("grocery.add", { name: need(flags, "name", "grocery add --name N [--qty 2] [--store S]"), ...(qty ? { quantity: Number(qty) } : {}), store: flags.store }, flags);
  }
  if (verb === "check") return change("grocery.check", { name: need(flags, "name", "grocery check --name N") }, flags);
  throw new Usage("Usage: family-hub grocery list | add --name N | check --name N");
}

async function log(verb: string | undefined, id: string | undefined, flags: Flags): Promise<string> {
  if (verb === "list") {
    const { log: rows } = await hubFetch<{ log: { id: string; at: string; summary: string; by: string | null; undone: boolean }[] }>(`/api/agent/log${query({ channel: channel(flags), limit: flags.limit })}`, { token: "agent" });
    for (const r of rows) out(`- ${r.id} ${r.at.slice(0, 16).replace("T", " ")}Z ${r.summary}${r.by ? ` (for ${r.by})` : ""}${r.undone ? " [undone]" : ""}`);
    return plural(rows.length, "change");
  }
  if (verb === "undo" && id) {
    const r = await hubFetch<OpResult>(`/api/agent/log/${encodeURIComponent(id)}/undo`, { token: "agent", method: "POST", body: { channel: channel(flags), actor: actor(flags) } });
    return r.status === "applied" ? r.summary : `nothing to do. ${r.summary}`;
  }
  throw new Usage("Usage: family-hub log list [--limit 20] | log undo <id>");
}

interface Health {
  serverTime: string; build: { toolkit: string; builtAt: string } | null; schema: { code: number; db: number | null };
  data: Record<string, { publishedAt: string | null } | null>; bindings: Record<string, boolean>; secrets: Record<string, boolean>;
  agent: { configured: boolean; channels: number; lastWriteAt: string | null }; tripApps: { trip: string; path: string; known: boolean | null }[];
}

/** Checks the live hub without an assistant's judgment. Returns the number of problems. */
async function doctor(flags: Flags): Promise<number> {
  const token = hubSecrets()?.agentToken ? "agent" : "publish";
  const h = await hubFetch<Health>("/api/agent/health", { token });
  if (flags.json) out(JSON.stringify(h, null, 2));
  const maxAge = Number(flags["max-age-hours"]) || 26;
  let problems = 0;
  const check = (ok: boolean, good: string, bad: string) => { out(`${ok ? "ok  " : "FAIL"} ${ok ? good : bad}`); if (!ok) problems++; };
  const note = (line: string) => out(`note ${line}`);
  const now = Date.parse(h.serverTime);

  out(`hub: cc-family-hub ${h.build?.toolkit ?? "(unknown version)"}${h.build ? `, built ${h.build.builtAt}` : ""}`);
  if (h.build && h.build.toolkit !== VERSION) note(`this machine has cc-family-hub ${VERSION}; the hub runs ${h.build.toolkit}. Fine right after a release; otherwise git pull and npm install here, or check the hub's last deploy`);
  for (const kind of ["plan", "family"]) {
    const at = h.data[kind]?.publishedAt;
    const hours = at ? (now - Date.parse(at)) / 3_600_000 : null;
    check(hours != null && hours <= maxAge, `${kind} published ${hours?.toFixed(1)} hours ago`,
      hours == null ? `${kind} has never been published. Run the daily plan (family-hub publish)` : `${kind} was last published ${hours.toFixed(0)} hours ago (over ${maxAge}). The daily plan didn't publish; run it and read its last lines`);
  }
  for (const b of Object.keys(h.bindings)) check(h.bindings[b], `${b} is bound`, `${b} isn't bound in wrangler.jsonc`);
  check(h.schema.db === h.schema.code, `database schema is current (v${h.schema.code})`, `database schema is v${h.schema.db}, the code expects v${h.schema.code}. Open /household/ once, then check again`);
  check(h.secrets.AGENT_TOKEN && h.agent.configured, `the assistant is set up (${plural(h.agent.channels, "channel")})`,
    h.secrets.AGENT_TOKEN ? "family.yaml has no hub.agent.channels (docs/assistant.md)" : "the Worker has no AGENT_TOKEN secret (wrangler secret put AGENT_TOKEN)");
  for (const a of h.tripApps) check(a.known !== false, `trip app ${a.path} belongs to trip "${a.trip}"`, `trip app ${a.path} names trip "${a.trip}", which the hub doesn't have. Fix hub.tripApps in family.yaml or add the trip on /household/ › Trips`);
  return problems;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const [what, ...rest] = process.argv.slice(2);
const WHAT = (what ?? "hub").toUpperCase();

async function main(): Promise<number> {
  const { words, flags } = parse(rest);
  if (what === "doctor") {
    const problems = await doctor(flags);
    out(problems ? `\nDOCTOR FAILED: ${plural(problems, "problem")}` : "\nDOCTOR OK");
    return problems ? 1 : 0;
  }
  const done = what === "trip" ? await trip(words[0], flags)
    : what === "grocery" ? await grocery(words[0], flags)
    : what === "log" ? await log(words[0], words[1], flags)
    : null;
  if (done == null) throw new Usage("Usage: family-hub trip | grocery | log | doctor …");
  out(`\n${WHAT} OK: ${done}`);
  return 0;
}

main().then(code => process.exit(code), err => {
  const e = err as Error;
  if (e instanceof Usage) {
    out(e.message);
    out(`\n${WHAT} FAILED: the command was mistyped (above). Fix it and run it once more`);
    process.exit(2);
  }
  if (e instanceof HubError) {
    out(`\n${WHAT} FAILED: ${e.message}${e.retry ? "" : ". Don't run the same command again"}`);
    process.exit(e.retry ? 3 : 1);
  }
  out(`\n${WHAT} FAILED: ${e.message}`);
  process.exit(1);
});
