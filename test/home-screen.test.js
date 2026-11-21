// app/build.mjs makes the hub installable on a phone's home screen: a manifest named for the
// family, and the family's names in the hub page's <title> and iOS app title.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(repo, "app", "build.mjs");

/** A family repo made from workspace.example, with `edit` applied to its family.yaml. */
function build(edit = s => s, setup = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "hub-home-"));
  cpSync(join(repo, "workspace.example"), join(root, "workspace"), { recursive: true });
  const fy = join(root, "workspace", "family.yaml");
  writeFileSync(fy, edit(readFileSync(fy, "utf8")));
  setup(root);
  execFileSync(process.execPath, [BUILD], { cwd: root, stdio: "pipe" });
  const site = join(root, ".generated", "site");
  return {
    manifest: JSON.parse(readFileSync(join(site, "manifest.webmanifest"), "utf8")),
    hub: readFileSync(join(site, "index.html"), "utf8"),
    household: readFileSync(join(site, "household", "index.html"), "utf8"),
    site,
  };
}

test("the manifest and pages carry the family's title", () => {
  const { manifest, hub, household, site } = build();
  assert.equal(manifest.name, "Rivera Family Hub");
  assert.equal(manifest.short_name, "Rivera Family Hub");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons) assert.ok(existsSync(join(site, icon.src)), icon.src);
  assert.match(hub, /<title>Rivera Family Hub<\/title>/);
  assert.match(hub, /<meta name="apple-mobile-web-app-title" content="Rivera Family Hub">/);
  assert.match(household, /<title>Household<\/title>/);
  assert.match(household, /<meta name="apple-mobile-web-app-title" content="Rivera Family Hub">/);
  assert.ok(existsSync(join(site, "icons", "hub-180.png")));
});

test("hub.shortTitle names the home-screen icon", () => {
  const { manifest, hub } = build(s => s.replace(/^hub:\n/m, 'hub:\n  shortTitle: "Rivera & Co"\n'));
  assert.equal(manifest.name, "Rivera Family Hub");
  assert.equal(manifest.short_name, "Rivera & Co");
  assert.match(hub, /<meta name="apple-mobile-web-app-title" content="Rivera &amp; Co">/);
});

test("a family's own public/manifest.webmanifest wins", () => {
  const own = { name: "Our Own", icons: [] };
  const { manifest } = build(undefined, root => {
    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public", "manifest.webmanifest"), JSON.stringify(own));
  });
  assert.deepEqual(manifest, own);
});

test("an empty hub.shortTitle fails the build", () => {
  assert.throws(() => build(s => s.replace(/^hub:\n/m, 'hub:\n  shortTitle: ""\n')),
    e => String(e.stderr).includes("family.yaml: hub.shortTitle: expected a short name"));
});
