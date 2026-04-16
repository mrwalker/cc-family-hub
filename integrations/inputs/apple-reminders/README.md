# Apple Reminders — Input Integration

Reads incomplete reminders from Apple Reminders and surfaces them as `todo` context items for the planner.

## Requirements

- macOS only (uses AppleScript)
- Apple Reminders app must be signed into iCloud for cross-device sync

## Setup

No credentials required. macOS will prompt for Reminders access the first time the integration runs.

### 1. Grant Permission

Run the integration once manually to trigger the macOS permission dialog:

```bash
npm run sync
```

When prompted, click **OK** to allow access to Reminders.

### 2. Activate

In `workspace/family.yaml`:

```yaml
integrations:
  active:
    - apple-reminders
```

## What Gets Imported

All **incomplete** reminders from all lists are imported as `todo` context items. They appear in the planner's context and can be incorporated into the weekly plan.

Completed reminders are ignored.

## Limitations

- Cannot write back to Reminders (read-only)
- Reads all lists — no per-list filtering yet
- Member attribution is not automatic — todos appear without a `memberId`
