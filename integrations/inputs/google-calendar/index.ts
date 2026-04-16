/**
 * Google Calendar — Input Integration
 *
 * Fetches events from Google Calendar using the Google Calendar API v3.
 * Supports per-member OAuth tokens (set up via `npm run setup:calendars`).
 *
 * Secrets structure (workspace/state/secrets.yaml):
 *   google-calendar:
 *     clientId: <OAuth2 client ID>
 *     clientSecret: <OAuth2 client secret>
 *     members:
 *       <memberId>:
 *         email: <google account email>
 *         refreshToken: <OAuth2 refresh token>
 *
 * Setup: run `npm run setup:calendars` and use the Chrome extension,
 *        or see integrations/inputs/google-calendar/README.md for manual setup.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { BaseIntegration } from "../../_base/BaseIntegration.js";
import type { InputIntegration, CalendarEvent, MemberProfile } from "../../_base/types.js";

interface MemberTokens {
  email: string;
  refreshToken: string;
}

interface GoogleCalendarSecrets {
  clientId: string;
  clientSecret: string;
  members: Record<string, MemberTokens>;
}

export default class GoogleCalendarInput extends BaseIntegration implements InputIntegration {
  readonly id = "google-calendar";
  readonly displayName = "Google Calendar (Input)";

  // Per-member access tokens, refreshed lazily
  private accessTokens: Map<string, string> = new Map();

  async healthCheck(): Promise<void> {
    const secrets = this.loadSecrets<GoogleCalendarSecrets>();
    this.requireSecretKeys(secrets, ["clientId", "clientSecret"]);
    if (!secrets.members || Object.keys(secrets.members).length === 0) {
      throw new Error(
        `No member tokens found in google-calendar secrets. ` +
        `Run 'npm run setup:calendars' to connect family members.`
      );
    }
    // Validate at least one member token is present
    const first = Object.values(secrets.members)[0];
    if (!first?.refreshToken) {
      throw new Error("Member tokens found but refreshToken is missing. Re-run setup:calendars.");
    }
  }

  async fetchEvents(startDate: string, endDate: string): Promise<CalendarEvent[]> {
    const secrets = this.loadSecrets<GoogleCalendarSecrets>();
    const members = this.loadMemberProfiles();
    const allEvents: CalendarEvent[] = [];

    for (const member of members) {
      const memberTokens = secrets.members?.[member.id];
      if (!memberTokens?.refreshToken) {
        console.warn(`  google-calendar: no token for member "${member.id}", skipping`);
        continue;
      }
      if (!member.calendarIds?.length) {
        console.warn(`  google-calendar: no calendarIds for "${member.id}", skipping`);
        continue;
      }

      const accessToken = await this.getAccessToken(member.id, secrets, memberTokens.refreshToken);

      for (const calendarId of member.calendarIds) {
        try {
          const events = await this.fetchCalendarEvents(accessToken, calendarId, startDate, endDate);
          // Tag each event with the member it belongs to
          events.forEach((e) => (e.memberId = member.id));
          allEvents.push(...events);
        } catch (err) {
          console.warn(`  google-calendar: failed to fetch ${calendarId} for ${member.id}: ${(err as Error).message}`);
        }
      }
    }

    return allEvents;
  }

  private async getAccessToken(
    memberId: string,
    secrets: GoogleCalendarSecrets,
    refreshToken: string
  ): Promise<string> {
    // Reuse cached access token if available (they last ~1 hour)
    if (this.accessTokens.has(memberId)) {
      return this.accessTokens.get(memberId)!;
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: secrets.clientId,
        client_secret: secrets.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to refresh token for "${memberId}": ${response.statusText}. ` +
        `Re-run 'npm run setup:calendars' to reconnect.`
      );
    }

    const data = (await response.json()) as { access_token: string };
    this.accessTokens.set(memberId, data.access_token);
    return data.access_token;
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
