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

const WORKSPACE = join(process.cwd(), "workspace");

export function loadFamilyConfig(): FamilyConfig {
  const path = join(WORKSPACE, "family.yaml");
  if (!existsSync(path)) {
    throw new Error(
      `workspace/family.yaml not found. Run 'npm run setup' to create your workspace.`
    );
  }
  const raw = yaml.load(readFileSync(path, "utf8"));
  const result = FamilyConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid family.yaml:\n${result.error.toString()}`);
  }
  return result.data as FamilyConfig;
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
        const raw = yaml.load(readFileSync(join(full, filename), "utf8")) as ContextItem;
        if (since && new Date(raw.createdAt) < since) return;
        if (options?.unconsumedOnly && raw.consumed) return;
        items.push(raw);
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
