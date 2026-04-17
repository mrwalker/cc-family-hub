/**
 * calendar-utils.ts
 *
 * Shared utility for loading and trimming raw calendar events for the portal.
 * Used by both scripts/build-family-data.ts and the github-pages integration.
 *
 * Data window: current ISO week (Mon 00:00 → Sun 23:59) plus the following week.
 * That gives the week calendar view data for "this week" and "next week" navigation.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

export interface CalendarEvent {
  id: string;
  title: string;
  startAt: string;       // ISO 8601 with offset, or YYYY-MM-DD for all-day
  endAt: string;
  allDay: boolean;
  memberId: string;
  location?: string;     // truncated to 120 chars
}

/**
 * Returns Mon 00:00:00 local time for the ISO week containing `date`.
 */
function getISOWeekMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Loads events from workspace/calendars/google-calendar.yaml, trims to the
 * current week + next week, and strips fields not needed by the portal.
 */
export function loadCalendarEvents(cwd: string): CalendarEvent[] {
  const p = join(cwd, "workspace", "calendars", "google-calendar.yaml");
  if (!existsSync(p)) return [];

  const raw = yaml.load(readFileSync(p, "utf8"));
  if (!Array.isArray(raw)) return [];

  const now = new Date();
  const weekStart = getISOWeekMonday(now);
  const weekEnd   = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 14); // current week + next week
  weekEnd.setHours(23, 59, 59, 999);

  const startMs = weekStart.getTime();
  const endMs   = weekEnd.getTime();

  return (raw as Record<string, unknown>[])
    .filter((e) => {
      // Include if event starts within window OR overlaps it (e.g. multi-day)
      const s = new Date(String(e.startAt)).getTime();
      const en = new Date(String(e.endAt)).getTime();
      return s < endMs && en > startMs;
    })
    .map((e): CalendarEvent => ({
      id:       String(e.id ?? ""),
      title:    String(e.title ?? "(no title)"),
      startAt:  String(e.startAt ?? ""),
      endAt:    String(e.endAt ?? ""),
      allDay:   Boolean(e.allDay),
      memberId: String(e.memberId ?? ""),
      ...(e.location
        ? { location: String(e.location).replace(/<[^>]+>/g, "").slice(0, 120) }
        : {}),
    }));
}
