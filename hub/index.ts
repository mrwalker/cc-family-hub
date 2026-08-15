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

const WORKSPACE = join(process.cwd(), "workspace");
const STATE_DIR = join(WORKSPACE, "state");
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

  await publishPlanToOutputs(plan, ctx.family);
  printPlanSummary(plan);
}

async function runRender() {
  console.log("Building planning context...");
  const ctx = buildPlanningContext({ daysAhead: 14 });

  console.log(`Context assembled: ${ctx.members.length} members, ${ctx.events.length} events, ${ctx.contextItems.length} context items`);
  console.log("Rendering daily-plan prompt...");

  const prompt = renderDailyPlanPrompt(ctx);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PROMPT_PATH, prompt, "utf8");
  console.log(`Prompt written to workspace/state/pending-prompt.md`);
  console.log(`\nNext step: have the assistant read that file, generate the weekly plan JSON\n` +
    `matching the output format in the prompt, and save it to workspace/state/last-plan.yaml.\n` +
    `Then run: npm run publish`);
}

async function runPublish() {
  if (!existsSync(PLAN_PATH)) {
    throw new Error(
      `workspace/state/last-plan.yaml not found. Run 'npm run render', have the\n` +
      `assistant write the plan to that path, then re-run 'npm run publish'.`
    );
  }

  console.log("Loading plan from workspace/state/last-plan.yaml...");
  const raw = yaml.load(readFileSync(PLAN_PATH, "utf8")) as Record<string, unknown>;

  // Normalize and validate the assistant-written plan
  const plan = normalizeAssistantPlan(raw);
  const result = WeeklyPlanSchema.safeParse(plan);
  if (!result.success) {
    throw new Error(`Assistant plan failed validation:\n${result.error.toString()}`);
  }

  writePlan(plan);
  console.log("Plan validated.");

  const ctx = buildPlanningContext();
  await publishPlanToOutputs(plan, ctx.family);
  printPlanSummary(plan);
}

async function publishPlanToOutputs(plan: WeeklyPlan, family: FamilyConfig) {
  const registry = await loadRegisteredIntegrations(family);
  let pushed = 0;
  for (const [id, integration] of registry.outputs) {
    if (integration.publishPlan) {
      console.log(`  Publishing to ${id}...`);
      await integration.publishPlan(plan);
      pushed++;
    }
    if (integration.publishShoppingList && plan.shoppingList.length > 0) {
      await integration.publishShoppingList(plan.shoppingList);
    }
  }

  console.log(`Plan published to ${pushed} output integration(s).`);
}

function writePlan(plan: WeeklyPlan): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PLAN_PATH, yaml.dump(plan), "utf8");
  console.log("Plan saved to workspace/state/last-plan.yaml");
}

function normalizeAssistantPlan(raw: Record<string, unknown>): WeeklyPlan {
  return {
    generatedAt: (raw.generatedAt as string) ?? new Date().toISOString(),
    weekStarting: raw.weekStarting as string,
    summary: (raw.summary as string) ?? "",
    days: (raw.days as WeeklyPlan["days"]) ?? [],
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

  for (const [id, integration] of registry.inputs) {
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
  }

  console.log("Sync complete.");
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
const command = process.argv[2];
if (command === "plan") {
  runPlan().catch(console.error);
} else if (command === "render") {
  runRender().catch(console.error);
} else if (command === "publish") {
  runPublish().catch(console.error);
} else if (command === "sync") {
  runSync().catch(console.error);
} else if (command === "summary") {
  runSummary().catch(console.error);
} else {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: tsx hub/index.ts [plan|render|publish|sync|summary]");
  process.exit(1);
}
