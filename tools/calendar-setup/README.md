# Google Calendar Setup

Connects the hub to each family member's Google Calendar using a **service account** — no browser OAuth flows, no refresh tokens to manage. The hub gets a single key file that works permanently.

## How It Works

A Google service account is a non-human identity in your Google Cloud project. You share each family member's calendar with it (like sharing with a colleague), and the hub uses the service account's key to read and write those calendars.

```
Your Google Cloud Project
  └── Service Account  (family-hub@your-project.iam.gserviceaccount.com)
         │
         │  "shared with this email"
         ├── Alex's Google Calendar  ──► hub can read/write
         ├── Jordan's Google Calendar ──► hub can read/write
         ├── Sam's Google Calendar    ──► hub can read/write
         └── Riley's Google Calendar  ──► hub can read/write
```

## Setup (one-time, ~10 minutes)

### Step 1 — Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
2. Click the project dropdown at the top → **New Project**
3. Name it `family-hub` (or anything) → **Create**

### Step 2 — Enable the Google Calendar API

In your new project:
[console.cloud.google.com/apis/library/calendar-json.googleapis.com](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)

Click **Enable**.

### Step 3 — Create a Service Account

1. Go to **IAM & Admin → Service Accounts → Create Service Account**
2. Name: `family-hub` (the display name — anything works)
3. Service account ID will auto-fill (e.g. `family-hub@your-project.iam.gserviceaccount.com`)
4. Skip the optional role and user access steps → **Done**

### Step 4 — Download the Key

1. Click the service account you just created
2. **Keys** tab → **Add Key** → **Create new key** → **JSON**
3. A `.json` file downloads automatically

### Step 5 — Add the Key to Your Workspace

Move the downloaded file to:

```
workspace/state/google-service-account.json
```

### Step 6 — Validate the Setup

```bash
npm run setup:calendars
```

This will verify the key works and print the service account email address. It will also show which family members need to share their calendars.

### Step 7 — Share Each Family Member's Calendar

Each family member needs to share their Google Calendar with the service account email. This is a one-time action per person.

In Google Calendar:
1. Click **Settings** (⚙) → **Settings for my calendars**
2. Click the calendar to share (usually their name / "primary")
3. **Share with specific people or groups** → **Add people**
4. Paste the service account email (printed by `npm run setup:calendars`)
5. Permission: **Make changes to events** ← required for the hub to write enriched notes back
6. **Send** (Google will say the invite bounced — that's normal for service accounts, the share still works)

Repeat for each family member.

### Step 8 — Add Calendar IDs to Member Profiles

After sharing, add the calendar IDs to each member's profile in `workspace/members/<id>.yaml`:

```yaml
calendarIds:
  - "primary"                                        # Their main Google calendar
  - "family@group.calendar.google.com"               # A shared family calendar (optional)
```

To find a calendar's ID: **Settings** → click the calendar → **Calendar ID** near the bottom.

Run `npm run setup:calendars` again to confirm everything is accessible.

### Step 9 — First Sync

```bash
npm run sync
```

## Re-running Setup

Run `npm run setup:calendars` any time to check which calendars are connected and diagnose access issues.

## Troubleshooting

**"Auth failed: ... API has not been used"** — the Google Calendar API isn't enabled. Go to Step 2.

**"✗ not shared" next to a calendar** — the service account hasn't been granted access to that calendar yet. Repeat Step 7 for that member.

**"No calendarIds" warning** — the member's profile doesn't have `calendarIds` set. Add them per Step 8.

**"Google will say the invite bounced"** — normal. Service accounts don't have inboxes. The calendar share still takes effect.
