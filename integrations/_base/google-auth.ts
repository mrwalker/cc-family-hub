/**
 * Google Service Account JWT authentication helper.
 * Used by all Google integrations (Calendar input, Calendar output).
 *
 * No OAuth dance — just a signed JWT exchanged for an access token.
 * The service account email gets shared on each family member's calendar,
 * granting the hub read (or write) access permanently.
 */

import { createSign } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const SERVICE_ACCOUNT_PATH = join(
  process.cwd(),
  "workspace",
  "state",
  "google-service-account.json"
);

export interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
}

export const SCOPES = {
  calendarRead:  "https://www.googleapis.com/auth/calendar.readonly",
  calendarWrite: "https://www.googleapis.com/auth/calendar",
};

export function loadServiceAccountKey(): ServiceAccountKey {
  if (!existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error(
      `Google service account key not found.\n` +
      `Expected: workspace/state/google-service-account.json\n` +
      `Run: npm run setup:calendars`
    );
  }
  const raw = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
  if (raw.type !== "service_account") {
    throw new Error(
      `workspace/state/google-service-account.json is not a service account key file. ` +
      `Download it from Google Cloud Console → IAM & Admin → Service Accounts → Keys.`
    );
  }
  return raw as ServiceAccountKey;
}

/**
 * Exchange a signed JWT for a short-lived access token.
 * Tokens are valid for 1 hour — callers should cache and re-use them.
 */
export async function fetchAccessToken(
  key: ServiceAccountKey,
  scope: string
): Promise<{ token: string; expiresAt: number }> {
  const jwt = buildJWT(key, scope);
  const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Service account auth failed (${response.status}): ${body}\n` +
      `Make sure the Google Calendar API is enabled in your Google Cloud project.`
    );
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  return {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

function buildJWT(key: ServiceAccountKey, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header  = toBase64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64url(JSON.stringify({
    iss: key.client_email,
    scope,
    aud: key.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(key.private_key, "base64url");

  return `${header}.${payload}.${signature}`;
}

function toBase64url(str: string): string {
  return Buffer.from(str).toString("base64url");
}
