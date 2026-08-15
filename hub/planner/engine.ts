/**
 * Planning engine — calls Claude to generate and enrich the weekly plan.
 *
 * Uses the Anthropic SDK with prompt caching on the context block,
 * since context changes infrequently within a single planning session.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import type { PlanningContext, WeeklyPlan } from "../../integrations/_base/types.js";
import { renderContextForPrompt } from "../context/builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadApiKey(): string {
  // Prefer environment variable (standard for CI / automated runs)
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // Fall back to workspace/state/secrets.yaml
  const secretsPath = join(process.cwd(), "workspace", "state", "secrets.yaml");
  if (existsSync(secretsPath)) {
    const secrets = yaml.load(readFileSync(secretsPath, "utf8")) as Record<string, unknown>;
    const key = (secrets?.anthropic as Record<string, string>)?.apiKey;
    if (key) return key;
  }

  throw new Error(
    `Anthropic API key not found.\n` +
    `Add it to workspace/state/secrets.yaml:\n\n` +
    `  anthropic:\n    apiKey: "sk-ant-..."\n\n` +
    `Or set the ANTHROPIC_API_KEY environment variable.`
  );
}

const client = new Anthropic({ apiKey: loadApiKey() });

function loadPrompt(name: string): string {
  return readFileSync(join(__dirname, "prompts", `${name}.md`), "utf8");
}

/**
 * Render the full daily-plan prompt (template + context) without calling
 * the API. Used both by the API path and by the assistant-render command.
 */
export function renderDailyPlanPrompt(ctx: PlanningContext): string {
  const contextMarkdown = renderContextForPrompt(ctx);
  const promptTemplate = loadPrompt("daily-plan");
  return promptTemplate.replace("{{CONTEXT}}", contextMarkdown);
}

/**
 * Generate a full weekly plan from the given context.
 * The context block is marked for caching — subsequent calls within the
 * same session reuse the cached context, saving tokens.
 */
export async function generateWeeklyPlan(ctx: PlanningContext): Promise<WeeklyPlan> {
  const systemPrompt = renderDailyPlanPrompt(ctx);

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 8192,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: "Generate the weekly plan as a JSON object.",
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  // Extract JSON from the response (it may be wrapped in a code block)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const raw = JSON.parse(jsonMatch[1].trim());

  return normalizePlan(raw, ctx);
}

/**
 * Generate a human-readable weekly summary from an existing plan.
 */
export async function generateWeeklySummary(
  plan: WeeklyPlan,
  ctx: PlanningContext
): Promise<string> {
  const contextMarkdown = renderContextForPrompt(ctx);
  const planYaml = JSON.stringify(plan, null, 2);
  const promptTemplate = loadPrompt("weekly-summary");
  const prompt = promptTemplate
    .replace("{{PLAN}}", planYaml)
    .replace("{{CONTEXT}}", contextMarkdown);

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: "You are a helpful family assistant.",
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
}

export function normalizePlan(raw: Record<string, unknown>, ctx: PlanningContext): WeeklyPlan {
  return {
    generatedAt: new Date().toISOString(),
    weekStarting: raw.weekStarting as string,
    summary: raw.summary as string,
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
