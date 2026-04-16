#!/usr/bin/env node
/**
 * Google Calendar OAuth2 helper — gets a refresh token interactively.
 *
 * Usage:
 *   node scripts/auth/google-calendar.js
 *
 * Prerequisites:
 *   - Created an OAuth2 "Desktop application" credential in Google Cloud Console
 *   - Have the client ID and client secret ready
 */

import { createServer } from "http";
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const REDIRECT_URI = "http://localhost:3456/oauth/callback";

async function main() {
  console.log("\n── Google Calendar OAuth Setup ─────────────────────");
  console.log("You'll need your OAuth2 client ID and secret from");
  console.log("Google Cloud Console → APIs & Services → Credentials.");
  console.log("");

  const clientId = await ask("Client ID: ");
  const clientSecret = await ask("Client Secret: ");

  const authUrl = buildAuthUrl(clientId);
  console.log("\nOpening browser for Google authorization...");
  console.log("If it doesn't open, visit this URL manually:\n");
  console.log(authUrl);
  console.log("");

  // Try to open browser
  const { exec } = await import("child_process");
  exec(`open "${authUrl}"`, () => {});

  // Local callback server
  const code = await waitForCode();

  console.log("\nExchanging code for tokens...");
  const tokens = await exchangeCode(clientId, clientSecret, code);

  console.log("\n── Success! ─────────────────────────────────────────");
  console.log("Add the following to workspace/state/secrets.yaml:\n");
  console.log(`google-calendar:`);
  console.log(`  clientId: "${clientId}"`);
  console.log(`  clientSecret: "${clientSecret}"`);
  console.log(`  refreshToken: "${tokens.refresh_token}"`);
  console.log("\n────────────────────────────────────────────────────\n");

  rl.close();
}

function buildAuthUrl(clientId) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost:3456");
      const code = url.searchParams.get("code");
      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorization successful!</h1><p>You can close this window.</p>");
        server.close();
        resolve(code);
      } else {
        res.writeHead(400);
        res.end("No code received.");
        reject(new Error("No authorization code received."));
      }
    });
    server.listen(3456, () => console.log("Waiting for Google to redirect..."));
  });
}

async function exchangeCode(clientId, clientSecret, code) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token exchange failed: ${err}`);
  }
  return response.json();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
