#!/usr/bin/env node
/**
 * Builds a family's hub from its repo (run from that repo's root):
 *
 *   workspace/family.yaml        members (+ color, shortName), hub.title, hub.guests,
 *                                hub.tripApps, hub.groceryEmailUrl, hub.photos
 *   workspace/members/<id>.yaml  calendarIds, email
 *     → .generated/hub-config.json   imported by the family's worker.js (never served)
 *
 *   cc-family-hub/app/public/    the hub page and the shared trip-app engine
 *   <trip dir>/ for each tripApp the family's trip pages
 *   public/ (optional)           extra static files, or overrides of the above
 *     → .generated/site/             the Worker's static assets
 *
 * Run it as the wrangler build.command, so it runs before every dev/deploy:
 *   "build": { "command": "node node_modules/cc-family-hub/app/build.mjs" }
 * Fails with "<file>: <path>: <problem>" lines if the workspace is inconsistent.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { albumKey } from "./worker/photos.js";

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
  return { id: m.id, name: m.shortName || m.name, color: m.color, calendars, emails };
});
if (!members.length) fail("family.yaml", "members", "no members listed");
if (hub.groceryEmailUrl != null && !/^https:\/\//.test(String(hub.groceryEmailUrl))) {
  fail("family.yaml", "hub.groceryEmailUrl", "expected an https:// URL");
}
if (hub.photos?.icloudAlbum != null && !albumKey(hub.photos.icloudAlbum)) {
  fail("family.yaml", "hub.photos.icloudAlbum", "expected an iCloud shared album link (https://photos.icloud.com/shared/album/…)");
}

const guests = Object.entries(hub.guests ?? {}).map(([id, g]) => {
  if (!ID_RE.test(id)) fail("family.yaml", `hub.guests.${id}`, "expected a lowercase id");
  if (memberIds.has(id)) fail("family.yaml", `hub.guests.${id}`, "is also a family member");
  if (g?.email != null && !String(g.email).includes("@")) fail("family.yaml", `hub.guests.${id}.email`, "not an email address");
  return { id, email: g?.email ? String(g.email).toLowerCase() : null };
});
const guestIds = new Set(guests.map(g => g.id));

const tripApps = (Array.isArray(hub.tripApps) ? hub.tripApps : []).map((t, i) => {
  const at = `hub.tripApps[${i}]`;
  if (typeof t?.trip !== "string") fail("family.yaml", `${at}.trip`, "required (the trip's id in trips.yaml)");
  if (!/^\/[a-z0-9-]+\/$/.test(t?.path ?? "")) fail("family.yaml", `${at}.path`, `expected "/<dir>/", got ${JSON.stringify(t?.path)}`);
  if (["/trip-app/", "/api/"].includes(t?.path)) fail("family.yaml", `${at}.path`, `${t.path} is reserved by the hub`);
  if (!ID_RE.test(t?.appId ?? "")) fail("family.yaml", `${at}.appId`, "expected a lowercase id");
  else if (t.appId.length > 40) fail("family.yaml", `${at}.appId`, "longer than 40 characters");
  const extra = strings(t?.guests);
  for (const g of extra) if (!guestIds.has(g)) fail("family.yaml", `${at}.guests`, `"${g}" is not listed under hub.guests`);
  if (t?.path && !existsSync(join(root, t.path, "index.html"))) fail("family.yaml", `${at}.path`, `no ${t.path}index.html in the repo`);
  return { trip: t.trip, path: t.path, appId: t.appId, players: [...memberIds, ...extra] };
});

const trips = tripApps.length ? load("trips.yaml") : [];
const knownTrips = new Set((Array.isArray(trips) ? trips : []).map(t => t?.id));
for (const [i, t] of tripApps.entries()) {
  if (t.trip && !knownTrips.has(t.trip)) fail("family.yaml", `hub.tripApps[${i}].trip`, `"${t.trip}" is not an id in trips.yaml`);
}

if (errors.length) {
  console.error(`Hub config is invalid (${errors.length} problem(s)):\n` + errors.map(e => `  - ${e}`).join("\n"));
  process.exit(1);
}

const config = {
  title: hub.title || `${family.family?.name ?? "Family"} Hub`,
  timezone: family.family?.timezone || "UTC",
  locale: family.family?.locale || "en-US",
  members,
  guests,
  tripApps,
  groceryEmailUrl: hub.groceryEmailUrl || null,
  photos: hub.photos?.icloudAlbum ? { icloudAlbum: String(hub.photos.icloudAlbum) } : null,
};
mkdirSync(GENERATED, { recursive: true });
writeFileSync(OUT, JSON.stringify(config, null, 2) + "\n");
console.log(`Hub config: ${members.length} members, ${guests.length} guests, ${tripApps.length} trip apps → .generated/hub-config.json`);

// Static site: toolkit pages, then each trip's folder, then the family's public/ overrides.
rmSync(SITE, { recursive: true, force: true });
cpSync(toolkitPublic, SITE, { recursive: true });
for (const t of tripApps) cpSync(join(root, t.path), join(SITE, t.path), { recursive: true });
if (existsSync(join(root, "public"))) cpSync(join(root, "public"), SITE, { recursive: true });
console.log(`Hub site: hub page + ${tripApps.length} trip apps → .generated/site/`);
