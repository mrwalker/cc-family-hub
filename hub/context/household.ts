/**
 * Household records for the planner: the pets' care (and, later, chores and the
 * house), read from the hub Worker's GET /api/household/export.
 *
 * Uses the hub-api secrets the pipeline already publishes with (url, publishToken,
 * and the Access service token if there is one). A hub without household records,
 * or without hub-api, gives null, and the plan is made without it. So does any
 * failure: the reason is printed, and planning goes on.
 */

import { readFileSync, existsSync } from "fs";
import yaml from "js-yaml";
import { SECRETS_PATH } from "../paths.js";
import type { HouseholdContext } from "../../integrations/_base/types.js";

interface HubApiSecrets {
  url?: string;
  publishToken?: string;
  accessClientId?: string;
  accessClientSecret?: string;
}

const TIMEOUT_MS = 15_000;

function hubApiSecrets(): HubApiSecrets | null {
  if (!existsSync(SECRETS_PATH)) return null;
  const all = (yaml.load(readFileSync(SECRETS_PATH, "utf8")) ?? {}) as Record<string, unknown>;
  const s = all["hub-api"] as HubApiSecrets | undefined;
  return s?.url && s?.publishToken ? s : null;
}

export async function loadHousehold(daysAhead = 14, log: (line: string) => void = console.log): Promise<HouseholdContext | null> {
  let secrets: HubApiSecrets | null;
  try {
    secrets = hubApiSecrets();
  } catch (err) {
    log(`  household: skipped (couldn't read ${SECRETS_PATH}: ${(err as Error).message.split("\n")[0]})`);
    return null;
  }
  if (!secrets) return null;   // no hub to ask

  const endpoint = new URL(`/api/household/export?days=${Math.min(60, Math.max(1, daysAhead))}`, secrets.url).toString();
  const headers: Record<string, string> = { Authorization: `Bearer ${secrets.publishToken}` };
  if (secrets.accessClientId && secrets.accessClientSecret) {
    headers["CF-Access-Client-Id"] = secrets.accessClientId;
    headers["CF-Access-Client-Secret"] = secrets.accessClientSecret;
  }
  try {
    // redirect: "manual" so an Access login page is an error, not data.
    const res = await fetch(endpoint, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) throw new Error(`redirected (${res.status}); check the hub-api service token`);
    // A hub from before v2.1 has no export; it answers with the page, or 404.
    if (res.status === 404 || !(res.headers.get("content-type") ?? "").includes("json")) {
      log(`  household: skipped (the hub has no household export; it needs cc-family-hub v2.1 or newer)`);
      return null;
    }
    const body = (await res.json()) as HouseholdContext & { enabled: boolean; error?: string };
    if (!res.ok) throw new Error(`${res.status}: ${body.error ?? "no reason given"}`);
    if (!body.enabled) return null;
    log(`  household: ${body.pets.length} pets, ${body.tasks.length} tasks due within ${body.days} days, ${body.recent.length} done lately`);
    return body;
  } catch (err) {
    log(`  household: skipped (${endpoint}: ${(err as Error).message})`);
    return null;
  }
}

/** The household section of the planner's context, or nothing when there's nothing to say. */
export function renderHousehold(h: HouseholdContext | undefined | null): string[] {
  if (!h || (!h.tasks.length && !h.pets.length)) return [];
  const lines: string[] = [`## Household`];
  if (h.pets.length) {
    lines.push(`Pets: ${h.pets.map((p) => [p.name, p.species ? `(${p.species.toLowerCase()})` : ""].filter(Boolean).join(" ")).join(", ")}`);
  }
  lines.push(``);
  lines.push(`### Due in the next ${h.days} days (as of ${h.today})`);
  if (!h.tasks.length) lines.push(`Nothing due.`);
  for (const t of h.tasks) {
    const when = t.overdue ? `OVERDUE since ${t.dueDate} (${-t.daysUntil} days)` : t.daysUntil === 0 ? `due today` : `due ${t.dueDate} (in ${t.daysUntil} days)`;
    const parts = [
      `${t.title}${t.pet ? ` for ${t.pet}` : ""}`,
      `${when}${t.dueTime ? ` at ${t.dueTime}` : ""}`,
      t.kind,
      t.repeats,
      t.assignee ? `assigned to ${t.assignee}` : null,
      t.provider ? `with ${t.provider}${t.phone ? ` (${t.phone})` : ""}` : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(" — ")}`);
    if (t.notes) lines.push(`  ${t.notes}`);
  }
  if (h.recent.length) {
    lines.push(``);
    lines.push(`### Done in the last 30 days`);
    for (const r of h.recent) {
      lines.push(`- ${r.title}${r.pet ? ` for ${r.pet}` : ""}, ${r.doneOn}${r.doneBy ? ` by ${r.doneBy}` : ""}${r.note ? `: ${r.note}` : ""}`);
    }
  }
  lines.push(``);
  lines.push(`The family keeps these at the hub's /household/ page. Marking one done there moves it on.`);
  lines.push(``);
  return lines;
}
