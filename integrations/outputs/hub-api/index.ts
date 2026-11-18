/**
 * Hub API — Output Integration
 *
 * Publishes the plan, family data (trips, escape rooms, movies), and Strava
 * activities to the hub Worker's data API:
 *
 *   PUT <url>/api/data/plan     PUT <url>/api/data/family     PUT <url>/api/data/strava
 *
 * The Worker validates each payload before storing it, so a malformed plan is
 * rejected with "<path>: <problem>" errors instead of breaking the display.
 * Publishing is a data write, not a git commit or a deploy.
 *
 * Required config (workspace/state/secrets.yaml):
 *   hub-api:
 *     url: "https://hub.example.com"
 *     publishToken: "..."          # matches the Worker's PUBLISH_TOKEN secret
 *
 * Optional, if the hub is behind Cloudflare Access (service token):
 *     accessClientId: "....access"
 *     accessClientSecret: "..."
 */

import { BaseIntegration } from "../../_base/BaseIntegration.js";
import type { OutputIntegration, WeeklyPlan } from "../../_base/types.js";
import { buildFamilyData, loadStravaData } from "../../../hub/published-data.js";

interface HubApiSecrets {
  url: string;
  publishToken: string;
  accessClientId?: string;
  accessClientSecret?: string;
}

export default class HubApiOutput extends BaseIntegration implements OutputIntegration {
  readonly id = "hub-api";
  readonly displayName = "Hub data API";

  async healthCheck(): Promise<void> {
    const secrets = this.loadSecrets<HubApiSecrets>();
    this.requireSecretKeys(secrets as unknown as Record<string, unknown>, ["url", "publishToken"]);
    try {
      new URL(secrets.url);
    } catch {
      throw new Error(`hub-api.url is not a valid URL: ${secrets.url}`);
    }
    if (Boolean(secrets.accessClientId) !== Boolean(secrets.accessClientSecret)) {
      throw new Error("hub-api: set both accessClientId and accessClientSecret, or neither");
    }
  }

  async publishPlan(plan: WeeklyPlan): Promise<void> {
    const secrets = this.loadSecrets<HubApiSecrets>();
    await this.put(secrets, "plan", plan);
    await this.put(secrets, "family", buildFamilyData());
    const strava = loadStravaData();
    if (strava) await this.put(secrets, "strava", strava);
  }

  private async put(secrets: HubApiSecrets, kind: string, data: unknown): Promise<void> {
    const endpoint = new URL(`/api/data/${kind}`, secrets.url).toString();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secrets.publishToken}`,
    };
    if (secrets.accessClientId && secrets.accessClientSecret) {
      headers["CF-Access-Client-Id"] = secrets.accessClientId;
      headers["CF-Access-Client-Secret"] = secrets.accessClientSecret;
    }

    let res: Response;
    try {
      // redirect: "manual" so an auth wall (e.g. an Access login redirect) is an error, not a 200 login page.
      res = await fetch(endpoint, { method: "PUT", headers, body: JSON.stringify(data), redirect: "manual" });
    } catch (err) {
      throw new Error(`could not reach ${endpoint}: ${(err as Error).message}`);
    }

    const text = await res.text();
    let body: { ok?: boolean; error?: string; errors?: string[]; bytes?: number } = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON: handled below */
    }

    if (res.status >= 300 && res.status < 400) {
      throw new Error(
        `${kind} was redirected (${res.status} → ${res.headers.get("location") ?? "?"}). ` +
          `The hub is probably behind an auth wall; check accessClientId/accessClientSecret.`
      );
    }
    if (res.status === 403 && /Cloudflare Access/i.test(text)) {
      throw new Error(
        `${kind} was blocked by Cloudflare Access (403). The service token was not accepted: check that ` +
          `accessClientId/accessClientSecret are copied exactly and that the Access application has a ` +
          `policy with action "Service Auth" that includes this token.`
      );
    }
    if (!res.ok || !body.ok) {
      const details = body.errors?.length ? "\n" + body.errors.map((e) => `    - ${e}`).join("\n") : "";
      throw new Error(`${kind} rejected (${res.status}): ${body.error ?? text.slice(0, 200)}${details}`);
    }
    console.log(`  hub-api: published ${kind} (${body.bytes} bytes)`);
  }
}
