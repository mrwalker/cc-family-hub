/**
 * Hub entry point — invoked by npm scripts and Claude Code commands.
 *
 * Usage:
 *   tsx hub/index.ts plan        Run a full planning pass (requires Anthropic API key)
 *   tsx hub/index.ts render      Render the daily-plan prompt to workspace/state/pending-prompt.md
 *   tsx hub/index.ts publish     Validate + publish an assistant-written plan from last-plan.yaml
 *   tsx hub/index.ts sync        Sync calendars from all input integrations
 *   tsx hub/index.ts summary     Generate and print a weekly summary
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { buildPlanningContext } from "./context/builder.js";
import { renderDailyPlanPrompt, generateWeeklyPlan, generateWeeklySummary } from "./planner/engine.js";
import { loadRegisteredIntegrations } from "./integrations/registry.js";
import { WeeklyPlanSchema } from "../integrations/_base/schemas.js";
import type { WeeklyPlan, FamilyConfig } from "../integrations/_base/types.js";
import { WORKSPACE, STATE_DIR } from "./paths.js";

const PLAN_PATH = join(STATE_DIR, "last-plan.yaml");
const PROMPT_PATH = join(STATE_DIR, "pending-prompt.md");

async function runPlan() {
  console.log("Building planning context...");
  const ctx = buildPlanningContext({ daysAhead: 14 });

  console.log(`Context assembled: ${ctx.members.length} members, ${ctx.events.length} events, ${ctx.contextItems.length} context items`);
  console.log("Generating weekly plan...");

  const plan = await generateWeeklyPlan(ctx);

  // Persist the plan
  writePlan(plan);

  const ok = await publishPlanToOutputs(plan, ctx.family);
  printPlanSummary(plan);
  if (!ok) process.exitCode = 1;
}

async function runRender() {
  console.log("Building planning context...");
  const ctx = buildPlanningContext({ daysAhead: 14 });

  console.log(`Context assembled: ${ctx.members.length} members, ${ctx.events.length} events, ${ctx.contextItems.length} context items`);
  console.log("Rendering daily-plan prompt...");

  const prompt = renderDailyPlanPrompt(ctx);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PROMPT_PATH, prompt, "utf8");
  console.log(`Prompt written to ${PROMPT_PATH}`);
  console.log(`\nNext step: have the assistant read that file, generate the weekly plan JSON\n` +
    `matching the output format in the prompt, and save it to ${PLAN_PATH}\n` +
    `Then run: npm run publish`);
}

async function runPublish() {
  if (!existsSync(PLAN_PATH)) {
    fail(
      `${PLAN_PATH} not found.`,
      `Run 'npm run render', write the plan to that path, then run 'npm run publish' again.`
    );
  }

  console.log(`Loading plan from ${PLAN_PATH}...`);
  let raw: Record<string, unknown>;
  try {
    raw = yaml.load(readFileSync(PLAN_PATH, "utf8")) as Record<string, unknown>;
  } catch (err) {
    fail(
      `The plan file is not valid YAML/JSON:\n    ${(err as Error).message.split("\n")[0]}`,
      `Rewrite the whole file ${PLAN_PATH} with valid JSON, then run 'npm run publish' again.`
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`The plan file must contain one JSON object.`, `Rewrite ${PLAN_PATH}, then run 'npm run publish' again.`);
  }

  // Normalize and validate the assistant-written plan
  const plan = normalizeAssistantPlan(raw);
  const result = WeeklyPlanSchema.safeParse(plan);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `    - ${formatPath(i.path)}: ${i.message}`);
    fail(
      `The plan failed validation (${problems.length} problem(s)):\n${problems.join("\n")}`,
      `Fix exactly these fields in ${PLAN_PATH}, then run 'npm run publish' again.`
    );
  }

  writePlan(plan);
  console.log("Plan validated.");

  printPlanSummary(plan);
  const ctx = buildPlanningContext();
  const ok = await publishPlanToOutputs(plan, ctx.family);
  if (!ok) process.exitCode = 1;
}

/** zod issue path → "plan.days[2].date" */
function formatPath(path: (string | number)[]): string {
  return path.reduce<string>((acc, p) => (typeof p === "number" ? `${acc}[${p}]` : `${acc}.${p}`), "plan");
}

/** Print an actionable error and exit non-zero. */
function fail(problem: string, nextStep: string): never {
  console.error(`\n✗ ${problem}\n\nNext step: ${nextStep}`);
  process.exit(1);
}

/**
 * Publish to every loaded output, continuing past failures, then print one
 * result line per output. Returns false if any active output failed.
 */
async function publishPlanToOutputs(plan: WeeklyPlan, family: FamilyConfig): Promise<boolean> {
  const registry = await loadRegisteredIntegrations(family);
  const results: Array<{ id: string; error?: string }> = registry.failures
    .filter((f) => f.kind !== "input")
    .map((f) => ({ id: f.id, error: `failed to load: ${f.error}` }));

  for (const [id, integration] of registry.outputs) {
    try {
      if (integration.publishPlan) {
        console.log(`  Publishing to ${id}...`);
        await integration.publishPlan(plan);
      }
      if (integration.publishShoppingList && plan.shoppingList.length > 0) {
        await integration.publishShoppingList(plan.shoppingList);
      }
      results.push({ id });
    } catch (err) {
      results.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log("\n── Publish results ─────────────────────────────────");
  for (const r of results) console.log(r.error ? `  ✗ ${r.id}: ${r.error}` : `  ✓ ${r.id}`);
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.log(`\nPUBLISH FAILED for: ${failed.map((r) => r.id).join(", ")}. Report the errors above; do not retry by editing code.`);
  } else {
    console.log(`\nPUBLISH OK (${results.length} output(s)).`);
  }
  return failed.length === 0;
}

function writePlan(plan: WeeklyPlan): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PLAN_PATH, yaml.dump(plan), "utf8");
  console.log(`Plan saved to ${PLAN_PATH}`);
}

function normalizeAssistantPlan(raw: Record<string, unknown>): WeeklyPlan {
  return {
    generatedAt: (raw.generatedAt as string) ?? new Date().toISOString(),
    weekStarting: raw.weekStarting as string,
    summary: (raw.summary as string) ?? "",
    days: (raw.days as WeeklyPlan["days"]) ?? [],
    enrichedEvents: (raw.enrichedEvents as WeeklyPlan["enrichedEvents"]) ?? [],
    shoppingList: (raw.shoppingList as WeeklyPlan["shoppingList"]) ?? [],
    actionItems: ((raw.actionItems as WeeklyPlan["actionItems"]) ?? []).map((a, i) => ({
      ...a,
      id: `action-${Date.now()}-${i}`,
      status: "pending" as const,
    })),
    flags: (raw.flags as WeeklyPlan["flags"]) ?? [],
  };
}

async function runSync() {
  console.log("Syncing calendars...");
  const ctx = buildPlanningContext();
  const registry = await loadRegisteredIntegrations(ctx.family);

  const end = new Date();
  end.setDate(end.getDate() + 90);
  const startDate = new Date().toISOString();
  const endDate = end.toISOString();

  mkdirSync(join(WORKSPACE, "calendars"), { recursive: true });

  for (const f of registry.failures.filter((f) => f.kind !== "output")) {
    console.error(`  ✗ ${f.id}: ${f.error}`);
    process.exitCode = 1;
  }

  for (const [id, integration] of registry.inputs) {
   try {
    if (integration.fetchEvents) {
      console.log(`  Syncing ${id}...`);
      const events = await integration.fetchEvents(startDate, endDate);
      const outPath = join(WORKSPACE, "calendars", `${id}.yaml`);
      writeFileSync(outPath, yaml.dump(events), "utf8");
      console.log(`  ${events.length} events saved from ${id}`);
    }

    // Activity-based integrations (e.g. Strava) expose fetchActivities instead of fetchEvents
    const asAny = integration as unknown as Record<string, unknown>;
    if (typeof asAny.fetchActivities === "function") {
      console.log(`  Syncing activities from ${id}...`);
      const activities = await (asAny.fetchActivities as () => Promise<Record<string, unknown[]>>)();
      const outPath = join(STATE_DIR, `${id}-activities.yaml`);
      const memberCount = Object.keys(activities).length;
      const total = Object.values(activities).reduce((n, a) => n + a.length, 0);
      writeFileSync(outPath, yaml.dump({ generatedAt: new Date().toISOString(), members: activities }), "utf8");
      console.log(`  ${total} activities saved for ${memberCount} member(s) from ${id}`);
    }
   } catch (err) {
    console.error(`  ✗ ${id} sync failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
   }
  }

  console.log(process.exitCode ? "Sync finished with errors (see ✗ lines above)." : "Sync complete.");
}

async function runSummary() {
  const ctx = buildPlanningContext({ daysAhead: 7 });
  const plan = (await import("js-yaml")).default.load(
    (await import("fs")).readFileSync(join(STATE_DIR, "last-plan.yaml"), "utf8")
  ) as WeeklyPlan;

  const summary = await generateWeeklySummary(plan, ctx);
  console.log("\n" + summary);
}

function printPlanSummary(plan: WeeklyPlan) {
  console.log("\n── Weekly Plan Summary ─────────────────────────────");
  console.log(plan.summary);
  if (plan.flags.length > 0) {
    console.log("\n── Flags ───────────────────────────────────────────");
    for (const flag of plan.flags) {
      const icon = flag.severity === "urgent" ? "🚨" : flag.severity === "warning" ? "⚠️" : "ℹ️";
      console.log(`${icon}  ${flag.message}`);
    }
  }
  if (plan.actionItems.length > 0) {
    console.log("\n── Action Items ────────────────────────────────────");
    for (const a of plan.actionItems) {
      console.log(`  [${a.priority.toUpperCase()}] ${a.description}`);
    }
  }
  console.log("────────────────────────────────────────────────────\n");
}

// Dispatch
function die(err: unknown): never {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const command = process.argv[2];
if (command === "plan") {
  runPlan().catch(die);
} else if (command === "render") {
  runRender().catch(die);
} else if (command === "publish") {
  runPublish().catch(die);
} else if (command === "sync") {
  runSync().catch(die);
} else if (command === "summary") {
  runSummary().catch(die);
} else {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: tsx hub/index.ts [plan|render|publish|sync|summary]");
  process.exit(1);
}
