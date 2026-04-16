# /add-member

Add a new family member or update an existing one.

## Determine Intent First

Start by asking: **Are we adding a new member or updating an existing one?**

If updating, ask which member and what they'd like to change. You can then read the
existing profile, make targeted edits, and confirm the changes — no need to re-enter
everything from scratch.

---

## Adding a New Member

Ask the user for the following:

- Full name and preferred display name (if different)
- Email address (optional but recommended — needed for calendar linking)
- Role: `adult`, `child`, or `other`
- Age (optional)
- School info (children): school name, grade/year
- Work info (adults): employer, role, schedule
- Hobbies (comma-separated is fine)
- Current primary focuses or ongoing projects
- Calendar IDs (Google Calendar IDs, school calendar addresses, etc.)
- Notification preferences: which channels, advance warning, quiet hours

Then:

1. Generate a kebab-case `id` from the display name (e.g. "Alex Smith" → `alex-smith`)
2. Create `workspace/members/<id>.yaml` using `workspace.example/members/alex.yaml` as the schema reference
3. Add the member to `workspace/family.yaml` under the `members` list
4. Show the created file and confirm with the user

---

## Updating an Existing Member

Common update scenarios:

- **New calendar** — add an ID to `calendarIds`
- **Changed school/grade** — update `school.name`, `school.grade`, `school.year`
- **New job or schedule** — update `work` block
- **New project or focus** — add to `upcomingProjects` or `primaryFocuses`
- **Completed project** — remove from `upcomingProjects`
- **New device / notification channel** — add to `notifications.channels`
- **Changed email** — update `email`

Steps:
1. Read `workspace/members/<id>.yaml`
2. Make the requested changes
3. Show a diff of what changed and confirm before writing

---

## Notes

- `email` is optional but recommended for all members — children often have their own
  Google accounts or school email addresses with associated calendars
- `calendarIds` should match exactly what appears in the member's Google Calendar settings
  (Settings → click the calendar → "Calendar ID")
- Member `id` must be unique and match the filename — don't change it after creation
  as it's referenced in context items and calendar event attribution
