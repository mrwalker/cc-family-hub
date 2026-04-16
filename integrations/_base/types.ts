/**
 * Core types and interfaces for the Family Hub integration system.
 *
 * All input and output integrations implement these contracts. The hub engine
 * talks only to these interfaces — integrations are fully interchangeable.
 */

// ─── Family Config Types ────────────────────────────────────────────────────

export interface FamilyConfig {
  family: {
    name: string;
    timezone: string;          // IANA timezone, e.g. "America/Los_Angeles"
    locale: string;            // BCP 47, e.g. "en-US"
  };
  members: MemberRef[];
  integrations: {
    active: string[];          // Integration IDs that are enabled
    schedule: HubSchedule;
  };
}

export interface MemberRef {
  id: string;                  // Kebab-case, matches filename in members/
  name: string;                // Display name
  role: "adult" | "child" | "other";
}

export interface HubSchedule {
  planningCron: string;        // Cron expression, e.g. "0 6 * * *"
  syncCron: string;            // Cron for calendar sync
  timezone: string;            // Timezone for cron interpretation
}

// ─── Member Profile ──────────────────────────────────────────────────────────

export interface MemberProfile {
  id: string;
  name: string;
  displayName?: string;
  email?: string;
  role: "adult" | "child" | "other";
  age?: number;
  school?: SchoolInfo;
  work?: WorkInfo;
  hobbies?: string[];
  primaryFocuses?: string[];   // Current major focuses / ongoing projects
  calendarIds?: string[];      // IDs as used by calendar integrations
  notifications?: NotificationPrefs;
  upcomingProjects?: UpcomingProject[];
}

export interface SchoolInfo {
  name: string;
  grade?: string;
  year?: string;               // e.g. "sophomore", "3rd grade"
}

export interface WorkInfo {
  employer: string;
  role?: string;
  schedule?: string;           // Free text, e.g. "M–F 9–5, remote"
}

export interface NotificationPrefs {
  channels: NotificationChannel[];
  advanceWarningMinutes?: number;
  quietHoursStart?: string;    // "HH:MM"
  quietHoursEnd?: string;      // "HH:MM"
}

export type NotificationChannel =
  | { type: "menu-bar" }
  | { type: "mobile-push"; deviceToken: string }
  | { type: "email"; address: string }
  | { type: "sms"; number: string };

export interface UpcomingProject {
  title: string;
  description?: string;
  dueDate?: string;            // ISO 8601 date
  tags?: string[];
}

// ─── Calendar Types ───────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  source: string;              // Integration ID that produced this event
  calendarId: string;
  memberId?: string;           // Which family member this belongs to
  title: string;
  description?: string;
  location?: string;
  startAt: string;             // ISO 8601 datetime with offset
  endAt: string;               // ISO 8601 datetime with offset
  allDay: boolean;
  recurrenceRule?: string;     // RRULE string
  tags?: string[];
  enrichment?: EventEnrichment;
}

export interface EventEnrichment {
  notes?: string;              // AI-generated notes
  drivingInfo?: string;
  weatherConsiderations?: string;
  conflicts?: string[];        // IDs of conflicting events
  actionItems?: string[];
  lastEnrichedAt: string;      // ISO 8601
}

// ─── Context Types ────────────────────────────────────────────────────────────

export interface ContextItem {
  id: string;
  type: "note" | "link" | "shopping-item" | "photo" | "todo" | "free-form";
  memberId?: string;           // Who submitted this
  content: string;
  url?: string;                // For link type
  tags?: string[];
  createdAt: string;           // ISO 8601
  expiresAt?: string;          // Hub will ignore after this date
  consumed?: boolean;          // True once the planner has incorporated it
}

export interface ShoppingItem {
  id: string;
  name: string;
  quantity?: string;
  store?: string;
  addedBy?: string;            // Member ID
  addedAt: string;
  purchased?: boolean;
}

// ─── Planning Types ───────────────────────────────────────────────────────────

export interface PlanningContext {
  family: FamilyConfig;
  members: MemberProfile[];
  events: CalendarEvent[];     // Next N days of events
  contextItems: ContextItem[];
  previousPlan?: WeeklyPlan;
  generatedAt: string;
}

export interface WeeklyPlan {
  generatedAt: string;
  weekStarting: string;        // ISO 8601 date (Monday)
  summary: string;             // AI-generated narrative summary
  days: DayPlan[];
  shoppingList: ShoppingItem[];
  actionItems: PlanActionItem[];
  flags: PlanFlag[];           // Items needing human attention
}

export interface DayPlan {
  date: string;                // ISO 8601 date
  events: CalendarEvent[];
  notes?: string;              // AI narrative for the day
  logistics?: string;          // Driving, coordination notes
}

export interface PlanActionItem {
  id: string;
  description: string;
  assignedTo?: string;         // Member ID
  dueDate?: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "done";
}

export interface PlanFlag {
  severity: "info" | "warning" | "urgent";
  message: string;
  relatedEventIds?: string[];
  relatedMemberIds?: string[];
}

// ─── Integration Interfaces ───────────────────────────────────────────────────

/**
 * Base interface all integrations must implement.
 */
export interface BaseIntegration {
  /** Unique kebab-case identifier, e.g. "google-calendar" */
  readonly id: string;
  /** Human-readable display name */
  readonly displayName: string;
  /** Check connectivity and credentials; throw if not ready */
  healthCheck(): Promise<void>;
}

/**
 * Input integrations pull data into the hub.
 */
export interface InputIntegration extends BaseIntegration {
  /** Pull calendar events for the given date range */
  fetchEvents?(startDate: string, endDate: string): Promise<CalendarEvent[]>;
  /** Pull context items (todos, notes, links, shopping) submitted since cursor */
  fetchContextItems?(since?: string): Promise<ContextItem[]>;
  /** Returns an updated cursor for the next fetchContextItems call */
  getCursor?(): string;
}

/**
 * Output integrations receive planning results and publish them.
 */
export interface OutputIntegration extends BaseIntegration {
  /** Push enriched calendar events back to the output destination */
  publishEvents?(events: CalendarEvent[]): Promise<void>;
  /** Push the full weekly plan */
  publishPlan?(plan: WeeklyPlan): Promise<void>;
  /** Push a shopping list */
  publishShoppingList?(items: ShoppingItem[]): Promise<void>;
  /** Send a notification to a specific member */
  sendNotification?(memberId: string, message: string, urgency?: "normal" | "high"): Promise<void>;
}

// ─── Integration Registry ─────────────────────────────────────────────────────

export interface IntegrationRegistry {
  inputs: Map<string, InputIntegration>;
  outputs: Map<string, OutputIntegration>;
}
