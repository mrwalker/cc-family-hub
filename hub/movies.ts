/**
 * The monthly movie picks, between the family's assistant and the hub (app/worker/movies.js).
 *
 *   family-hub movies history          past picks, with who wanted and saw each (JSON on stdout)
 *   family-hub movies publish <file>   hands the hub this month's picks
 *
 * The picks file:
 *   { "batch": "2026-12",
 *     "picks": [{ "title": "…", "kind": "movie" | "show", "releaseDate": "YYYY-MM-DD" | null,
 *                 "where": "theaters" | "<streaming service>", "format": "IMAX" | null,
 *                 "blurb": "why it's fun, one line", "forWhom": "who it's likely for",
 *                 "url": "https://… (its Wikipedia or official page)",
 *                 "imageUrl": "https://… (the poster image itself, if known; else it's found on url)" }] }
 *
 * Uses the hub-api secrets the pipeline publishes with. The last line is MOVIES OK or
 * MOVIES FAILED, and the exit code matches, so an assistant can tell.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { hubApiSecrets } from "./context/household.js";

const TIMEOUT_MS = 120_000;   // the hub looks for a poster for each new pick
const MAX_PICKS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Pick { title?: unknown; kind?: unknown; releaseDate?: unknown; where?: unknown; url?: unknown; imageUrl?: unknown }

/** What's wrong with a picks file, line by line; empty when it's fine. */
export function checkPicks(body: unknown): string[] {
  const problems: string[] = [];
  const b = body as { batch?: unknown; picks?: unknown };
  if (!b || typeof b !== "object") return ["The file must be a JSON object: { batch, picks: [...] }"];
  if (b.batch !== undefined && !(typeof b.batch === "string" && /^\d{4}-\d{2}$/.test(b.batch))) problems.push(`batch: "YYYY-MM"`);
  if (!Array.isArray(b.picks) || !b.picks.length) return [...problems, "picks: a list of at least one"];
  if (b.picks.length > MAX_PICKS) problems.push(`picks: no more than ${MAX_PICKS}`);
  (b.picks as Pick[]).forEach((p, i) => {
    if (!p || typeof p !== "object") { problems.push(`picks[${i}]: an object`); return; }
    if (typeof p.title !== "string" || !p.title.trim()) problems.push(`picks[${i}].title: required`);
    if (p.kind !== undefined && p.kind !== "movie" && p.kind !== "show") problems.push(`picks[${i}].kind: "movie" or "show"`);
    if (p.releaseDate != null && !(typeof p.releaseDate === "string" && DATE_RE.test(p.releaseDate))) problems.push(`picks[${i}].releaseDate: "YYYY-MM-DD" or null`);
    if (p.where != null && typeof p.where !== "string") problems.push(`picks[${i}].where: "theaters" or a streaming service`);
    if (p.url != null && !(typeof p.url === "string" && /^https?:\/\//.test(p.url))) problems.push(`picks[${i}].url: a web link`);
    if (p.imageUrl != null && !(typeof p.imageUrl === "string" && /^https?:\/\//.test(p.imageUrl))) problems.push(`picks[${i}].imageUrl: a web link to the poster`);
  });
  return problems;
}

async function hub(path: string, init: RequestInit = {}): Promise<unknown> {
  const secrets = hubApiSecrets();
  if (!secrets?.url || !secrets.publishToken) throw new Error("No hub-api secrets (url and publishToken). See docs/outputs.md");
  const headers: Record<string, string> = { Authorization: `Bearer ${secrets.publishToken}`, ...(init.headers as Record<string, string> ?? {}) };
  if (secrets.accessClientId && secrets.accessClientSecret) {
    headers["CF-Access-Client-Id"] = secrets.accessClientId;
    headers["CF-Access-Client-Secret"] = secrets.accessClientSecret;
  }
  const res = await fetch(new URL(`/api/household${path}`, secrets.url), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status >= 300 && res.status < 400) throw new Error(`redirected (${res.status}); check the hub-api service token`);
  const type = res.headers.get("content-type") ?? "";
  if (res.status === 404 || !type.includes("json")) throw new Error("The hub has no movies yet; it needs cc-family-hub v2.8 or newer");
  const body = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(`${res.status}: ${body.error ?? "no reason given"}`);
  return body;
}

async function main(): Promise<number> {
  const [what, file] = process.argv.slice(2);
  if (what === "history") {
    console.log(JSON.stringify(await hub("/movies/history"), null, 2));
    return 0;
  }
  if (what === "publish" && file) {
    let body: unknown;
    try {
      body = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
    } catch (err) {
      console.log(`✗ Couldn't read ${file} as JSON: ${(err as Error).message}`);
      console.log("\nMOVIES FAILED");
      return 1;
    }
    const problems = checkPicks(body);
    if (problems.length) {
      for (const p of problems) console.log(`✗ ${p}`);
      console.log("\nMOVIES FAILED");
      return 1;
    }
    const r = (await hub("/movies/picks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })) as
      { added: number; updated: number; archived: number; pictured: number };
    const n = (body as { picks: unknown[] }).picks.length;
    console.log(`${r.added} new, ${r.updated} updated, ${r.archived} retired; ${r.pictured} of ${n} with a poster.`);
    console.log("\nMOVIES OK");
    return 0;
  }
  console.error("Usage: family-hub movies history | family-hub movies publish <picks.json>");
  return 1;
}

main().then(code => process.exit(code), err => {
  console.log(`✗ ${(err as Error).message}`);
  console.log("\nMOVIES FAILED");
  process.exit(1);
});
