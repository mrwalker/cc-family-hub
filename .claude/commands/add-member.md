# /add-member

Add a new family member to the hub.

## Steps

1. Ask the user for the following information about the new member:
   - Full name
   - Preferred display name (if different)
   - Email address (optional)
   - Role: `adult`, `child`, or `other`
   - Age (optional)
   - School info (for children): school name, grade/year
   - Work info (for adults): employer, role, schedule
   - Hobbies and current focuses (free text, comma-separated is fine)
   - Google Calendar IDs (or other calendar IDs if they use a different calendar integration)
   - Notification preferences: which channels, quiet hours

2. Generate a kebab-case `id` from the display name (e.g., "Alex Smith" → `alex-smith`).

3. Create the member profile file at `workspace/members/<id>.yaml` using the schema from `workspace.example/members/alex.yaml` as a reference.

4. Add the member to `workspace/family.yaml` under the `members` list.

5. Confirm with the user and show them the created file.

## Notes

- The member's `id` must be unique across all members
- `calendarIds` should match exactly what appears in the member's calendar settings
- Notification channels depend on which output integrations are active
- You can leave most optional fields blank — they can be filled in later
