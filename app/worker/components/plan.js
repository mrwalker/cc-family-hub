/**
 * plan: Claude's read on the week, from the last published plan.
 *
 *   data: { weekStarting, summary, generatedAt, flags: [{ severity, message }],
 *           actionItems: [{ description, assignedTo?, dueDate?, priority, status }] }
 */

import { clip, firstSentence, dateLabel } from "../util.js";

export const id = "plan";
const SEVERITY = { urgent: 0, warning: 1, info: 2 };

export async function cards(ctx) {
  const plan = await ctx.data("plan");
  if (!plan?.summary) return [];
  const mine = ids => !ctx.view || !ids?.length || ids.includes(ctx.view.id);
  const flags = (plan.flags ?? [])
    .filter(f => mine(f.relatedMemberIds))
    .sort((a, b) => (SEVERITY[a.severity] ?? 3) - (SEVERITY[b.severity] ?? 3))
    .map(f => ({ severity: f.severity, message: f.message }));
  const actionItems = (plan.actionItems ?? [])
    .filter(a => a.status !== "done")
    .filter(a => !ctx.view || !a.assignedTo || a.assignedTo === ctx.view.id)
    .map(({ description, assignedTo, dueDate, priority, status }) =>
      ({ description, ...(assignedTo ? { assignedTo } : {}), ...(dueDate ? { dueDate } : {}), priority, status: status ?? "pending" }));

  const top = flags.find(f => f.severity !== "info");
  const todo = actionItems.length;
  return [{
    id: "plan",
    title: "This week's plan",
    url: `${ctx.hubUrl}#plan`,
    glance: top
      ? { headline: clip(top.message, 70), detail: todo ? `${todo} to do this week` : clip(firstSentence(plan.summary), 90),
          emoji: top.severity === "urgent" ? "🚨" : "⚠️" }
      : { headline: todo ? `${todo} to do this week` : `Week of ${dateLabel(plan.weekStarting, ctx.locale, { month: "short", day: "numeric" })}`,
          detail: clip(firstSentence(plan.summary), 90), emoji: "📋" },
    data: {
      weekStarting: plan.weekStarting,
      summary: plan.summary,
      generatedAt: plan.generatedAt ?? null,
      flags,
      actionItems,
    },
  }];
}
