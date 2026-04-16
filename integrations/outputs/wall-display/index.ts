/**
 * Wall Display — Output Integration
 *
 * Pushes plan updates to a wall-mounted Android tablet running the
 * Family Hub Display app. Communicates over local network via HTTP.
 *
 * Required secrets (workspace/state/secrets.yaml):
 *   wall-display:
 *     deviceUrl: "http://192.168.1.xxx:8080"   # Local IP of the tablet
 *     apiKey: "..."                              # Set in the display app settings
 */

import { BaseIntegration } from "../../_base/BaseIntegration.js";
import type { OutputIntegration, WeeklyPlan, ShoppingItem, CalendarEvent } from "../../_base/types.js";

interface WallDisplaySecrets {
  deviceUrl: string;
  apiKey: string;
}

export default class WallDisplayOutput extends BaseIntegration implements OutputIntegration {
  readonly id = "wall-display";
  readonly displayName = "Wall Display (Android)";

  async healthCheck(): Promise<void> {
    const secrets = this.loadSecrets<WallDisplaySecrets>();
    this.requireSecretKeys(secrets, ["deviceUrl", "apiKey"]);
    const response = await this.post(secrets, "/health", {});
    if (!response.ok) throw new Error(`Wall display unreachable at ${secrets.deviceUrl}`);
  }

  async publishPlan(plan: WeeklyPlan): Promise<void> {
    const secrets = this.loadSecrets<WallDisplaySecrets>();
    await this.post(secrets, "/update/plan", plan);
  }

  async publishShoppingList(items: ShoppingItem[]): Promise<void> {
    const secrets = this.loadSecrets<WallDisplaySecrets>();
    await this.post(secrets, "/update/shopping", items);
  }

  async publishEvents(events: CalendarEvent[]): Promise<void> {
    const secrets = this.loadSecrets<WallDisplaySecrets>();
    await this.post(secrets, "/update/events", events);
  }

  async sendNotification(memberId: string, message: string, urgency = "normal"): Promise<void> {
    const secrets = this.loadSecrets<WallDisplaySecrets>();
    await this.post(secrets, "/notify", { memberId, message, urgency });
  }

  private async post(
    secrets: WallDisplaySecrets,
    path: string,
    body: unknown
  ): Promise<Response> {
    return fetch(`${secrets.deviceUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": secrets.apiKey,
      },
      body: JSON.stringify(body),
    });
  }
}
