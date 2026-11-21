#!/usr/bin/env node
/**
 * family-hub: the cc-family-hub command, run from a family's hub repo.
 *
 *   family-hub init <dir>        Create a new hub repo
 *   family-hub check             Validate the workspace and secrets
 *   family-hub sync              Pull every synced input (calendars, reminders, Strava)
 *   family-hub plan              Plan the week through the Claude API, then publish
 *   family-hub render            Write the planner prompt for an assistant to answer
 *   family-hub publish           Validate the assistant's plan and publish it
 *   family-hub run               sync, then plan (the daily job)
 *   family-hub summary           Print a readable summary of the week
 *   family-hub movies history    Print past movie picks and who wanted or saw each
 *   family-hub movies publish F  Hand the hub this month's movie picks (a JSON file)
 *   family-hub trip …            The assistant: read a trip, brief on it, add to its lists
 *   family-hub grocery …         The assistant: read, add to and check off the grocery list
 *   family-hub task …            The assistant: household tasks (pets, the houses)
 *   family-hub chore …           The assistant: today's chores, and ticking one
 *   family-hub movie …           The assistant: movies, and marking one wanted or seen
 *   family-hub proposal …        The assistant: changes waiting for an adult's yes
 *   family-hub inbox …           The assistant: questions asked on the hub, and answering them
 *   family-hub note set          The assistant: a note on the hub for a trip or home
 *   family-hub log …             The assistant: what it changed, and undoing a change
 *   family-hub doctor            Check the live hub: what's deployed, how fresh its data is
 *   family-hub build             Validate the workspace and assemble the Worker's site
 *   family-hub setup calendars   Check the Google service account and calendar sharing
 *   family-hub setup strava      Connect a member's Strava account
 *
 * The workspace is ./workspace (or HUB_WORKSPACE), and secrets are in
 * HUB_SECRETS_DIR (or workspace/state). Both can be set in ./.env.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;

const USAGE = readFileSync(fileURLToPath(import.meta.url), "utf8")
  .match(/\/\*\*\n \* family-hub:[\s\S]*?\*\//)[0]
  .split("\n").slice(3).map(l => l.replace(/^ \* ?/, "")).join("\n").split("\n\n")[0];

/** Runs a TypeScript entry point of this package with tsx, in the caller's directory. */
function tsx(file, args = []) {
  const cli = fileURLToPath(import.meta.resolve("tsx/cli"));
  return run(process.execPath, [cli, join(PKG, file), ...args]);
}
function node(file, args = []) {
  return run(process.execPath, [join(PKG, file), ...args]);
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: process.cwd(), env: process.env });
  return r.status ?? 1;
}

const COMMANDS = {
  sync:    () => tsx("hub/index.ts", ["sync"]),
  plan:    () => tsx("hub/index.ts", ["plan"]),
  render:  () => tsx("hub/index.ts", ["render"]),
  publish: () => tsx("hub/index.ts", ["publish"]),
  summary: () => tsx("hub/index.ts", ["summary"]),
  movies: (what, file) => tsx("hub/movies.ts", [what, file].filter(Boolean)),
  // The assistant's commands (hub/agent.ts, docs/assistant.md).
  trip:    (...args) => tsx("hub/agent.ts", ["trip", ...args]),
  grocery: (...args) => tsx("hub/agent.ts", ["grocery", ...args]),
  log:     (...args) => tsx("hub/agent.ts", ["log", ...args]),
  task:    (...args) => tsx("hub/agent.ts", ["task", ...args]),
  chore:   (...args) => tsx("hub/agent.ts", ["chore", ...args]),
  movie:   (...args) => tsx("hub/agent.ts", ["movie", ...args]),
  proposal: (...args) => tsx("hub/agent.ts", ["proposal", ...args]),
  inbox:   (...args) => tsx("hub/agent.ts", ["inbox", ...args]),
  note:    (...args) => tsx("hub/agent.ts", ["note", ...args]),
  doctor:  (...args) => tsx("hub/agent.ts", ["doctor", ...args]),
  build:   () => node("app/build.mjs"),
  run() {
    const synced = tsx("hub/index.ts", ["sync"]);
    if (synced !== 0) console.error("\nSync had errors (above). Planning with what was synced.\n");
    return tsx("hub/index.ts", ["plan"]);
  },
  check() {
    console.log("── Workspace ────────────────────────────────────────");
    const config = node("app/build.mjs", ["--check"]);
    console.log("\n── Secrets ──────────────────────────────────────────");
    const secrets = node("scripts/check-secrets.js");
    const ok = config === 0 && secrets === 0;
    console.log(ok ? "\nCHECK OK" : "\nCHECK FAILED: fix the problems above.");
    return ok ? 0 : 1;
  },
  setup(what) {
    if (what === "calendars") return node("tools/calendar-setup/setup.js");
    if (what === "strava") return tsx("scripts/setup-strava.ts");
    console.error(`Usage: family-hub setup calendars|strava`);
    return 1;
  },
  init(dir) {
    if (!dir) { console.error("Usage: family-hub init <dir>"); return 1; }
    return init(resolve(dir));
  },
};

/**
 * A new hub repo: the Worker template, the example workspace, and Claude Code
 * instructions and commands, pinned to this version of cc-family-hub.
 */
function init(dest) {
  if (existsSync(dest) && readdirSync(dest).length) {
    console.error(`✗ ${dest} already exists and isn't empty. Pick a new folder.`);
    return 1;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(join(PKG, "app", "template"), dest, { recursive: true });
  renameSync(join(dest, "gitignore"), join(dest, ".gitignore"));
  cpSync(join(PKG, "workspace.example"), join(dest, "workspace"), {
    recursive: true,
    // Secrets never go in the repo; secrets.example.yaml is a reference only.
    filter: src => !src.includes(join("workspace.example", "state")),
  });
  const name = basename(dest).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const pkgPath = join(dest, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = name;
  pkg.dependencies["cc-family-hub"] = `github:mrwalker/cc-family-hub#v${VERSION}`;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  const wranglerPath = join(dest, "wrangler.jsonc");
  writeFileSync(wranglerPath, readFileSync(wranglerPath, "utf8").replace('"name": "my-family-hub"', `"name": "${name}"`));
  console.log(`Created ${dest} (cc-family-hub v${VERSION}).

Next:
  cd ${dest}
  npm install
  npx family-hub check

Then follow docs/getting-started.md:
https://github.com/mrwalker/cc-family-hub/blob/main/docs/getting-started.md`);
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`family-hub ${VERSION}\n\n${USAGE}`);
  process.exit(cmd ? 0 : 1);
}
if (cmd === "--version" || cmd === "-v") { console.log(VERSION); process.exit(0); }
if (!COMMANDS[cmd]) {
  console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
  process.exit(1);
}
process.exit(COMMANDS[cmd](...rest));
