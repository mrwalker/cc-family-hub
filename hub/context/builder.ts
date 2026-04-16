/**
 * Assembles a PlanningContext from all loaded workspace data.
 * This is the full context object passed to the planner.
 */

import type { PlanningContext } from "../../integrations/_base/types.js";
import {
  loadFamilyConfig,
  loadMemberProfiles,
  loadContextItems,
  loadCachedEvents,
  loadLastPlan,
} from "./loader.js";

export function buildPlanningContext(options?: {
  daysAhead?: number;
  unconsumedContextOnly?: boolean;
}): PlanningContext {
  const family = loadFamilyConfig();
  const members = loadMemberProfiles();
  const events = loadCachedEvents(options?.daysAhead ?? 14);
  const contextItems = loadContextItems({
    unconsumedOnly: options?.unconsumedContextOnly ?? false,
  });
  const previousPlan = loadLastPlan() ?? undefined;

  return {
    family,
    members,
    events,
    contextItems,
    previousPlan,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Renders the planning context as a structured Markdown string
 * suitable for inclusion in a Claude prompt.
 */
export function renderContextForPrompt(ctx: PlanningContext): string {
  const lines: string[] = [];

  lines.push(`# Family Hub Context`);
  lines.push(`Generated: ${ctx.generatedAt}`);
  lines.push(``);

  // Family overview
  lines.push(`## Family: ${ctx.family.family.name}`);
  lines.push(`Timezone: ${ctx.family.family.timezone}`);
  lines.push(`Members: ${ctx.members.map((m) => m.name).join(", ")}`);
  lines.push(``);

  // Member profiles
  lines.push(`## Member Profiles`);
  for (const m of ctx.members) {
    lines.push(`### ${m.name} (${m.role})`);
    if (m.age) lines.push(`- Age: ${m.age}`);
    if (m.email) lines.push(`- Email: ${m.email}`);
    if (m.school) lines.push(`- School: ${m.school.name}${m.school.year ? `, ${m.school.year}` : ""}`);
    if (m.work) lines.push(`- Work: ${m.work.employer}${m.work.role ? ` — ${m.work.role}` : ""}`);
    if (m.hobbies?.length) lines.push(`- Hobbies: ${m.hobbies.join(", ")}`);
    if (m.primaryFocuses?.length) lines.push(`- Current focuses: ${m.primaryFocuses.join(", ")}`);
    if (m.upcomingProjects?.length) {
      lines.push(`- Upcoming projects:`);
      for (const p of m.upcomingProjects) {
        lines.push(`  - ${p.title}${p.dueDate ? ` (due ${p.dueDate})` : ""}`);
      }
    }
    lines.push(``);
  }

  // Upcoming events
  lines.push(`## Upcoming Calendar Events`);
  if (ctx.events.length === 0) {
    lines.push(`No events found.`);
  } else {
    for (const e of ctx.events) {
      const member = ctx.members.find((m) => m.id === e.memberId);
      const memberLabel = member ? ` [${member.name}]` : "";
      lines.push(`- **${e.title}**${memberLabel} — ${e.startAt}${e.location ? ` @ ${e.location}` : ""}`);
      if (e.description) lines.push(`  ${e.description}`);
    }
  }
  lines.push(``);

  // Context items
  if (ctx.contextItems.length > 0) {
    lines.push(`## Submitted Context`);
    for (const item of ctx.contextItems) {
      const member = ctx.members.find((m) => m.id === item.memberId);
      const who = member ? ` (from ${member.name})` : "";
      lines.push(`- [${item.type.toUpperCase()}]${who}: ${item.content}`);
      if (item.url) lines.push(`  URL: ${item.url}`);
    }
    lines.push(``);
  }

  // Previous plan summary
  if (ctx.previousPlan) {
    lines.push(`## Previous Plan Summary`);
    lines.push(`Week of ${ctx.previousPlan.weekStarting}: ${ctx.previousPlan.summary}`);
    const pending = ctx.previousPlan.actionItems.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      lines.push(`Pending action items carried forward:`);
      for (const a of pending) {
        lines.push(`- [${a.priority.toUpperCase()}] ${a.description}`);
      }
    }
    lines.push(``);
  }

  return lines.join("\n");
}
