/**
 * Workspace loader — reads family.yaml, member profiles, context items,
 * cached calendars, and state from the workspace/ directory.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { FamilyConfigSchema, MemberProfileSchema } from "../../integrations/_base/schemas.js";
import type {
  FamilyConfig,
  MemberProfile,
  ContextItem,
  CalendarEvent,
  WeeklyPlan,
} from "../../integrations/_base/types.js";
import { WORKSPACE, SECRETS_PATH } from "../paths.js";


export function loadFamilyConfig(): FamilyConfig {
  const path = join(WORKSPACE, "family.yaml");
  if (!existsSync(path)) {
    throw new Error(
      `workspace/family.yaml not found. Create a hub repo with 'npx github:mrwalker/cc-family-hub init <dir>', or set HUB_WORKSPACE.`
    );
  }
  const raw = yaml.load(readFileSync(path, "utf8"));
  const result = FamilyConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid family.yaml:\n${result.error.toString()}`);
  }
  const config = result.data as Omit<FamilyConfig, "pipeline">;
  return { ...config, pipeline: pipelineIntegrations(config) } as FamilyConfig;
}

/**
 * Which inputs and outputs the pipeline loads. `inputs:` and `outputs:` name
 * each one once; the older `integrations.active` loads every id as both an
 * input and an output, as it always has. The hub-api output is on whenever
 * secrets.yaml has a hub-api entry.
 */
export function pipelineIntegrations(config: Omit<FamilyConfig, "pipeline">): { inputs: string[]; outputs: string[] } {
  const legacy = config.integrations?.active ?? [];
  const inputs = new Set([...legacy, ...Object.keys(config.inputs ?? {})]);
  const outputs = new Set([...legacy, ...Object.keys(config.outputs ?? {})]);
  if (hasSecretsFor("hub-api")) outputs.add("hub-api");
  return { inputs: [...inputs], outputs: [...outputs] };
}

function hasSecretsFor(id: string): boolean {
  if (!existsSync(SECRETS_PATH)) return false;
  try {
    const all = yaml.load(readFileSync(SECRETS_PATH, "utf8")) as Record<string, unknown> | null;
    return !!all && typeof all[id] === "object" && all[id] !== null;
  } catch {
    return false;
  }
}

export function loadMemberProfiles(): MemberProfile[] {
  const dir = join(WORKSPACE, "members");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
    .map((filename) => {
      const path = join(dir, filename);
      const raw = yaml.load(readFileSync(path, "utf8"));
      const result = MemberProfileSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(`Invalid member profile ${filename}:\n${result.error.toString()}`);
      }
      return result.data as MemberProfile;
    });
}

export function loadContextItems(options?: {
  since?: string;
  unconsumedOnly?: boolean;
}): ContextItem[] {
  const dir = join(WORKSPACE, "context");
  if (!existsSync(dir)) return [];

  const items: ContextItem[] = [];
  const since = options?.since ? new Date(options.since) : null;

  // Walk context subdirectories: notes/, links/, todos/, shopping/, etc.
  const scan = (subdir: string) => {
    const full = join(dir, subdir);
    if (!existsSync(full)) return;
    readdirSync(full)
      .filter((f) => f.endsWith(".yaml"))
      .forEach((filename) => {
        const raw = yaml.load(readFileSync(join(full, filename), "utf8"));
        // Files may contain a single item or an array of items
        const parsed: ContextItem[] = Array.isArray(raw) ? raw : [raw as ContextItem];
        for (const item of parsed) {
          if (!item?.createdAt) continue;
          if (since && new Date(item.createdAt) < since) continue;
          if (options?.unconsumedOnly && item.consumed) continue;
          items.push(item);
        }
      });
  };

  ["notes", "links", "todos", "shopping", "free-form"].forEach(scan);
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function loadCachedEvents(daysAhead = 14): CalendarEvent[] {
  const dir = join(WORKSPACE, "calendars");
  if (!existsSync(dir)) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);

  const events: CalendarEvent[] = [];
  readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .forEach((filename) => {
      const raw = yaml.load(
        readFileSync(join(dir, filename), "utf8")
      ) as CalendarEvent[];
      if (Array.isArray(raw)) {
        raw.forEach((e) => {
          if (new Date(e.startAt) <= cutoff) events.push(e);
        });
      }
    });

  return events.sort((a, b) => a.startAt.localeCompare(b.startAt));
}

export function loadLastPlan(): WeeklyPlan | null {
  const path = join(WORKSPACE, "state", "last-plan.yaml");
  if (!existsSync(path)) return null;
  return yaml.load(readFileSync(path, "utf8")) as WeeklyPlan;
}
