import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessToken, identify } from "../app/worker/access.js";
import { HUB } from "./helpers.js";

const AUD = "a".repeat(64);
let teams = 0;
const NOW = Date.parse("2027-06-21T19:00:00Z");

const b64url = bytes => Buffer.from(bytes).toString("base64url");
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

/**
 * An Access team: a signing key, the certs endpoint Access would serve for it,
 * and a hub configured to trust it. Each has its own domain, as keys are cached
 * per team.
 */
async function team(kid = "key-1") {
  const ACCESS = { teamDomain: `team-${++teams}.cloudflareaccess.com`, aud: AUD };
  const pair = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  let fetches = 0;
  const fetchFn = async url => {
    fetches++;
    assert.equal(url, `https://${ACCESS.teamDomain}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [jwk] }));
  };
  const sign = async (claims, header = {}) => {
    const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...header }));
    const body = b64url(JSON.stringify({ iss: `https://${ACCESS.teamDomain}`, aud: [ACCESS.aud], exp: NOW / 1000 + 600, email: "alex@example.com", ...claims }));
    const sig = await crypto.subtle.sign(RSA.name, pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  };
  return { sign, access: ACCESS, hub: { ...HUB, access: ACCESS }, opts: { fetchFn, now: NOW }, fetches: () => fetches };
}

const signedIn = token => new Request("https://hub.example.com/api/household", { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });

test("a token Access signed is trusted, and its email picks the member and role", async () => {
  const t = await team();
  assert.equal((await verifyAccessToken(await t.sign({}), t.access, t.opts)).email, "alex@example.com");
  const who = async email => (await identify(signedIn(await t.sign({ email })), {}, t.hub, t.opts));
  assert.deepEqual((await who("Alex@Example.com")).viewer, { id: "alex", name: "Alex", role: "adult" });
  assert.deepEqual((await who("sam@example.com")).viewer, { id: "sam", name: "Sam", role: "child" });
  assert.deepEqual((await who("pat@example.com")).viewer, { id: "pat", name: "pat", role: "guest" }, "a trip guest");
  const stranger = await who("nobody@example.com");
  assert.equal(stranger.viewer, null);
  assert.match(stranger.problem, /isn't a family member/);
});

test("a token that can't be trusted is refused, with the reason", async () => {
  const t = await team();
  const refuse = async (token, why) => assert.rejects(verifyAccessToken(token, t.access, t.opts), why);
  await refuse("not-a-token", /Not a sign-in token/);
  await refuse(await t.sign({ exp: NOW / 1000 - 1 }), /expired/);
  await refuse(await t.sign({ aud: ["b".repeat(64)] }), /different application/);
  await refuse(await t.sign({ iss: "https://someone-else.cloudflareaccess.com" }), /different Access team/);
  await refuse(await t.sign({}, { alg: "none" }), /unexpected algorithm/);

  // A token changed after signing: an adult's email swapped in for a child's.
  const [head, , sig] = (await t.sign({ email: "sam@example.com" })).split(".");
  const forged = b64url(JSON.stringify({ iss: `https://${t.access.teamDomain}`, aud: [AUD], exp: NOW / 1000 + 600, email: "alex@example.com" }));
  await refuse(`${head}.${forged}.${sig}`, /signature doesn't match/);

  // A valid-looking token signed by someone else's key.
  const other = await team("key-1");
  await refuse(await other.sign({ iss: `https://${t.access.teamDomain}` }), /signature doesn't match/);
  const unknown = await team("key-9");
  await refuse(await unknown.sign({ iss: `https://${t.access.teamDomain}` }), /unknown key/);
});

test("the email header alone is not a sign-in", async () => {
  const t = await team();
  const req = new Request("https://hub.example.com/api/household", { headers: { "Cf-Access-Authenticated-User-Email": "alex@example.com" } });
  const who = await identify(req, {}, t.hub, t.opts);
  assert.equal(who.viewer, null);
  assert.match(who.problem, /No sign-in/);
});

test("a service token has no member; without hub.access nobody does", async () => {
  const t = await team();
  const service = await identify(signedIn(await t.sign({ email: undefined, common_name: "abc.access" })), {}, t.hub, t.opts);
  assert.equal(service.viewer, null);
  assert.match(service.problem, /service token/);
  const unset = await identify(signedIn(await t.sign({})), {}, HUB, t.opts);
  assert.equal(unset.viewer, null);
  assert.match(unset.problem, /hub\.access/);
});

test("the team's keys are fetched once and reused", async () => {
  const t = await team();
  const token = await t.sign({});
  for (let i = 0; i < 3; i++) await verifyAccessToken(token, t.access, t.opts);
  assert.equal(t.fetches(), 1);
});
