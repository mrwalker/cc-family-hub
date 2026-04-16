/**
 * Google Calendar — Output Integration
 *
 * Writes enriched event notes back to Google Calendar as event descriptions,
 * and creates new events for action items with due dates.
 *
 * Uses the same credentials as the input integration.
 * Required secrets: same as integrations/inputs/google-calendar/
 *
 * Setup: see integrations/inputs/google-calendar/README.md
 */

import { BaseIntegration } from "../../_base/BaseIntegration.js";
import type { OutputIntegration, CalendarEvent, WeeklyPlan } from "../../_base/types.js";

interface GoogleCalendarSecrets {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export default class GoogleCalendarOutput extends BaseIntegration implements OutputIntegration {
  readonly id = "google-calendar";
  readonly displayName = "Google Calendar (Output)";

  private accessToken: string | null = null;

  async healthCheck(): Promise<void> {
    const secrets = this.loadSecrets<GoogleCalendarSecrets>();
    this.requireSecretKeys(secrets, ["clientId", "clientSecret", "refreshToken"]);
    await this.refreshAccessToken(secrets);
  }

  async publishEvents(events: CalendarEvent[]): Promise<void> {
    if (!this.accessToken) await this.refreshAccessToken(this.loadSecrets());

    for (const event of events) {
      if (!event.enrichment) continue;

      // Only update events that originated from Google Calendar
      if (!event.id.startsWith("google-calendar:")) continue;
      const googleEventId = event.id.replace("google-calendar:", "");

      const enrichedDescription = this.buildEnrichedDescription(event);
      await this.patchEvent(event.calendarId, googleEventId, {
        description: enrichedDescription,
      });
    }
  }

  async publishPlan(plan: WeeklyPlan): Promise<void> {
    // Create calendar events for high-priority action items that have due dates
    if (!this.accessToken) await this.refreshAccessToken(this.loadSecrets());

    for (const action of plan.actionItems) {
      if (action.priority === "high" && action.dueDate && action.status === "pending") {
        await this.createReminderEvent(action.description, action.dueDate);
      }
    }
  }

  private buildEnrichedDescription(event: CalendarEvent): string {
    if (!event.enrichment) return event.description ?? "";
    const parts: string[] = [];
    if (event.description) parts.push(event.description, "");
    parts.push("── Family Hub Notes ────────────────────────");
    if (event.enrichment.notes) parts.push(event.enrichment.notes);
    if (event.enrichment.drivingInfo) parts.push(`🚗 ${event.enrichment.drivingInfo}`);
    if (event.enrichment.weatherConsiderations)
      parts.push(`🌤 ${event.enrichment.weatherConsiderations}`);
    if (event.enrichment.actionItems?.length) {
      parts.push("Action items:");
      event.enrichment.actionItems.forEach((a) => parts.push(`  • ${a}`));
    }
    parts.push(`Updated by Family Hub: ${new Date().toLocaleString()}`);
    return parts.join("\n");
  }

  private async patchEvent(
    calendarId: string,
    eventId: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(patch),
      }
    );
    if (!response.ok) {
      console.warn(`Failed to patch event ${eventId}: ${response.statusText}`);
    }
  }

  private async createReminderEvent(title: string, date: string): Promise<void> {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: `[Hub] ${title}`,
          start: { date },
          end: { date },
          description: "Created by Family Hub planning routine.",
        }),
      }
    );
    if (!response.ok) {
      console.warn(`Failed to create reminder event: ${response.statusText}`);
    }
  }

  private async refreshAccessToken(secrets: GoogleCalendarSecrets): Promise<void> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: secrets.clientId,
        client_secret: secrets.clientSecret,
        refresh_token: secrets.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) throw new Error(`Failed to refresh token: ${response.statusText}`);
    const data = (await response.json()) as { access_token: string };
    this.accessToken = data.access_token;
  }
}
