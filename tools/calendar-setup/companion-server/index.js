#!/usr/bin/env node
/**
 * Calendar Setup Companion Server
 *
 * Runs locally on port 3457. Handles the Google OAuth flow for each family
 * member and writes the resulting tokens + calendar IDs back into the workspace.
 *
 * Start with: npm run setup:calendars
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

const PORT = 3457;
const ROOT = process.cwd();
const WORKSPACE = join(ROOT, "workspace");
const SECRETS_PATH = join(WORKSPACE, "state", "secrets.yaml");
const FAMILY_CONFIG_PATH = join(WORKSPACE, "family.yaml");
const MEMBERS_DIR = join(WORKSPACE, "members");
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;

// ─── Workspace helpers ────────────────────────────────────────────────────────

function loadSecrets() {
  if (!existsSync(SECRETS_PATH)) return {};
  return yaml.load(readFileSync(SECRETS_PATH, "utf8")) ?? {};
}

function saveSecrets(secrets) {
  writeFileSync(SECRETS_PATH, yaml.dump(secrets), "utf8");
}

function loadFamilyConfig() {
  if (!existsSync(FAMILY_CONFIG_PATH)) return null;
  return yaml.load(readFileSync(FAMILY_CONFIG_PATH, "utf8"));
}

function loadMember(memberId) {
  const path = join(MEMBERS_DIR, `${memberId}.yaml`);
  if (!existsSync(path)) return null;
  return yaml.load(readFileSync(path, "utf8"));
}

function saveMember(memberId, profile) {
  writeFileSync(join(MEMBERS_DIR, `${memberId}.yaml`), yaml.dump(profile), "utf8");
}

function getMemberStatus() {
  const config = loadFamilyConfig();
  if (!config) return [];
  const secrets = loadSecrets();
  const calSecrets = secrets["google-calendar"] ?? {};

  return config.members.map((ref) => {
    const profile = loadMember(ref.id) ?? ref;
    const memberTokens = calSecrets.members?.[ref.id];
    return {
      id: ref.id,
      name: ref.name,
      role: ref.role,
      email: profile.email ?? null,
      connected: Boolean(memberTokens?.refreshToken),
      calendarIds: profile.calendarIds ?? [],
    };
  });
}

// ─── Google OAuth helpers ─────────────────────────────────────────────────────

function getClientCredentials() {
  const secrets = loadSecrets();
  return {
    clientId: secrets["google-calendar"]?.clientId ?? null,
    clientSecret: secrets["google-calendar"]?.clientSecret ?? null,
  };
}

function buildAuthUrl(clientId, memberId) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    access_type: "offline",
    prompt: "consent",
    state: memberId,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
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
  if (!response.ok) throw new Error(`Token exchange failed: ${await response.text()}`);
  return response.json();
}

async function fetchCalendarList(accessToken) {
  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) throw new Error("Failed to fetch calendar list");
  const data = await response.json();
  return data.items ?? [];
}

async function fetchAccountEmail(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.email ?? null;
}

// ─── Request router ───────────────────────────────────────────────────────────

function respond(res, status, body, contentType = "application/json") {
  // Allow cross-origin requests from the Chrome extension
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") return respond(res, 204, "");

  // ── GET /api/status ──
  if (method === "GET" && path === "/api/status") {
    const { clientId, clientSecret } = getClientCredentials();
    return respond(res, 200, {
      running: true,
      clientConfigured: Boolean(clientId && clientSecret),
      members: getMemberStatus(),
    });
  }

  // ── POST /api/save-client ── { clientId, clientSecret }
  if (method === "POST" && path === "/api/save-client") {
    const { clientId, clientSecret } = await readBody(req);
    if (!clientId || !clientSecret)
      return respond(res, 400, { error: "clientId and clientSecret required" });
    const secrets = loadSecrets();
    secrets["google-calendar"] = {
      ...(secrets["google-calendar"] ?? {}),
      clientId,
      clientSecret,
    };
    saveSecrets(secrets);
    return respond(res, 200, { ok: true });
  }

  // ── GET /auth/start/:memberId ──
  if (method === "GET" && path.startsWith("/auth/start/")) {
    const memberId = path.replace("/auth/start/", "");
    const { clientId } = getClientCredentials();
    if (!clientId) return respond(res, 400, "OAuth client not configured", "text/plain");
    const authUrl = buildAuthUrl(clientId, memberId);
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ── GET /auth/callback?code=...&state=memberId ──
  if (method === "GET" && path === "/auth/callback") {
    const code = url.searchParams.get("code");
    const memberId = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error || !code || !memberId) {
      return respond(res, 400, errorPage(memberId, error ?? "No code received"), "text/html");
    }

    try {
      const { clientId, clientSecret } = getClientCredentials();
      const tokens = await exchangeCode(clientId, clientSecret, code);
      const accountEmail = await fetchAccountEmail(tokens.access_token);
      const calendars = await fetchCalendarList(tokens.access_token);

      // Keep only calendars the user owns or has write access to (skip read-only/subscribed)
      const ownedCalendarIds = calendars
        .filter((c) => c.accessRole === "owner" || c.accessRole === "writer")
        .map((c) => c.id);

      // Save refresh token, keyed per member
      const secrets = loadSecrets();
      if (!secrets["google-calendar"]) secrets["google-calendar"] = {};
      if (!secrets["google-calendar"].members) secrets["google-calendar"].members = {};
      secrets["google-calendar"].members[memberId] = {
        email: accountEmail,
        refreshToken: tokens.refresh_token,
      };
      saveSecrets(secrets);

      // Update member profile with email (if not set) and calendarIds
      const profile = loadMember(memberId);
      if (profile) {
        if (!profile.email && accountEmail) profile.email = accountEmail;
        profile.calendarIds = ownedCalendarIds;
        saveMember(memberId, profile);
      }

      console.log(`✓ Connected ${memberId} (${accountEmail}) — ${ownedCalendarIds.length} calendars`);
      return respond(res, 200, successPage(memberId, accountEmail, ownedCalendarIds), "text/html");
    } catch (err) {
      console.error(`OAuth error for ${memberId}:`, err.message);
      return respond(res, 500, errorPage(memberId, err.message), "text/html");
    }
  }

  // ── GET / ── Dashboard
  if (method === "GET" && path === "/") {
    return respond(res, 200, dashboardPage(), "text/html");
  }

  respond(res, 404, { error: "Not found" });
}

// ─── HTML pages ───────────────────────────────────────────────────────────────

function dashboardPage() {
  const config = loadFamilyConfig();
  const familyName = config?.family?.name ?? "Your Family";
  const members = getMemberStatus();
  const { clientId } = getClientCredentials();

  const memberRows = members
    .map((m) => {
      const status = m.connected
        ? `<span class="badge ok">✓ Connected</span>`
        : `<span class="badge pending">Not connected</span>`;
      const cals = m.calendarIds.length
        ? `<small>${m.calendarIds.length} calendar(s)</small>`
        : "";
      const btn = m.connected
        ? ""
        : `<a href="/auth/start/${m.id}" class="btn">Connect</a>`;
      return `<tr><td>${m.name}</td><td>${m.role}</td><td>${m.email ?? "—"}</td><td>${status} ${cals}</td><td>${btn}</td></tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Family Hub — Calendar Setup</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #333; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  h2 { font-size: 1rem; color: #555; margin-top: 32px; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { font-size: 0.8rem; text-transform: uppercase; color: #888; }
  .badge { font-size: 0.8rem; padding: 2px 8px; border-radius: 10px; }
  .badge.ok { background: #d4edda; color: #155724; }
  .badge.pending { background: #fff3cd; color: #856404; }
  .btn { display: inline-block; padding: 4px 12px; background: #0070f3; color: white; text-decoration: none; border-radius: 4px; font-size: 0.85rem; }
  .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 12px 16px; border-radius: 6px; margin: 16px 0; font-size: 0.9rem; }
  small { color: #888; display: block; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
</style>
</head>
<body>
<h1>Family Hub — Google Calendar Setup</h1>
<small>Family: ${familyName} &nbsp;·&nbsp; Server running on localhost:${PORT}</small>

${
  !clientId
    ? `<div class="warning">
        <strong>Step 1:</strong> Set up OAuth credentials in the Chrome extension popup,
        or use the existing auth script: <code>npm run auth:google-calendar</code>
       </div>`
    : ""
}

<h2>Family Members</h2>
<table>
  <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Status</th><th></th></tr></thead>
  <tbody>${memberRows}</tbody>
</table>

<h2>How to Connect</h2>
<ol>
  <li>Install the Chrome extension from <code>tools/calendar-setup/chrome-extension/</code></li>
  <li>In Chrome, open Google Calendar while signed in as the family member's account</li>
  <li>Click the extension icon, select the family member, and click <strong>Connect</strong></li>
  <li>Approve access — tokens and calendar IDs are saved automatically</li>
</ol>
<p>Or click the <strong>Connect</strong> buttons above (make sure you're logged into the right Google account first).</p>
</body>
</html>`;
}

function successPage(memberId, email, calendarIds) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connected!</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 500px; margin: 80px auto; text-align: center; color: #333; }
  .icon { font-size: 3rem; }
  h1 { font-size: 1.3rem; margin: 12px 0 4px; }
  p { color: #555; font-size: 0.95rem; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 0.85em; display: block; margin: 4px 0; }
  a { color: #0070f3; }
</style>
<script>
  // Notify the extension popup that auth is complete
  if (window.opener) {
    window.opener.postMessage({ type: 'FAMILY_HUB_AUTH_COMPLETE', memberId: '${memberId}' }, '*');
    setTimeout(() => window.close(), 2000);
  }
</script>
</head>
<body>
<div class="icon">✓</div>
<h1>${memberId} connected!</h1>
<p>${email ?? ""}</p>
<p>${calendarIds.length} calendar(s) saved:</p>
${calendarIds.map((id) => `<code>${id}</code>`).join("")}
<p style="margin-top:24px"><a href="/">← Back to setup dashboard</a></p>
</body>
</html>`;
}

function errorPage(memberId, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Error</title>
<style>body { font-family: system-ui, sans-serif; max-width: 500px; margin: 80px auto; text-align: center; }</style>
</head>
<body>
<div style="font-size:3rem">✗</div>
<h1>Connection failed</h1>
<p>${memberId ? `Member: ${memberId}` : ""}</p>
<p style="color:#c00">${message}</p>
<p><a href="/">← Back to setup dashboard</a></p>
</body>
</html>`;
}

// ─── Start server ─────────────────────────────────────────────────────────────

if (!existsSync(FAMILY_CONFIG_PATH)) {
  console.error("ERROR: workspace/family.yaml not found. Run npm run setup first.");
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error("Unhandled error:", err);
    respond(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n── Family Hub Calendar Setup ────────────────────────`);
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Install the Chrome extension from:`);
  console.log(`     tools/calendar-setup/chrome-extension/`);
  console.log(`  2. For each family member, open calendar.google.com`);
  console.log(`     while signed in as their account`);
  console.log(`  3. Click the extension and connect them`);
  console.log(`\nOr open http://localhost:${PORT} to connect manually.`);
  console.log(`────────────────────────────────────────────────────\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Is the server already running?`);
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});
