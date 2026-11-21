#!/usr/bin/env node
/**
 * Builds a family's hub from its repo (run from that repo's root):
 *
 *   workspace/family.yaml        members (+ color, shortName), inputs, stream, outputs,
 *                                hub.title, hub.shortTitle, hub.guests, hub.tripApps, hub.access, hub.householdCalendar,
 *                                hub.agent
 *                                (and the older hub.photos and hub.groceryEmailUrl)
 *   workspace/members/<id>.yaml  calendarIds, email, slack
 *     → .generated/hub-config.json   imported by the family's worker.js (never served)
 *
 *   cc-family-hub/app/public/    the hub page and the shared trip-app engine
 *   <trip dir>/ for each tripApp the family's trip pages
 *   public/ (optional)           extra static files, or overrides of the above
 *     → .generated/site/             the Worker's static assets, with the home-screen
 *                                    manifest.webmanifest named for the family
 *
 * With --check (family-hub check), it validates and summarizes without writing.
 *
 * Run it as the wrangler build.command, so it runs before every dev/deploy:
 *   "build": { "command": "node node_modules/cc-family-hub/app/build.mjs" }
 * Fails with "<file>: <path>: <problem>" lines if the workspace is inconsistent.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { albumKey } from "./worker/photos.js";
import { COMPONENT_IDS } from "./worker/components/index.js";
import { OUTPUT_DEFAULTS } from "./worker/stream.js";

const root = process.cwd();                                        // the family's repo
const toolkitPublic = join(dirname(fileURLToPath(import.meta.url)), "public");
const ws = (...p) => join(root, "workspace", ...p);
const GENERATED = join(root, ".generated");
const OUT = join(GENERATED, "hub-config.json");
const SITE = join(GENERATED, "site");

const errors = [];
const fail = (file, path, problem) => errors.push(`${file}: ${path}: ${problem}`);

function load(file) {
  const p = ws(file);
  if (!existsSync(p)) {
    fail(file, "(file)", "not found");
    return {};
  }
  try {
    return yaml.load(readFileSync(p, "utf8")) ?? {};
  } catch (e) {
    fail(file, "(file)", `invalid YAML: ${e.message.split("\n")[0]}`);
    return {};
  }
}

const ID_RE = /^[a-z0-9-]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
// Chat ids, as Slack writes them: a channel is C… (or G…), a person U… (or W…).
const CHAT_CHANNEL_RE = /^[CG][A-Z0-9]{5,19}$/;
const CHAT_PERSON_RE = /^[UW][A-Z0-9]{5,19}$/;
// Chat id → who that is, for the assistant's log (hub.agent).
const chatPeople = {};
function chatId(file, at, v, who) {
  if (v == null) return;
  if (typeof v !== "string" || !CHAT_PERSON_RE.test(v)) return fail(file, at, `expected the person's chat member id, like "U0123ABCD", got ${JSON.stringify(v)}`);
  if (chatPeople[v]) return fail(file, at, `${v} is also ${chatPeople[v].id}'s`);
  chatPeople[v] = who;
}

const family = load("family.yaml");
const hub = family.hub ?? {};
const memberIds = new Set();

const members = (Array.isArray(family.members) ? family.members : []).map((m, i) => {
  const at = `members[${i}]`;
  if (!ID_RE.test(m?.id ?? "")) fail("family.yaml", `${at}.id`, `expected a lowercase id, got ${JSON.stringify(m?.id)}`);
  if (!COLOR_RE.test(m?.color ?? "")) fail("family.yaml", `${at}.color`, `expected a #rrggbb color, got ${JSON.stringify(m?.color)}`);
  memberIds.add(m.id);
  const profile = load(`members/${m.id}.yaml`);
  const calendars = strings(profile.calendarIds);
  const emails = [...new Set([profile.email, ...calendars].filter(e => typeof e === "string" && e.includes("@")))]
    .map(e => e.toLowerCase());
  // Anyone not marked a child is an adult: adults manage household records.
  const role = m.role === "child" ? "child" : "adult";
  chatId(`members/${m.id}.yaml`, "slack", profile.slack, { id: m.id, role, name: m.shortName || m.name });
  return { id: m.id, name: m.shortName || m.name, color: m.color, role, calendars, emails };
});
if (!members.length) fail("family.yaml", "members", "no members listed");
const inputs = objectAt(family.inputs, "inputs");
const outputs = objectAt(family.outputs, "outputs");

// The photo album and grocery email moved from hub: to inputs: and outputs: in v0.7.
const album = inputs["icloud-album"]?.album ?? hub.photos?.icloudAlbum;
const albumAt = inputs["icloud-album"]?.album != null ? "inputs.icloud-album.album" : "hub.photos.icloudAlbum";
if (inputs["icloud-album"] && inputs["icloud-album"].album == null) fail("family.yaml", "inputs.icloud-album.album", "required (the shared album's link)");
if (album != null && !albumKey(album)) {
  fail("family.yaml", albumAt, "expected an iCloud shared album link (https://photos.icloud.com/shared/album/… or https://www.icloud.com/sharedalbum/#…)");
}
const groceryEmailUrl = outputs["grocery-email"]?.url ?? hub.groceryEmailUrl;
const groceryAt = outputs["grocery-email"]?.url != null ? "outputs.grocery-email.url" : "hub.groceryEmailUrl";
if (outputs["grocery-email"] && outputs["grocery-email"].url == null) fail("family.yaml", "outputs.grocery-email.url", "required (the Apps Script web app's URL)");
if (groceryEmailUrl != null && !/^https:\/\//.test(String(groceryEmailUrl))) fail("family.yaml", groceryAt, "expected an https:// URL");

// Inputs: the built-in ones, or a family's own module in integrations/inputs/<id>/.
const KNOWN_INPUTS = ["google-calendar", "icloud-album", "trips", "trip-apps", "grocery", "escape-rooms", "movies", "notes", "apple-reminders", "strava"];
for (const id of Object.keys(inputs)) {
  if (!KNOWN_INPUTS.includes(id) && !existsSync(join(root, "integrations", "inputs", id))) {
    fail("family.yaml", `inputs.${id}`, `unknown input. Known: ${KNOWN_INPUTS.join(", ")}`);
  }
}

// Outputs: screens (which can have a stream of their own) and pushes.
const SCREENS = Object.keys(OUTPUT_DEFAULTS);
const PUSHES = ["google-calendar", "grocery-email"];
const outputStreams = {};
for (const [id, o] of Object.entries(outputs)) {
  if (SCREENS.includes(id)) {
    if (o?.stream != null) outputStreams[id] = { stream: checkStream(o.stream, `outputs.${id}.stream`) };
  } else if (PUSHES.includes(id) || existsSync(join(root, "integrations", "outputs", id))) {
    if (o?.stream != null) fail("family.yaml", `outputs.${id}.stream`, "only screens have a stream");
  } else {
    fail("family.yaml", `outputs.${id}`, `unknown output. Screens: ${SCREENS.join(", ")}. Pushes: ${PUSHES.join(", ")}`);
  }
}
const stream = family.stream == null ? {} : checkStream(family.stream, "stream");

/** Validates a stream: section (docs/stream.md) and returns it. */
function checkStream(st, at) {
  if (!isObj(st)) { fail("family.yaml", at, "expected a map (components, dwell, photosBetween, max)"); return {}; }
  const out = {};
  for (const k of Object.keys(st)) {
    if (!["components", "dwell", "photosBetween", "max"].includes(k)) fail("family.yaml", `${at}.${k}`, "unknown setting. Expected components, dwell, photosBetween, or max");
  }
  if (st.components != null) {
    if (!Array.isArray(st.components) || !st.components.length) fail("family.yaml", `${at}.components`, "expected a list of components");
    else {
      st.components.forEach((c, i) => {
        if (!COMPONENT_IDS.includes(c)) fail("family.yaml", `${at}.components[${i}]`, `unknown component ${JSON.stringify(c)}. Known: ${COMPONENT_IDS.join(", ")}`);
      });
      out.components = st.components;
    }
  }
  const seconds = (v, p) => {
    if (typeof v !== "number" || !(v >= 3 && v <= 3600)) { fail("family.yaml", p, `expected seconds between 3 and 3600, got ${JSON.stringify(v)}`); return false; }
    return true;
  };
  if (st.dwell != null) {
    if (typeof st.dwell === "number") { if (seconds(st.dwell, `${at}.dwell`)) out.dwell = st.dwell; }
    else if (isObj(st.dwell)) {
      for (const [k, v] of Object.entries(st.dwell)) {
        if (k !== "default" && !COMPONENT_IDS.includes(k)) fail("family.yaml", `${at}.dwell.${k}`, `expected "default" or a component`);
        else seconds(v, `${at}.dwell.${k}`);
      }
      out.dwell = st.dwell;
    } else fail("family.yaml", `${at}.dwell`, "expected seconds, or a map of component to seconds");
  }
  if (st.photosBetween != null) {
    if (!Number.isInteger(st.photosBetween) || st.photosBetween < 0 || st.photosBetween > 10) fail("family.yaml", `${at}.photosBetween`, `expected a whole number from 0 to 10, got ${JSON.stringify(st.photosBetween)}`);
    else out.photosBetween = st.photosBetween;
  }
  if (st.max != null) {
    if (!isObj(st.max)) fail("family.yaml", `${at}.max`, "expected a map of component to a number of cards");
    else {
      for (const [k, v] of Object.entries(st.max)) {
        if (!COMPONENT_IDS.includes(k)) fail("family.yaml", `${at}.max.${k}`, "unknown component");
        else if (!Number.isInteger(v) || v < 1) fail("family.yaml", `${at}.max.${k}`, `expected a whole number of cards, got ${JSON.stringify(v)}`);
      }
      out.max = st.max;
    }
  }
  return out;
}

function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function objectAt(v, at) {
  if (v == null) return {};
  if (!isObj(v)) { fail("family.yaml", at, "expected a map of ids to their settings"); return {}; }
  // `id: {}` and a bare `id:` both mean "on, with no settings".
  return Object.fromEntries(Object.entries(v).map(([k, o]) => [k, o ?? {}]));
}

// hub.shortTitle: the name under the hub's icon on a phone's home screen.
if (hub.shortTitle != null && (typeof hub.shortTitle !== "string" || !hub.shortTitle.trim())) {
  fail("family.yaml", "hub.shortTitle", "expected a short name, like \"Rivera Hub\"");
}

// hub.access: what the Worker needs to check a Cloudflare Access sign-in itself,
// before it lets anyone change household records (docs/workspace.md).
let access = null;
if (hub.access != null) {
  const a = hub.access;
  if (!isObj(a)) fail("family.yaml", "hub.access", "expected a map with teamDomain and aud");
  else {
    const teamDomain = String(a.teamDomain ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) fail("family.yaml", "hub.access.teamDomain", `expected "<team>.cloudflareaccess.com", got ${JSON.stringify(a.teamDomain)}`);
    if (!/^[0-9a-f]{32,128}$/.test(String(a.aud ?? ""))) fail("family.yaml", "hub.access.aud", "expected the Access application's audience (AUD) tag, a long hex string");
    access = { teamDomain, aud: String(a.aud) };
  }
}

// hub.householdCalendar: the Google Calendar booked household appointments go on.
const householdCalendar = hub.householdCalendar == null ? null : String(hub.householdCalendar).trim();
if (householdCalendar != null && !/^[^\s@]+@[^\s@]+$/.test(householdCalendar)) {
  fail("family.yaml", "hub.householdCalendar", "expected a Google Calendar ID (Calendar settings → Integrate calendar), like \"abc123@group.calendar.google.com\"");
}

const guests = Object.entries(hub.guests ?? {}).map(([id, g]) => {
  if (!ID_RE.test(id)) fail("family.yaml", `hub.guests.${id}`, "expected a lowercase id");
  if (memberIds.has(id)) fail("family.yaml", `hub.guests.${id}`, "is also a family member");
  if (g?.email != null && !String(g.email).includes("@")) fail("family.yaml", `hub.guests.${id}.email`, "not an email address");
  chatId("family.yaml", `hub.guests.${id}.slack`, g?.slack, { id, role: "guest", name: typeof g?.name === "string" ? g.name : id });
  return { id, email: g?.email ? String(g.email).toLowerCase() : null };
});
const guestIds = new Set(guests.map(g => g.id));

const tripApps = (Array.isArray(hub.tripApps) ? hub.tripApps : []).map((t, i) => {
  const at = `hub.tripApps[${i}]`;
  if (typeof t?.trip !== "string") fail("family.yaml", `${at}.trip`, "required (the trip's id: on /household/ › Trips, or in trips.yaml)");
  if (!/^\/[a-z0-9-]+\/$/.test(t?.path ?? "")) fail("family.yaml", `${at}.path`, `expected "/<dir>/", got ${JSON.stringify(t?.path)}`);
  if (["/trip-app/", "/api/", "/household/"].includes(t?.path)) fail("family.yaml", `${at}.path`, `${t.path} is reserved by the hub`);
  if (!ID_RE.test(t?.appId ?? "")) fail("family.yaml", `${at}.appId`, "expected a lowercase id");
  else if (t.appId.length > 40) fail("family.yaml", `${at}.appId`, "longer than 40 characters");
  const extra = strings(t?.guests);
  for (const g of extra) if (!guestIds.has(g)) fail("family.yaml", `${at}.guests`, `"${g}" is not listed under hub.guests`);
  if (t?.path && !existsSync(join(root, t.path, "index.html"))) fail("family.yaml", `${at}.path`, `no ${t.path}index.html in the repo`);
  const summary = t?.path ? tripSummary(t.path, at) : null;
  return { trip: t.trip, path: t.path, appId: t.appId, players: [...memberIds, ...extra], summary };
});

/**
 * What screens outside the trip app (the Roku screensaver, widgets) need from a
 * trip's trip-data.js: title, dates, hero photo, people, and the quest scoring
 * table. The file sets window.TRIP; it runs here in an empty sandbox.
 */
function tripSummary(path, at) {
  const file = join(root, path, "trip-data.js");
  if (!existsSync(file)) return null;
  let T;
  try {
    const window = {};
    runInNewContext(readFileSync(file, "utf8"), { window }, { filename: file, timeout: 1000 });
    T = window.TRIP;
  } catch (err) {
    fail(`${path}trip-data.js`, "", `couldn't run it: ${err.message}`);
    return null;
  }
  if (!T || typeof T !== "object") { fail(`${path}trip-data.js`, "", "doesn't set window.TRIP"); return null; }
  const str = v => (typeof v === "string" ? v : null);
  return {
    title: str(T.title), titleAccent: str(T.titleAccent), resort: str(T.resort),
    start: str(T.start), end: str(T.end), tz: str(T.tz),
    countdown: str(T.text?.countdown), team: str(T.text?.team),
    hero: str(T.photo?.src) ? `${path}${T.photo.src.replace(/^\.?\//, "")}` : null,
    members: (T.members ?? []).map(m => ({ id: m.id, name: m.name, color: m.color })),
    scoring: { firstBonus: Number(T.scoring?.firstBonus) || 0, varietyBonus: Number(T.scoring?.varietyBonus) || 0 },
    categories: (T.categories ?? []).map(c => c.id),
    quests: Object.fromEntries((T.quests ?? []).map(q => [q.id, { pts: Number(q.pts) || 0, cat: q.cat }])),
    days: (T.days ?? []).map(d => ({
      date: str(d.date), title: str(d.title), emoji: str(d.emoji),
      items: (d.items ?? []).map(i => ({ time: str(i.time) ?? str(i.when), emoji: str(i.emoji), title: str(i.title) })),
    })),
    // For the assistant's briefings (worker/agent.js): what's on each packing list and
    // for whom, and the plan's "!" tags, which mark something still to book or ask.
    packing: (T.packing ?? []).flatMap(g => (g.items ?? [])
      .filter(i => str(i.id))
      .map(i => ({ id: i.id, ...(Array.isArray(i.who) ? { who: strings(i.who) } : {}) }))),
    flags: (T.days ?? []).flatMap(d => (d.items ?? []).flatMap(i => strings(i.tags)
      .filter(t => t.startsWith("!"))
      .map(t => ({ date: str(d.date), title: str(i.title), flag: t.slice(1).trim() })))),
  };
}

// hub.agent: the family's assistant (docs/assistant.md). Each chat channel it works in
// names what it may touch there: one trip, one place, or a part of the household.
const AGENT_SCOPES = ["household", "ops", "grocery", "pets", "movies"];
let agent = null;
if (hub.agent != null) {
  if (!isObj(hub.agent) || !isObj(hub.agent.channels ?? {})) fail("family.yaml", "hub.agent", "expected a map with channels");
  else {
    const channels = {};
    for (const [id, c] of Object.entries(hub.agent.channels ?? {})) {
      const at = `hub.agent.channels.${id}`;
      if (!CHAT_CHANNEL_RE.test(id)) { fail("family.yaml", at, `expected a channel id, like "C0123ABCD" (not the channel's name)`); continue; }
      const keys = isObj(c) ? Object.keys(c) : [];
      if (keys.length !== 1 || !["trip", "place", "scope"].includes(keys[0])) {
        fail("family.yaml", at, `expected one of { trip: <trip id> }, { place: <place id> } or { scope: ${AGENT_SCOPES.join(" | ")} }`);
      } else if (c.scope != null) {
        if (!AGENT_SCOPES.includes(c.scope)) fail("family.yaml", `${at}.scope`, `expected one of ${AGENT_SCOPES.join(", ")}, got ${JSON.stringify(c.scope)}`);
        else channels[id] = { scope: c.scope };
      } else {
        const [kind] = keys;
        if (typeof c[kind] !== "string" || !ID_RE.test(c[kind])) fail("family.yaml", `${at}.${kind}`, `expected the ${kind}'s id (on /household/), got ${JSON.stringify(c[kind])}`);
        else channels[id] = { scope: kind, [kind]: c[kind] };
      }
    }
    agent = { name: typeof hub.agent.name === "string" && hub.agent.name.trim() ? hub.agent.name.trim() : "Assistant", channels, people: chatPeople };
  }
}

// Since v2.9 the hub keeps a family's trips (edited on /household/), and trips.yaml is
// only the list it imports once. While the file is here, check it; without it, a trip
// app's trip id can't be checked until the Worker runs (an app whose trip it doesn't
// know still gets a card).
const trips = existsSync(ws("trips.yaml")) ? load("trips.yaml") : null;
// A trip's shared album (trips.yaml → album) has to be a link the Worker can read.
(Array.isArray(trips) ? trips : []).forEach((t, i) => {
  if (t?.album != null && !albumKey(t.album)) {
    fail("trips.yaml", `[${i}] (${t.id ?? "?"}).album`, "expected an iCloud shared album link (https://photos.icloud.com/shared/album/… or https://www.icloud.com/sharedalbum/#…) with Public Website on");
  }
});
if (Array.isArray(trips)) {
  const knownTrips = new Set(trips.map(t => t?.id));
  for (const [i, t] of tripApps.entries()) {
    if (t.trip && !knownTrips.has(t.trip)) fail("family.yaml", `hub.tripApps[${i}].trip`, `"${t.trip}" is not an id in trips.yaml`);
  }
}

if (errors.length) {
  console.error(`Hub config is invalid (${errors.length} problem(s)):\n` + errors.map(e => `  - ${e}`).join("\n"));
  process.exit(1);
}

if (process.argv.includes("--check")) {
  const legacy = Array.isArray(family.integrations?.active) ? family.integrations.active : [];
  const list = xs => (xs.length ? xs.join(", ") : "none");
  console.log(`✓ family.yaml and members/ are valid
  Members:    ${list(members.map(m => m.id))}
  Inputs:     ${list([...new Set([...Object.keys(inputs), ...legacy.filter(id => KNOWN_INPUTS.includes(id))])])}${legacy.length ? "  (some from integrations.active)" : ""}
  Stream:     ${list(stream.components ?? COMPONENT_IDS)}
  Screens:    ${list(SCREENS.map(id => (outputStreams[id] ? `${id} (own stream)` : id)))}
  Pushes:     ${list([...new Set([...Object.keys(outputs).filter(id => !SCREENS.includes(id)), ...legacy.filter(id => PUSHES.includes(id))])])}
  Trip apps:  ${list(tripApps.map(t => t.path))}
  Assistant:  ${agent ? `${Object.keys(agent.channels).length} channels, ${Object.keys(agent.people).length} chat ids` : "not set up"}`);
  process.exit(0);
}

const config = {
  title: hub.title || `${family.family?.name ?? "Family"} Hub`,
  timezone: family.family?.timezone || "UTC",
  locale: family.family?.locale || "en-US",
  members,
  guests,
  access,
  householdCalendar,
  tripApps,
  agent,
  build: {
    toolkit: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version,
    builtAt: new Date().toISOString(),
    commit: process.env.WORKERS_CI_COMMIT_SHA || null,
  },
  groceryEmailUrl: groceryEmailUrl || null,
  photos: album ? { icloudAlbum: String(album) } : null,
  stream,
  outputs: outputStreams,
};
mkdirSync(GENERATED, { recursive: true });
writeFileSync(OUT, JSON.stringify(config, null, 2) + "\n");
console.log(`Hub config: ${members.length} members, ${guests.length} guests, ${tripApps.length} trip apps, stream of ${(stream.components ?? COMPONENT_IDS).length} components → .generated/hub-config.json`);

// Static site: toolkit pages, then each trip's folder, then the family's public/ overrides.
rmSync(SITE, { recursive: true, force: true });
cpSync(toolkitPublic, SITE, { recursive: true });
for (const t of tripApps) cpSync(join(root, t.path), join(SITE, t.path), { recursive: true });
if (existsSync(join(root, "public"))) cpSync(join(root, "public"), SITE, { recursive: true });
writeHomeScreen();
console.log(`Hub site: hub page + ${tripApps.length} trip apps → .generated/site/`);

/**
 * Makes the hub installable on a phone's home screen (docs/outputs.md): a web app manifest
 * named for the family, and the family's names in the pages' <title> and iOS app title.
 * A family's own public/manifest.webmanifest or icons/ win, since public/ was copied last.
 */
function writeHomeScreen() {
  const name = config.title;
  const shortName = hub.shortTitle?.trim() || name;
  const manifest = join(SITE, "manifest.webmanifest");
  if (!existsSync(join(root, "public", "manifest.webmanifest"))) {
    writeFileSync(manifest, JSON.stringify({
      name,
      short_name: shortName,
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#08090c",
      theme_color: "#08090c",
      icons: [
        { src: "/icons/hub-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/hub-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/hub-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    }, null, 2) + "\n");
  }
  const attr = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  for (const page of ["index.html", "household/index.html"]) {
    const p = join(SITE, page);
    if (!existsSync(p)) continue;
    const html = readFileSync(p, "utf8")
      .replace(/<title>Family Hub<\/title>/, `<title>${attr(name)}</title>`)
      .replace(/(<meta name="apple-mobile-web-app-title" content=")Family Hub(")/, `$1${attr(shortName)}$2`);
    writeFileSync(p, html);
  }
}
