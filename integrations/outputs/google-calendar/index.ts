/**
 * Google Calendar — Output Integration
 *
 * Writes enriched event notes back to Google Calendar as event descriptions,
 * and creates calendar events for high-priority action items with due dates.
 *
 * Requires "Make changes to events" sharing permission on each calendar
 * (vs. read-only for the input integration).
 *
 * Setup: run `npm run setup:calendars` for step-by-step instructions.
 */

import { BaseIntegration } from "../../_base/BaseIntegration.js";
import {
  loadServiceAccountKey,
  fetchAccessToken,
  SCOPES,
} from "../../_base/google-auth.js";
import type { OutputIntegration, CalendarEvent, WeeklyPlan } from "../../_base/types.js";

export default class GoogleCalendarOutput extends BaseIntegration implements OutputIntegration {
  readonly id = "google-calendar";
  readonly displayName = "Google Calendar (Output)";

  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  async healthCheck(): Promise<void> {
    const key = loadServiceAccountKey();
    const { token, expiresAt } = await fetchAccessToken(key, SCOPES.calendarWrite);
    this.cachedToken = token;
    this.tokenExpiresAt = expiresAt - 60_000;
  }

  async publishEvents(events: CalendarEvent[]): Promise<void> {
    const token = await this.getToken();
    const enriched = events.filter(
      (e) => e.enrichment && e.id.startsWith("google-calendar:")
    );

    for (const event of enriched) {
      const googleEventId = event.id.replace("google-calendar:", "");
      await this.patchEvent(token, event.calendarId, googleEventId, {
        description: this.buildEnrichedDescription(event),
      });
    }

    if (enriched.length > 0) {
      console.log(`  google-calendar output: updated ${enriched.length} event(s)`);
    }
  }

  async publishPlan(plan: WeeklyPlan): Promise<void> {
    const token = await this.getToken();
    const highPriority = plan.actionItems.filter(
      (a) => a.priority === "high" && a.dueDate && a.status === "pending"
    );

    for (const action of highPriority) {
      await this.createAllDayEvent(token, `[Hub] ${action.description}`, action.dueDate!);
    }

    if (highPriority.length > 0) {
      console.log(`  google-calendar output: created ${highPriority.length} action item event(s)`);
    }
  }

  private async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }
    const key = loadServiceAccountKey();
    const { token, expiresAt } = await fetchAccessToken(key, SCOPES.calendarWrite);
    this.cachedToken = token;
    this.tokenExpiresAt = expiresAt - 60_000;
    return token;
  }

  private buildEnrichedDescription(event: CalendarEvent): string {
    const e = event.enrichment!;
    const parts: string[] = [];
    if (event.description) parts.push(event.description, "");
    parts.push("── Family Hub ──────────────────────────────");
    if (e.notes) parts.push(e.notes);
    if (e.drivingInfo) parts.push(`🚗 ${e.drivingInfo}`);
    if (e.weatherConsiderations) parts.push(`🌤 ${e.weatherConsiderations}`);
    if (e.actionItems?.length) {
      parts.push("Action items:");
      e.actionItems.forEach((a) => parts.push(`  • ${a}`));
    }
    parts.push(`Updated: ${new Date().toLocaleString()}`);
    return parts.join("\n");
  }

  private async patchEvent(
    token: string,
    calendarId: string,
    eventId: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(patch),
      }
    );
    if (!response.ok) {
      console.warn(`  Failed to patch event ${eventId}: ${response.statusText}`);
    }
  }

  private async createAllDayEvent(
    token: string,
    title: string,
    date: string
  ): Promise<void> {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: title,
          start: { date },
          end: { date },
          description: "Created by Family Hub planning routine.",
        }),
      }
    );
    if (!response.ok) {
      console.warn(`  Failed to create action item event: ${response.statusText}`);
    }
  }
}
