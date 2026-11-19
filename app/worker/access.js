/**
 * Who is asking: the Worker's own check of a Cloudflare Access sign-in.
 *
 * Access decides who reaches the hub at all. For anything that writes, the Worker
 * also verifies the token Access attaches to each request (Cf-Access-Jwt-Assertion):
 * its signature against the team's public keys, its audience, issuer and expiry.
 * The email in a verified token picks the family member, and the member's role
 * decides what they may change.
 *
 *   family.yaml → hub.access: { teamDomain: "<team>.cloudflareaccess.com", aud: "<tag>" }
 *
 *   identify(request, env, hub) → { viewer, problem }
 *     viewer:  { id, name, role: "adult" | "child" | "guest" }, or null
 *     problem: why there's no viewer, in words for whoever is setting the hub up
 *
 * For `wrangler dev`, where there's no Access, set DEV_MEMBER=<member id> in
 * .dev.vars. It's ignored for any request that came through Cloudflare's edge.
 */

const CERTS_TTL_MS = 60 * 60_000;
const certCache = new Map();   // teamDomain → { at, keys }

const b64urlBytes = s => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function teamKeys(teamDomain, fetchFn, fresh = false) {
  const hit = certCache.get(teamDomain);
  if (!fresh && hit && Date.now() - hit.at < CERTS_TTL_MS) return hit.keys;
  const res = await fetchFn(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Couldn't read Access keys from ${teamDomain} (HTTP ${res.status}). Check hub.access.teamDomain`);
  const keys = (await res.json()).keys ?? [];
  certCache.set(teamDomain, { at: Date.now(), keys });
  return keys;
}

/**
 * Verifies an Access token and returns its claims. Throws with the reason if it
 * can't be trusted.
 */
export async function verifyAccessToken(token, access, { fetchFn = fetch, now = Date.now() } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Not a sign-in token");
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { throw new Error("Not a sign-in token"); }
  if (header.alg !== "RS256") throw new Error("Sign-in token uses an unexpected algorithm");

  let jwk = (await teamKeys(access.teamDomain, fetchFn)).find(k => k.kid === header.kid);
  // Access rotates its keys; an unknown key id is worth one fresh look.
  if (!jwk) jwk = (await teamKeys(access.teamDomain, fetchFn, true)).find(k => k.kid === header.kid);
  if (!jwk) throw new Error("Sign-in token was signed by an unknown key");

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), signed);
  if (!ok) throw new Error("Sign-in token's signature doesn't match");

  const seconds = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp <= seconds) throw new Error("Sign-in has expired");
  if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) throw new Error("Sign-in token isn't valid yet");
  if (claims.iss !== `https://${access.teamDomain}`) throw new Error("Sign-in token is from a different Access team");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(access.aud)) throw new Error("Sign-in token is for a different application. Check hub.access.aud");
  return claims;
}

function viewerFor(hub, id) {
  const member = hub.members.find(m => m.id === id);
  if (member) return { id: member.id, name: member.name, role: member.role === "child" ? "child" : "adult" };
  return { id, name: id, role: "guest" };
}

/** The signed-in member or guest behind `request`, or why there isn't one. */
export async function identify(request, env, hub, opts = {}) {
  // Local development: no Access in front of `wrangler dev`. Requests through
  // Cloudflare's edge always carry CF-Ray, so this can't be used on a live hub.
  if (env.DEV_MEMBER && !request.headers.get("CF-Ray")) {
    return { viewer: viewerFor(hub, String(env.DEV_MEMBER)), problem: null };
  }
  if (!hub.access?.teamDomain || !hub.access?.aud) {
    return { viewer: null, problem: "Set hub.access (teamDomain and aud) in family.yaml so the hub can check who is signed in. See docs/workspace.md" };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { viewer: null, problem: "No sign-in on this request. Is the hub behind Cloudflare Access?" };
  let claims;
  try {
    claims = await verifyAccessToken(token, hub.access, opts);
  } catch (err) {
    return { viewer: null, problem: err.message };
  }
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  const id = email ? hub.emailToMember?.[email] : null;
  if (!id) {
    return { viewer: null, problem: email ? `${email} isn't a family member or guest in family.yaml` : "This sign-in has no email (a service token can't change household records)" };
  }
  return { viewer: viewerFor(hub, id), problem: null };
}
