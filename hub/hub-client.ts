/**
 * Calls the hub Worker's token-protected APIs from the family's machine, with the
 * hub-api secrets (secrets.yaml):
 *
 *   hub-api:
 *     url: "https://hub.example.com"
 *     publishToken: "..."        # = the Worker's PUBLISH_TOKEN (the pipeline)
 *     agentToken: "..."          # = the Worker's AGENT_TOKEN (the assistant; hub/agent.ts)
 *     accessClientId: "..."      # the Cloudflare Access service token, if the hub is behind Access
 *     accessClientSecret: "..."
 *
 * A HubError says whether trying again later could help (`retry`): the hub couldn't be
 * reached or didn't accept the token, as opposed to refusing what was asked.
 */

import { readFileSync, existsSync } from "fs";
import yaml from "js-yaml";
import { SECRETS_PATH } from "./paths.js";

export interface HubSecrets {
  url?: string;
  publishToken?: string;
  agentToken?: string;
  accessClientId?: string;
  accessClientSecret?: string;
}

export class HubError extends Error {
  constructor(message: string, readonly status: number, readonly retry: boolean) {
    super(message);
  }
}

const TIMEOUT_MS = 30_000;

export function hubSecrets(): HubSecrets | null {
  if (!existsSync(SECRETS_PATH)) return null;
  const all = (yaml.load(readFileSync(SECRETS_PATH, "utf8")) ?? {}) as Record<string, unknown>;
  const s = all["hub-api"] as HubSecrets | undefined;
  return s?.url ? s : null;
}

export async function hubFetch<T = unknown>(
  path: string,
  { token, method = "GET", body }: { token: "agent" | "publish"; method?: string; body?: unknown },
): Promise<T> {
  const secrets = hubSecrets();
  const key = token === "agent" ? "agentToken" : "publishToken";
  if (!secrets?.[key]) {
    throw new HubError(`No hub-api.url and hub-api.${key} in ${SECRETS_PATH}. See docs/assistant.md`, 0, true);
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${secrets[key]}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (secrets.accessClientId && secrets.accessClientSecret) {
    headers["CF-Access-Client-Id"] = secrets.accessClientId;
    headers["CF-Access-Client-Secret"] = secrets.accessClientSecret;
  }
  let res: Response;
  try {
    // redirect: "manual" so an Access login page is an error, not data.
    res = await fetch(new URL(path, secrets.url), {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new HubError(`Couldn't reach the hub (${(err as Error).message}). Try again in a few minutes`, 0, true);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new HubError(`The hub sent a sign-in page (${res.status}); check the hub-api Access service token`, res.status, true);
  }
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new HubError("The hub has no assistant API; it needs cc-family-hub v2.12 or newer", res.status, true);
  }
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    // 401 and 503 are the hub's setup (a token, a secret, family.yaml); the rest is what was asked.
    throw new HubError(data.error ?? `The hub answered ${res.status}`, res.status, res.status === 401 || res.status >= 500);
  }
  return data;
}
