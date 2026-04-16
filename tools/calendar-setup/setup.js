#!/usr/bin/env node
/**
 * Google Calendar setup validator.
 *
 * Checks that the service account key is present and working, then
 * prints the service account email and shows which family members
 * still need to share their calendars.
 *
 * Usage: npm run setup:calendars
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createSign } from "crypto";
import yaml from "js-yaml";

const ROOT = process.cwd();
const KEY_PATH = join(ROOT, "workspace", "state", "google-service-account.json");
const FAMILY_PATH = join(ROOT, "workspace", "family.yaml");
const MEMBERS_DIR = join(ROOT, "workspace", "members");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildJWT(key, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope,
    aud: key.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  return `${header}.${payload}.${sign.sign(key.private_key, "base64url")}`;
}

async function getAccessToken(key) {
  const jwt = buildJWT(key, "https://www.googleapis.com/auth/calendar.readonly");
  const res = await fetch(key.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Auth failed: ${err}`);
  }
  return (await res.json()).access_token;
}

async function checkCalendarAccess(token, calendarId) {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.ok;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n── Family Hub: Google Calendar Setup ───────────────\n");

  // 1. Check for service account key
  if (!existsSync(KEY_PATH)) {
    console.log("✗  Service account key not found.\n");
    printSetupInstructions();
    process.exit(1);
  }

  let key;
  try {
    key = JSON.parse(readFileSync(KEY_PATH, "utf8"));
    if (key.type !== "service_account") throw new Error("Not a service account key");
  } catch (err) {
    console.error(`✗  Invalid key file: ${err.message}`);
    console.error(`   Expected a service account JSON key at workspace/state/google-service-account.json`);
    process.exit(1);
  }

  console.log(`✓  Service account key loaded`);
  console.log(`   Project:  ${key.project_id}`);
  console.log(`   Email:    ${key.client_email}\n`);

  // 2. Verify the key works by getting an access token
  let token;
  try {
    token = await getAccessToken(key);
    console.log(`✓  Service account authenticated successfully\n`);
  } catch (err) {
    console.error(`✗  Authentication failed: ${err.message}`);
    console.error(`\n   Make sure the Google Calendar API is enabled:`);
    console.error(`   https://console.cloud.google.com/apis/library/calendar-json.googleapis.com`);
    process.exit(1);
  }

  // 3. Check workspace setup
  if (!existsSync(FAMILY_PATH)) {
    console.log("⚠  workspace/family.yaml not found — run npm run setup first\n");
    printShareInstructions(key.client_email, []);
    return;
  }

  const family = yaml.load(readFileSync(FAMILY_PATH, "utf8"));
  const memberRefs = family?.members ?? [];

  // 4. Check each member's calendar access
  console.log("── Calendar access by member ────────────────────────\n");

  const needsSharing = [];

  for (const ref of memberRefs) {
    const profilePath = join(MEMBERS_DIR, `${ref.id}.yaml`);
    const profile = existsSync(profilePath)
      ? yaml.load(readFileSync(profilePath, "utf8"))
      : null;

    const calendarIds = profile?.calendarIds ?? [];

    if (!calendarIds.length) {
      console.log(`  ${ref.name.padEnd(12)}  ⚠  No calendarIds in workspace/members/${ref.id}.yaml`);
      needsSharing.push({ member: ref, reason: "no-calendars" });
      continue;
    }

    // Check each configured calendar
    let anyFailed = false;
    for (const calId of calendarIds) {
      const ok = await checkCalendarAccess(token, calId);
      if (ok) {
        console.log(`  ${ref.name.padEnd(12)}  ✓  ${calId}`);
      } else {
        console.log(`  ${ref.name.padEnd(12)}  ✗  ${calId}  ← not shared`);
        anyFailed = true;
      }
    }
    if (anyFailed) needsSharing.push({ member: ref, reason: "not-shared" });
  }

  console.log();

  if (needsSharing.length === 0) {
    console.log("✓  All calendars are accessible. Ready to sync!\n");
    console.log("   Run: npm run sync\n");
  } else {
    printShareInstructions(key.client_email, needsSharing);
  }

  console.log("────────────────────────────────────────────────────\n");
}

function printSetupInstructions() {
  console.log("To connect Google Calendar, you need a service account key.\n");
  console.log("Steps:\n");
  console.log("  1. Go to https://console.cloud.google.com/");
  console.log("     Create a new project (e.g. 'family-hub')\n");
  console.log("  2. Enable the Google Calendar API:");
  console.log("     https://console.cloud.google.com/apis/library/calendar-json.googleapis.com\n");
  console.log("  3. Create a service account:");
  console.log("     IAM & Admin → Service Accounts → Create Service Account");
  console.log("     Name it anything (e.g. 'family-hub')");
  console.log("     No roles needed — click Done\n");
  console.log("  4. Create a key for the service account:");
  console.log("     Click the service account → Keys → Add Key → Create new key → JSON");
  console.log("     Download the file\n");
  console.log("  5. Move the downloaded file to:");
  console.log("     workspace/state/google-service-account.json\n");
  console.log("  6. Re-run: npm run setup:calendars\n");
}

function printShareInstructions(serviceAccountEmail, needsSharing) {
  console.log("── Share calendars with the service account ─────────\n");
  console.log(`   Service account email:\n`);
  console.log(`   ${serviceAccountEmail}\n`);
  console.log("   For each family member, share their Google Calendar");
  console.log("   with the email above:\n");
  console.log("   Google Calendar → Settings (⚙) → Settings for my calendars");
  console.log("   → [their calendar] → Share with specific people or groups");
  console.log("   → Add the service account email");
  console.log("   → Permission: 'Make changes to events' (for full hub features)");
  console.log("     or 'See all event details' (read-only)\n");

  const noCalendars = needsSharing.filter((n) => n.reason === "no-calendars");
  if (noCalendars.length > 0) {
    console.log("   Then add calendarIds to their profiles:\n");
    for (const { member } of noCalendars) {
      console.log(`   workspace/members/${member.id}.yaml:`);
      console.log(`     calendarIds:`);
      console.log(`       - "primary"   # or their specific calendar ID\n`);
    }
    console.log("   To find a calendar's ID: Google Calendar → Settings →");
    console.log("   click the calendar → 'Calendar ID' near the bottom.\n");
  }

  console.log("   After sharing, re-run: npm run setup:calendars\n");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
