/**
 * Family Hub Worker
 *
 * A family's hub repo wraps this with its own config:
 *
 *   import { createHub } from "cc-family-hub/app/worker/index.js";
 *   import config from "./.generated/hub-config.json";   // built by cc-family-hub/app/build.mjs
 *   export default createHub(config);
 *
 * Routes:
 *   GET /api/events?days=N  — live Google Calendar events for every member (default 14 days)
 *   GET /api/config.js      — the page's share of the hub config (names, colors, trip apps)
 *   GET /api/widget?view=…  — compact upcoming events + next trip for phone widgets (widget.js)
 *   GET /api/widget/photos… — photos from the family's iCloud shared album (photos.js)
 *   /api/data…              — published plan/family/strava data (see data-api.js)
 *   /api/trip/:id/…         — trip app check-ins and packing lists
 *   All other paths         — static assets (the hub page, trip apps)
 *
 * Worker secrets (set via `wrangler secret put`):
 *   SA_CLIENT_EMAIL   — Google service account email
 *   SA_PRIVATE_KEY    — service account private key (full PEM string)
 *   API_TOKEN         — required as X-Api-Token on /api/events. The page gets it from
 *                       /api/config.js, so keep /api/config.js behind your auth (e.g.
 *                       Cloudflare Access) even if /api/events is excluded from it.
 *   PUBLISH_TOKEN     — bearer token the pipeline uses to PUT /api/data/:kind
 *
 * Bindings: ASSETS (static assets), HUB_DATA (KV, published data), TRIP_KV (KV, trip apps).
 */

import { handleDataApi } from "./data-api.js";
import { handleWidget } from "./widget.js";
import { handlePhotos } from "./photos.js";

// Widgets refresh often and every phone asks separately; one Google fetch per
// window serves them all.
const EVENTS_CACHE_SECONDS = 300;

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const TOKEN_URI      = "https://oauth2.googleapis.com/token";

/** Builds the Worker for one family's config (the JSON written by app/build.mjs). */
export function createHub(config) {
  const hub = {
    title: config.title,
    timezone: config.timezone,
    locale: config.locale || "en-US",
    members: config.members,
    tripApps: config.tripApps,
    photosAlbum: config.photos?.icloudAlbum ?? null,
    // Trips that have an app, and who can score on each (family members plus
    // the trip's guests). Unknown trip ids 404.
    tripMembers: Object.fromEntries(config.tripApps.map(t => [t.appId, new Set(t.players)])),
    // Sign-in email → player, so a trip app can pick the right player automatically.
    // Guests' emails are only used for this; their calendars are never fetched.
    emailToMember: Object.fromEntries([
      ...config.members.flatMap(m => m.emails.map(e => [e, m.id])),
      ...config.guests.filter(g => g.email).map(g => [g.email, g.id]),
    ]),
    // The page's share of the config: no emails or calendar ids.
    pageConfig: {
      title: config.title,
      timezone: config.timezone,
      members: config.members.map(({ id, name, color }) => ({ id, name, color })),
      tripApps: Object.fromEntries(config.tripApps.map(t => [t.trip, t.path])),
      groceryEmailUrl: config.groceryEmailUrl ?? null,
    },
  };
  return { fetch: (request, env) => route(request, env, hub) };
}

async function route(request, env, hub) {
  const url = new URL(request.url);

  if (url.pathname === "/api/events") {
    return handleEvents(request, env, hub);
  }

  if (url.pathname === "/api/widget") {
    return handleWidget(request, env, hub, days => cachedEvents(env, hub, days));
  }

  if (url.pathname === "/api/widget/photos" || url.pathname.startsWith("/api/widget/photos/")) {
    return handlePhotos(request, env, hub, url.pathname.slice("/api/widget/photos".length));
  }

  if (url.pathname === "/api/config.js") {
    const page = { ...hub.pageConfig, eventsToken: env.API_TOKEN ?? null };
    return new Response(`window.HUB_CONFIG = ${JSON.stringify(page).replace(/<\//g, "<\\/")};\n`, {
      headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "private, no-store" },
    });
  }

  if (url.pathname.startsWith("/api/data")) {
    const res = await handleDataApi(request, env);
    if (res) return res;
  }

  const tripMatch = url.pathname.match(/^\/api\/trip\/([a-z0-9-]{1,40})\/checkins$/);
  if (tripMatch) {
    return handleTripCheckins(request, env, hub, tripMatch[1]);
  }

  const packMatch = url.pathname.match(/^\/api\/trip\/([a-z0-9-]{1,40})\/packing$/);
  if (packMatch) {
    return handleTripPacking(request, env, hub, packMatch[1]);
  }

  // /<trip> → /<trip>/ so relative asset paths and the service worker scope resolve
  const app = hub.tripApps.find(t => t.path === `${url.pathname}/`);
  if (app) {
    return Response.redirect(`${url.origin}${app.path}`, 301);
  }

  // Fall through to static assets (the hub page, trip apps, etc.)
  return env.ASSETS.fetch(request);
}

// ─── Event handler ────────────────────────────────────────────────────────────

async function handleEvents(request, env, hub) {
  // Auth check
  if (request.headers.get("X-Api-Token") !== env.API_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url  = new URL(request.url);
  const days = Math.min(parseInt(url.searchParams.get("days") ?? "14"), 90);

  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days * 86_400_000).toISOString();

  try {
    const token  = await getServiceAccountToken(env.SA_CLIENT_EMAIL, env.SA_PRIVATE_KEY);
    const events = await fetchAllEvents(token, hub.members, timeMin, timeMax);
    return jsonResponse({ generatedAt: new Date().toISOString(), events });
  } catch (err) {
    console.error("Calendar fetch error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/** Live events for the next `days` days, cached briefly at the edge. */
async function cachedEvents(env, hub, days) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(`https://family-hub.internal/events?days=${days}`);
  const hit = cache && (await cache.match(key));
  if (hit) return hit.json();

  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days * 86_400_000).toISOString();
  const token = await getServiceAccountToken(env.SA_CLIENT_EMAIL, env.SA_PRIVATE_KEY);
  const events = await fetchAllEvents(token, hub.members, timeMin, timeMax);
  if (cache) {
    await cache.put(key, new Response(JSON.stringify(events), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${EVENTS_CACHE_SECONDS}` },
    }));
  }
  return events;
}

// ─── Google Service Account auth ─────────────────────────────────────────────

async function getServiceAccountToken(clientEmail, privateKeyPem) {
  const key = await importPrivateKey(privateKeyPem);
  const jwt = await buildJWT(clientEmail, key);

  const resp = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  return data.access_token;
}

async function importPrivateKey(pem) {
  // Strip PEM armor and decode to DER bytes
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function buildJWT(clientEmail, cryptoKey) {
  const now = Math.floor(Date.now() / 1000);

  const header  = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss:   clientEmail,
    scope: CALENDAR_SCOPE,
    aud:   TOKEN_URI,
    iat:   now,
    exp:   now + 3600,
  }));

  const input = new TextEncoder().encode(`${header}.${payload}`);
  const sigBuf = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, input);
  const sig = b64url(sigBuf);

  return `${header}.${payload}.${sig}`;
}

function b64url(data) {
  // Accepts string or ArrayBuffer
  let str;
  if (typeof data === "string") {
    str = btoa(unescape(encodeURIComponent(data)));
  } else {
    str = btoa(String.fromCharCode(...new Uint8Array(data)));
  }
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─── Calendar fetching ────────────────────────────────────────────────────────

async function fetchAllEvents(accessToken, members, timeMin, timeMax) {
  const allEvents = [];

  for (const { id: memberId, calendars } of members) {
    for (const calendarId of calendars) {
      try {
        const events = await fetchCalendarEvents(accessToken, calendarId, timeMin, timeMax);
        for (const e of events) {
          e.memberId = memberId;
        }
        allEvents.push(...events);
      } catch (err) {
        // Log and continue — one bad calendar shouldn't break the whole response
        console.error(`Failed to fetch ${calendarId} for ${memberId}: ${err.message}`);
      }
    }
  }

  return allEvents;
}

async function fetchCalendarEvents(accessToken, calendarId, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Calendar API ${resp.status} for ${calendarId}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return (data.items ?? []).map((item) => mapEvent(item, calendarId));
}

function mapEvent(item, calendarId) {
  const allDay = Boolean(item.start?.date && !item.start?.dateTime);

  // RSVP status: attendee marked `self` is the calendar owner. An event is
  // "declined" when that attendee's responseStatus is declined, or when the
  // organizer cancelled it. Used to render declined meetings struck/dimmed.
  const attendees = Array.isArray(item.attendees) ? item.attendees : [];
  const selfAttendee = attendees.find(a => a.self === true);
  const declined =
    item.status === "cancelled" ||
    (selfAttendee && selfAttendee.responseStatus === "declined");

  const event = {
    id:       `google-calendar:${item.id}`,
    title:    item.summary ?? "(No title)",
    startAt:  item.start?.dateTime ?? item.start?.date ?? "",
    endAt:    item.end?.dateTime   ?? item.end?.date   ?? "",
    allDay,
    calendarId,
    declined: !!declined,
  };
  if (item.location) {
    event.location = item.location.replace(/<[^>]+>/g, "").slice(0, 120);
  }
  return event;
}

// ─── Trip quest check-ins (vacation leaderboard) ─────────────────────────────
//
// Each check-in is its own KV key, with the data in key metadata, so one
// list() call returns the whole leaderboard and concurrent writes from
// different phones never clobber each other.
//
//   GET  /api/trip/:tripId/checkins → { checkins: [...], viewer, serverTime }
//   POST /api/trip/:tripId/checkins   { upserts: [{id, member, quest, ts, note?}], deletes: [id] }
//
// Gated by Cloudflare Access like the rest of the site (not excluded like
// /api/events). Requires the TRIP_KV binding in wrangler.jsonc.

async function handleTripCheckins(request, env, hub, tripId) {
  const members = hub.tripMembers[tripId];
  if (!members) return jsonResponse({ error: "Unknown trip" }, 404);
  if (!env.TRIP_KV) {
    return jsonResponse({ error: "TRIP_KV binding not configured" }, 503);
  }
  const prefix = `trip:${tripId}:ci:`;

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Bad JSON" }, 400); }

    const upserts = Array.isArray(body.upserts) ? body.upserts.slice(0, 200) : [];
    const deletes = Array.isArray(body.deletes) ? body.deletes.slice(0, 200) : [];
    const writes = [];

    for (const c of upserts) {
      const clean = cleanCheckin(c, members);
      if (clean) writes.push(env.TRIP_KV.put(prefix + clean.id, "1", { metadata: clean }));
    }
    for (const id of deletes) {
      if (isValidId(id)) writes.push(env.TRIP_KV.delete(prefix + id));
    }
    await Promise.all(writes);
  } else if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const checkins = [];
  let cursor;
  do {
    const page = await env.TRIP_KV.list({ prefix, cursor });
    for (const k of page.keys) if (k.metadata) checkins.push(k.metadata);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const email = (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase();
  return jsonResponse({
    checkins,
    viewer: hub.emailToMember[email] ?? null,
    serverTime: Date.now(),
  });
}

// Packing checklists: one KV key per member, newest `ts` wins.
//   GET  /api/trip/:tripId/packing → { lists: { member: { checked: [...], ts } } }
//   POST /api/trip/:tripId/packing   { lists: { member: { checked: [...], ts } } }
async function handleTripPacking(request, env, hub, tripId) {
  const tripMembers = hub.tripMembers[tripId];
  if (!tripMembers) return jsonResponse({ error: "Unknown trip" }, 404);
  if (!env.TRIP_KV) {
    return jsonResponse({ error: "TRIP_KV binding not configured" }, 503);
  }
  const key = m => `trip:${tripId}:pack:${m}`;
  const members = [...tripMembers];
  const current = Object.fromEntries(await Promise.all(
    members.map(async m => [m, await env.TRIP_KV.get(key(m), "json")])
  ));

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Bad JSON" }, 400); }
    const writes = [];
    for (const [m, list] of Object.entries(body.lists || {})) {
      if (!tripMembers.has(m) || !list || !Array.isArray(list.checked)) continue;
      const ts = Number(list.ts);
      if (!Number.isFinite(ts) || (current[m] && current[m].ts >= ts)) continue;
      const checked = list.checked
        .filter(x => typeof x === "string" && /^[a-z0-9-]{1,40}$/.test(x))
        .slice(0, 300);
      current[m] = { checked, ts };
      writes.push(env.TRIP_KV.put(key(m), JSON.stringify(current[m])));
    }
    await Promise.all(writes);
  } else if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const lists = {};
  for (const m of members) if (current[m]) lists[m] = current[m];
  return jsonResponse({ lists });
}

function isValidId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,40}$/.test(id);
}

// KV metadata is capped at 1024 bytes, so keep each check-in compact.
function cleanCheckin(c, members) {
  if (!c || !isValidId(c.id)) return null;
  if (!members.has(c.member)) return null;
  if (typeof c.quest !== "string" || !/^[a-z0-9-]{1,40}$/.test(c.quest)) return null;
  const ts = Number(c.ts);
  if (!Number.isFinite(ts)) return null;
  const out = { id: c.id, member: c.member, quest: c.quest, ts };
  if (typeof c.note === "string" && c.note.trim()) out.note = c.note.trim().slice(0, 140);
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
