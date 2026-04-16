/**
 * Google Calendar — Input Integration
 *
 * Fetches events using a Google Service Account. Each family member shares
 * their Google Calendar with the service account email, granting the hub
 * permanent read access — no OAuth flows or refresh tokens needed.
 *
 * Setup: run `npm run setup:calendars` for step-by-step instructions.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { BaseIntegration } from "../../_base/BaseIntegration.js";
import {
  loadServiceAccountKey,
  fetchAccessToken,
  SCOPES,
} from "../../_base/google-auth.js";
import type { InputIntegration, CalendarEvent, MemberProfile } from "../../_base/types.js";

export default class GoogleCalendarInput extends BaseIntegration implements InputIntegration {
  readonly id = "google-calendar";
  readonly displayName = "Google Calendar (Input)";

  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  async healthCheck(): Promise<void> {
    const key = loadServiceAccountKey();
    const { token } = await fetchAccessToken(key, SCOPES.calendarRead);
    this.cachedToken = token;
    this.tokenExpiresAt = Date.now() + 55 * 60 * 1000; // 55 min (tokens last 60)
  }

  async fetchEvents(startDate: string, endDate: string): Promise<CalendarEvent[]> {
    const token = await this.getToken();
    const members = this.loadMemberProfiles();
    const allEvents: CalendarEvent[] = [];

    for (const member of members) {
      if (!member.calendarIds?.length) {
        console.warn(`  google-calendar: no calendarIds for "${member.id}" — skipping`);
        continue;
      }

      for (const calendarId of member.calendarIds) {
        try {
          const events = await this.fetchCalendarEvents(token, calendarId, startDate, endDate);
          events.forEach((e) => (e.memberId = member.id));
          allEvents.push(...events);
          console.log(`  ✓ ${member.name}: ${events.length} events from ${calendarId}`);
        } catch (err) {
          console.warn(
            `  google-calendar: failed to fetch ${calendarId} for ${member.id}: ` +
            `${(err as Error).message}`
          );
        }
      }
    }

    return allEvents;
  }

  private async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }
    const key = loadServiceAccountKey();
    const { token, expiresAt } = await fetchAccessToken(key, SCOPES.calendarRead);
    this.cachedToken = token;
    this.tokenExpiresAt = expiresAt - 60_000; // refresh 1 min early
    return token;
  }

  private async fetchCalendarEvents(
    accessToken: string,
    calendarId: string,
    timeMin: string,
    timeMax: string
  ): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(
          `Calendar not found: "${calendarId}". ` +
          `Has the calendar been shared with the service account?`
        );
      }
      throw new Error(`Google Calendar API error (${response.status}): ${response.statusText}`);
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

  private loadMemberProfiles(): MemberProfile[] {
    const dir = join(process.cwd(), "workspace", "members");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
      .map((f) => yaml.load(readFileSync(join(dir, f), "utf8")) as MemberProfile);
  }
}

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurrence?: string[];
}
