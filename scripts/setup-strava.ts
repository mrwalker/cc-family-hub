#!/usr/bin/env tsx
/**
 * setup-strava.ts
 *
 * One-time OAuth setup for a Strava member. Run this once per person:
 *   npm run setup:strava
 *
 * What it does:
 *   1. Reads (or prompts for) your Strava API clientId + clientSecret
 *   2. Prints an authorization URL — open it in a browser, approve access
 *   3. Prompts for the `code` param from the redirect URL
 *   4. Exchanges the code for a refresh token
 *   5. Saves everything to workspace/state/secrets.yaml
 *
 * Strava app registration: https://www.strava.com/settings/api
 *   - Set "Authorization Callback Domain" to: localhost
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
  console.log("Before you begin, make sure you have a Strava API app:");
  console.log("  → https://www.strava.com/settings/api");
  console.log('  → Set "Authorization Callback Domain" to: localhost\n');

  // Load or initialize secrets
  let all: Record<string, unknown> = {};
  if (existsSync(SECRETS_PATH)) {
    all = (yaml.load(readFileSync(SECRETS_PATH, "utf8")) as Record<string, unknown>) ?? {};
  }
  const strava = (all["strava"] ?? {}) as {
    clientId?: string;
    clientSecret?: string;
    members?: Record<string, { refreshToken: string }>;
  };

  // Client credentials (shared across all members)
  if (!strava.clientId || !strava.clientSecret) {
    console.log("Enter your Strava API app credentials (found at strava.com/settings/api):");
    strava.clientId    = await ask(rl, "  Client ID:     ");
    strava.clientSecret = await ask(rl, "  Client Secret: ");
  } else {
    console.log(`Using existing Strava app (Client ID: ${strava.clientId})`);
  }

  // Which family member
  const memberId = await ask(rl, "\nFamily member ID to connect (e.g. emma, matt): ");
  if (!memberId) { console.error("Member ID is required."); process.exit(1); }

  // Build auth URL
  const authUrl =
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${strava.clientId}` +
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
      client_id: strava.clientId,
      client_secret: strava.clientSecret,
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

  // Save
  strava.members = strava.members ?? {};
  strava.members[memberId] = { refreshToken: data.refresh_token };
  all["strava"] = strava;

  writeFileSync(SECRETS_PATH, yaml.dump(all), "utf8");
  console.log(`✓ Saved refresh token for "${memberId}" to workspace/state/secrets.yaml`);
  console.log("\nRun 'npm run sync' to pull their activities.\n");

  rl.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
