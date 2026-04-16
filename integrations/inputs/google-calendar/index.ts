/**
 * Google Calendar — Input Integration
 *
 * Fetches events from Google Calendar using the Google Calendar API v3.
 *
 * Required secrets (workspace/state/secrets.yaml):
 *   google-calendar:
 *     clientId: <OAuth2 client ID>
 *     clientSecret: <OAuth2 client secret>
 *     refreshToken: <OAuth2 refresh token>
 *
 * Setup: see integrations/inputs/google-calendar/README.md
 */

import { BaseIntegration } from "../../_base/BaseIntegration.js";
import type { InputIntegration, CalendarEvent } from "../../_base/types.js";

interface GoogleCalendarSecrets {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export default class GoogleCalendarInput extends BaseIntegration implements InputIntegration {
  readonly id = "google-calendar";
  readonly displayName = "Google Calendar (Input)";

  private accessToken: string | null = null;

  async healthCheck(): Promise<void> {
    const secrets = this.loadSecrets<GoogleCalendarSecrets>();
    this.requireSecretKeys(secrets, ["clientId", "clientSecret", "refreshToken"]);
    await this.refreshAccessToken(secrets);
  }

  async fetchEvents(startDate: string, endDate: string): Promise<CalendarEvent[]> {
    const secrets = this.loadSecrets<GoogleCalendarSecrets>();
    if (!this.accessToken) await this.refreshAccessToken(secrets);

    // Fetch from the Google Calendar API
    // Each calendarId configured in family member profiles is fetched separately
    // TODO: Load calendarIds from workspace member profiles
    const calendarIds = await this.getConfiguredCalendarIds();
    const allEvents: CalendarEvent[] = [];

    for (const calendarId of calendarIds) {
      const events = await this.fetchCalendarEvents(calendarId, startDate, endDate);
      allEvents.push(...events);
    }

    return allEvents;
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

    if (!response.ok) {
      throw new Error(`Failed to refresh Google OAuth token: ${response.statusText}`);
    }

    const data = (await response.json()) as { access_token: string };
    this.accessToken = data.access_token;
  }

  private async getConfiguredCalendarIds(): Promise<string[]> {
    // Returns all unique calendarIds from member profiles
    // Populated at runtime from workspace/members/*.yaml
    // TODO: wire up to loader
    return [];
  }

  private async fetchCalendarEvents(
    calendarId: string,
    timeMin: string,
    timeMax: string
  ): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
    });

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } }
    );

    if (!response.ok) {
      throw new Error(`Google Calendar API error for ${calendarId}: ${response.statusText}`);
    }

    const data = (await response.json()) as { items: GoogleCalendarEvent[] };
    return (data.items ?? []).map((item) => this.mapToCalendarEvent(item, calendarId));
  }

  private mapToCalendarEvent(item: GoogleCalendarEvent, calendarId: string): CalendarEvent {
    const allDay = Boolean(item.start?.date && !item.start?.dateTime);
    return {
      id: `google-calendar:${item.id}`,
      source: this.id,
      calendarId,
      title: item.summary ?? "(No title)",
      description: item.description,
      location: item.location,
      startAt: item.start?.dateTime ?? item.start?.date ?? "",
      endAt: item.end?.dateTime ?? item.end?.date ?? "",
      allDay,
      recurrenceRule: item.recurrence?.[0],
    };
  }
}

// Minimal Google Calendar API event shape
interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurrence?: string[];
}
