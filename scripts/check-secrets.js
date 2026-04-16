#!/usr/bin/env node
/**
 * Validates that all required credentials are present for active integrations.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

const ROOT = process.cwd();
const FAMILY_CONFIG_PATH = join(ROOT, "workspace", "family.yaml");
const SECRETS_PATH = join(ROOT, "workspace", "state", "secrets.yaml");
const GOOGLE_KEY_PATH = join(ROOT, "workspace", "state", "google-service-account.json");

// Required secrets.yaml keys per integration (google-calendar uses a separate key file)
const REQUIRED_SECRETS = {
  "wall-display": ["deviceUrl", "apiKey"],
  "mobile-app":   ["fcmServerKey"],
};

function main() {
  if (!existsSync(FAMILY_CONFIG_PATH)) {
    console.error("ERROR: workspace/family.yaml not found. Run npm run setup.");
    process.exit(1);
  }

  const family = yaml.load(readFileSync(FAMILY_CONFIG_PATH, "utf8"));
  const active = family?.integrations?.active ?? [];
  let allOk = true;

  for (const id of active) {
    // Google Calendar uses a key file, not secrets.yaml
    if (id === "google-calendar") {
      if (!existsSync(GOOGLE_KEY_PATH)) {
        console.error(`MISSING: workspace/state/google-service-account.json`);
        console.error(`         Run: npm run setup:calendars`);
        allOk = false;
      } else {
        const key = JSON.parse(readFileSync(GOOGLE_KEY_PATH, "utf8"));
        if (key.type !== "service_account") {
          console.error(`INVALID: workspace/state/google-service-account.json is not a service account key`);
          allOk = false;
        } else {
          // Count members with calendarIds configured
          const members = family?.members ?? [];
          const membersDir = join(ROOT, "workspace", "members");
          let withCalendars = 0;
          for (const ref of members) {
            const profilePath = join(membersDir, `${ref.id}.yaml`);
            if (existsSync(profilePath)) {
              const profile = yaml.load(readFileSync(profilePath, "utf8"));
              if (profile?.calendarIds?.length) withCalendars++;
            }
          }
          const total = members.length;
          if (withCalendars < total) {
            console.warn(`WARNING: google-calendar: ${withCalendars}/${total} members have calendarIds configured`);
            console.warn(`         Run: npm run setup:calendars`);
          } else {
            console.log(`✓ google-calendar: service account key present, ${withCalendars}/${total} members configured`);
          }
        }
      }
      continue;
    }

    const required = REQUIRED_SECRETS[id];
    if (!required) continue;

    if (!existsSync(SECRETS_PATH)) {
      console.error("ERROR: workspace/state/secrets.yaml not found.");
      console.error("Copy workspace/state/secrets.example.yaml to get started.");
      process.exit(1);
    }

    const secrets = yaml.load(readFileSync(SECRETS_PATH, "utf8")) ?? {};
    const integrationSecrets = secrets[id];

    if (!integrationSecrets) {
      console.error(`MISSING: No secrets block found for "${id}" in secrets.yaml`);
      allOk = false;
      continue;
    }

    for (const key of required) {
      if (!integrationSecrets[key] || String(integrationSecrets[key]).startsWith("YOUR_")) {
        console.error(`MISSING: secrets.yaml -> ${id}.${key}`);
        allOk = false;
      }
    }

    if (allOk) console.log(`✓ ${id}: credentials present`);
  }

  if (!allOk) {
    console.error("\nSome credentials are missing. See integration READMEs for setup instructions.");
    process.exit(1);
  }
}

main();
