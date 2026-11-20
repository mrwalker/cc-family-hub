/**
 * Google access for the Worker, through the family's service account
 * (Worker secrets SA_CLIENT_EMAIL and SA_PRIVATE_KEY).
 *
 *   serviceAccountToken(env, scope)  → an access token, reused for most of its hour
 *   calendarClient(env)              → { list, insert, patch, remove } on calendars the
 *                                      service account may change (household-calendar.js)
 */

export const SCOPES = {
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
};
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";

const tokens = new Map();   // scope → { token, until }

/** An access token for `scope`, from the service account. */
export async function serviceAccountToken(env, scope = SCOPES.calendarRead) {
  if (!env.SA_CLIENT_EMAIL || !env.SA_PRIVATE_KEY) throw new Error("SA_CLIENT_EMAIL and SA_PRIVATE_KEY Worker secrets aren't set");
  const hit = tokens.get(scope);
  if (hit && hit.until > Date.now()) return hit.token;
  const key = await importPrivateKey(env.SA_PRIVATE_KEY);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: env.SA_CLIENT_EMAIL, scope, aud: TOKEN_URI, iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  const resp = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${payload}.${b64url(sig)}` }),
  });
  if (!resp.ok) throw new Error(`Token exchange failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  const { access_token: token, expires_in: seconds = 3600 } = await resp.json();
  tokens.set(scope, { token, until: Date.now() + (seconds - 300) * 1000 });
  return token;
}

async function importPrivateKey(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

function b64url(data) {
  const str = typeof data === "string"
    ? btoa(unescape(encodeURIComponent(data)))
    : btoa(String.fromCharCode(...new Uint8Array(data)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Events on calendars the service account can change. Each call throws with Google's reason. */
export function calendarClient(env) {
  const call = async (method, path, body) => {
    const token = await serviceAccountToken(env, SCOPES.calendarEvents);
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (method === "DELETE" && (res.status === 404 || res.status === 410)) return null;   // already gone
    if (!res.ok) {
      const text = await res.text();
      const hint = res.status === 403 || res.status === 404
        ? ` Is the calendar shared with ${env.SA_CLIENT_EMAIL} ("Make changes to events")?` : "";
      throw new Error(`Google Calendar ${res.status}: ${text.slice(0, 160)}${hint}`);
    }
    return res.status === 204 ? null : res.json();
  };
  const cal = id => `/calendars/${encodeURIComponent(id)}/events`;
  return {
    /** Every event the hub made, changed since `updatedMin` (deleted ones too). */
    async list(calendarId, { updatedMin } = {}) {
      const items = [];
      let pageToken;
      do {
        const q = new URLSearchParams({ privateExtendedProperty: "hub=household", showDeleted: "true", maxResults: "250" });
        if (updatedMin) q.set("updatedMin", updatedMin);
        if (pageToken) q.set("pageToken", pageToken);
        const page = await call("GET", `${cal(calendarId)}?${q}`);
        items.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return items;
    },
    insert: (calendarId, event) => call("POST", cal(calendarId), event),
    patch: (calendarId, eventId, event) => call("PATCH", `${cal(calendarId)}/${encodeURIComponent(eventId)}`, event),
    remove: (calendarId, eventId) => call("DELETE", `${cal(calendarId)}/${encodeURIComponent(eventId)}`),
  };
}
