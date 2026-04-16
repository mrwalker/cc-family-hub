# Google Calendar Setup Tool

Replaces the manual OAuth + secrets-editing process with a guided Chrome extension UI.

## What It Does

Instead of running `scripts/auth/google-calendar.js` once per family member and manually editing YAML files, this tool lets you:

1. Start a local companion server
2. For each family member, open Google Calendar in Chrome while signed in as their account
3. Click the extension → select the member → click **Connect**
4. OAuth completes automatically — tokens and calendar IDs are written to your workspace

## Setup

### Step 1 — Google Cloud Console

> Skip this if you already ran `npm run auth:google-calendar` and have credentials in `workspace/state/secrets.yaml`

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project, enable the **Google Calendar API**
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
4. Choose **Web application** (not Desktop — the companion server uses a localhost redirect)
5. Under **Authorized redirect URIs**, add: `http://localhost:3457/auth/callback`
6. Note your **Client ID** and **Client Secret** — you'll enter them in the extension

### Step 2 — Start the Companion Server

```bash
npm run setup:calendars
```

Leave this terminal running. Open `http://localhost:3457` to see the setup dashboard.

### Step 3 — Install the Chrome Extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select `tools/calendar-setup/chrome-extension/`

The extension icon will appear in your toolbar. Pin it for easy access.

### Step 4 — Generate Icons (Optional)

If you want the extension to show a proper icon instead of a grey default:

```bash
# Requires the `canvas` npm package
npm install canvas --no-save
node tools/calendar-setup/chrome-extension/icons/generate.js
```

Or just drop any three PNG files (16px, 48px, 128px) into `icons/` named `icon16.png`, `icon48.png`, `icon128.png`.

### Step 5 — Connect Each Family Member

Repeat for each family member:

1. In Chrome, sign in to Google as that family member (use a separate Chrome profile or account switcher)
2. Open [Google Calendar](https://calendar.google.com)
3. Click the **Family Hub** extension icon
4. The extension detects the signed-in account and pre-selects the matching member
5. Select the correct member if needed
6. Click **Connect as [Name]**
7. Approve access in the Google auth window
8. ✓ Tokens saved, calendar IDs written to the member's profile

### What Gets Written

After connecting each member, the tool automatically:

- Saves their **refresh token** to `workspace/state/secrets.yaml` under `google-calendar.members.<id>`
- Sets their **email** in `workspace/members/<id>.yaml` (if not already set)
- Populates **calendarIds** in their profile with all calendars they own or have write access to

## Secrets Format

The tool writes a per-member structure under the `google-calendar` key:

```yaml
# workspace/state/secrets.yaml (generated — do not commit)
google-calendar:
  clientId: "xxx.apps.googleusercontent.com"
  clientSecret: "GOCSPX-..."
  members:
    alex:
      email: "alex@gmail.com"
      refreshToken: "1//0g..."
    jordan:
      email: "jordan@gmail.com"
      refreshToken: "1//0h..."
```

The hub's `google-calendar` input integration reads from `members.<id>.refreshToken` to get a token per member.

## After Setup

Once all members are connected, you can remove the companion server and extension — they're only needed for initial setup or when re-authorizing an account.

Run your first calendar sync:

```bash
npm run sync
```

## Troubleshooting

**Extension shows "Server not running"** — make sure `npm run setup:calendars` is running in your hub directory.

**Wrong Google account detected** — Google Calendar's DOM varies; click the avatar in the top right to confirm which account you're on, then manually select the correct member in the extension.

**"redirect_uri_mismatch" error** — you used a Desktop application credential type instead of Web application, or forgot to add `http://localhost:3457/auth/callback` as an authorized redirect URI in Google Cloud Console.

**Token expired later** — re-run the connection for that member. Refresh tokens rarely expire but can be revoked if the user changes their Google password or revokes app access.
