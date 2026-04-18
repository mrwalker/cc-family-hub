#!/usr/bin/env tsx
/**
 * setup-strava.ts
 *
 * One-time OAuth setup for a Strava member. Run this once per person:
 *   npm run setup:strava
 *
 * Each family member needs their own Strava API app because Strava's free
 * tier limits each app to 1 connected athlete.
 *
 * Strava app registration: https://www.strava.com/settings/api
 *   - Set "Authorization Callback Domain" to: localhost
 *
 * What it does:
 *   1. Prompts for the member's Strava API clientId + clientSecret
 *   2. Prints an authorization URL — open it in a browser, approve access
 *   3. Prompts for the `code` param from the redirect URL
 *   4. Exchanges the code for a refresh token
 *   5. Saves everything to workspace/state/secrets.yaml under strava.members.<id>
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import * as readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import yaml from "js-yaml";

const SECRETS_PATH = join(process.cwd(), "workspace", "state", "secrets.yaml");
const TOKEN_URL    = "https://www.strava.com/api/v3/oauth/token";

async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  const answer = await rl.question(prompt);
  return answer.trim();
}

async function main() {
  const rl = readline.createInterface({ input, output });

  console.log("\n🚴 Strava Setup — Family Hub\n");
  console.log("Each person needs their own Strava API app (free tier = 1 athlete per app).");
  console.log("Register an app at: https://www.strava.com/settings/api");
  console.log('Set "Authorization Callback Domain" to: localhost\n');

  // Which family member
  const memberId = await ask(rl, "Family member ID to connect (e.g. emma, matt): ");
  if (!memberId) { console.error("Member ID is required."); process.exit(1); }

  // Load or initialize secrets
  let all: Record<string, unknown> = {};
  if (existsSync(SECRETS_PATH)) {
    all = (yaml.load(readFileSync(SECRETS_PATH, "utf8")) as Record<string, unknown>) ?? {};
  }
  const strava = (all["strava"] ?? {}) as {
    members?: Record<string, { clientId: string; clientSecret: string; refreshToken: string }>;
  };
  strava.members = strava.members ?? {};

  const existing = strava.members[memberId];
  if (existing?.clientId) {
    console.log(`\nFound existing app for "${memberId}" (Client ID: ${existing.clientId})`);
    const reuse = await ask(rl, "Re-use these credentials? (y/n): ");
    if (reuse.toLowerCase() !== "y") {
      delete strava.members[memberId];
    }
  }

  // Per-member app credentials
  let clientId     = strava.members[memberId]?.clientId     ?? "";
  let clientSecret = strava.members[memberId]?.clientSecret ?? "";

  if (!clientId || !clientSecret) {
    console.log(`\nEnter the Strava API app credentials for ${memberId}:`);
    clientId     = await ask(rl, "  Client ID:     ");
    clientSecret = await ask(rl, "  Client Secret: ");
  }

  // Build auth URL
  const authUrl =
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${clientId}` +
    `&redirect_uri=http://localhost` +
    `&response_type=code` +
    `&approval_prompt=force` +
    `&scope=activity:read_all`;

  console.log(`\n📋 Open this URL in a browser while logged in as ${memberId}:\n`);
  console.log(`  ${authUrl}\n`);
  console.log("After approving, you'll be redirected to a URL like:");
  console.log("  http://localhost/?state=&code=XXXXXXXX&scope=read,activity:read_all\n");

  const code = await ask(rl, "Paste the 'code' value from that redirect URL: ");
  if (!code) { console.error("Code is required."); process.exit(1); }

  // Exchange code for tokens
  console.log("\nExchanging code for tokens...");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`\n❌ Token exchange failed: ${res.status} ${text}`);
    process.exit(1);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    athlete?: { firstname?: string; lastname?: string };
  };

  const athleteName = data.athlete
    ? `${data.athlete.firstname ?? ""} ${data.athlete.lastname ?? ""}`.trim()
    : memberId;

  console.log(`\n✓ Connected: ${athleteName}`);

  // Save per-member credentials + refresh token
  strava.members[memberId] = { clientId, clientSecret, refreshToken: data.refresh_token };
  all["strava"] = strava;

  writeFileSync(SECRETS_PATH, yaml.dump(all), "utf8");
  console.log(`✓ Saved credentials for "${memberId}" to workspace/state/secrets.yaml`);
  console.log("\nRun 'npm run sync' to pull their activities.\n");

  rl.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
