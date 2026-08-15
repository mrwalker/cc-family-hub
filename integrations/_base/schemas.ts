/**
 * Zod schemas for validating workspace config files.
 * Used by the hub loader to give clear errors when YAML is malformed.
 */

import { z } from "zod";

export const NotificationChannelSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("menu-bar") }),
  z.object({ type: z.literal("mobile-push"), deviceToken: z.string() }),
  z.object({ type: z.literal("email"), address: z.string().email() }),
  z.object({ type: z.literal("sms"), number: z.string() }),
]);

export const MemberProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be kebab-case"),
  name: z.string(),
  displayName: z.string().optional(),
  email: z.string().email().optional(),
  role: z.enum(["adult", "child", "other"]),
  age: z.number().int().positive().optional(),
  school: z
    .object({
      name: z.string(),
      grade: z.string().optional(),
      year: z.string().optional(),
    })
    .optional(),
  work: z
    .object({
      employer: z.string(),
      role: z.string().optional(),
      schedule: z.string().optional(),
    })
    .optional(),
  hobbies: z.array(z.string()).optional(),
  primaryFocuses: z.array(z.string()).optional(),
  calendarIds: z.array(z.string()).optional(),
  notifications: z
    .object({
      channels: z.array(NotificationChannelSchema),
      advanceWarningMinutes: z.number().int().positive().optional(),
      quietHoursStart: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
      quietHoursEnd: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
    })
    .optional(),
  upcomingProjects: z
    .array(
      z.object({
        title: z.string(),
        description: z.string().optional(),
        dueDate: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })
    )
    .optional(),
});

export const WeeklyPlanSchema = z.object({
  weekStarting: z.string(),
  summary: z.string(),
  days: z
    .array(
      z.object({
        date: z.string(),
        notes: z.string().optional(),
        logistics: z.string().optional(),
      })
    )
    .optional(),
  enrichedEvents: z
    .array(
      z.object({
        id: z.string(),
        notes: z.string().optional(),
        drivingInfo: z.string().optional(),
        weatherConsiderations: z.string().optional(),
        conflicts: z.array(z.string()).optional(),
        actionItems: z.array(z.string()).optional(),
      })
    )
    .optional(),
  actionItems: z
    .array(
      z.object({
        description: z.string(),
        assignedTo: z.string().optional(),
        dueDate: z.string().optional(),
        priority: z.enum(["high", "medium", "low"]),
      })
    )
    .optional(),
  flags: z
    .array(
      z.object({
        severity: z.enum(["info", "warning", "urgent"]),
        message: z.string(),
        relatedEventIds: z.array(z.string()).optional(),
        relatedMemberIds: z.array(z.string()).optional(),
      })
    )
    .optional(),
  shoppingList: z
    .array(
      z.object({
        name: z.string(),
        quantity: z.string().optional(),
        store: z.string().optional(),
        addedBy: z.string().optional(),
      })
    )
    .optional(),
});

export const FamilyConfigSchema = z.object({
  family: z.object({
    name: z.string(),
    timezone: z.string(),
    locale: z.string().default("en-US"),
  }),
  members: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.enum(["adult", "child", "other"]),
    })
  ),
  integrations: z.object({
    active: z.array(z.string()),
    schedule: z.object({
      planningCron: z.string(),
      syncCron: z.string(),
      timezone: z.string(),
    }),
  }),
});

export type ValidatedFamilyConfig = z.infer<typeof FamilyConfigSchema>;
export type ValidatedMemberProfile = z.infer<typeof MemberProfileSchema>;
