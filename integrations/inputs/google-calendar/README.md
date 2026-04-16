# Google Calendar — Input Integration

Fetches events from one or more Google Calendars for each family member.

## Setup

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or reuse an existing one)
3. Enable the **Google Calendar API**

### 2. Create OAuth2 Credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth client ID**
3. Choose **Desktop application**
4. Download the JSON — note `client_id` and `client_secret`

### 3. Get a Refresh Token

Run the included helper script to complete the OAuth flow:

```bash
node scripts/auth/google-calendar.js
```

This will open a browser window, ask you to grant calendar access, and print a `refresh_token`.

### 4. Configure Secrets

Add to `workspace/state/secrets.yaml`:

```yaml
google-calendar:
  clientId: "your-client-id.apps.googleusercontent.com"
  clientSecret: "your-client-secret"
  refreshToken: "your-refresh-token"
```

### 5. Add Calendar IDs to Member Profiles

In each member's `workspace/members/<name>.yaml`, add their Google Calendar IDs:

```yaml
calendarIds:
  - "primary"                                      # Their primary Gmail calendar
  - "family-calendar-id@group.calendar.google.com" # A shared family calendar
```

To find a calendar ID: Google Calendar → Settings → click calendar → "Calendar ID" near the bottom.

### 6. Activate the Integration

In `workspace/family.yaml`:

```yaml
integrations:
  active:
    - google-calendar
```

## Scopes Required

- `https://www.googleapis.com/auth/calendar.readonly`

## Troubleshooting

**"Failed to refresh Google OAuth token"** — the refresh token may have expired (this happens if you revoke access or don't use it for 6+ months). Re-run the auth script.

**Missing events** — check that the calendarId in the member profile exactly matches the calendar's ID in Google Calendar settings.
