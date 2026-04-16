#!/usr/bin/env node
/**
 * Validates that all required secrets are present for active integrations.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

const ROOT = process.cwd();
const FAMILY_CONFIG_PATH = join(ROOT, "workspace", "family.yaml");
const SECRETS_PATH = join(ROOT, "workspace", "state", "secrets.yaml");

// Required secret keys per integration
const REQUIRED_SECRETS = {
  "google-calendar": ["clientId", "clientSecret", "refreshToken"],
  "wall-display": ["deviceUrl", "apiKey"],
  "mobile-app": ["fcmServerKey"],
};

function main() {
  if (!existsSync(FAMILY_CONFIG_PATH)) {
    console.error("ERROR: workspace/family.yaml not found. Run npm run setup.");
    process.exit(1);
  }

  const family = yaml.load(readFileSync(FAMILY_CONFIG_PATH, "utf8"));
  const active = family?.integrations?.active ?? [];

  if (!existsSync(SECRETS_PATH)) {
    console.error("ERROR: workspace/state/secrets.yaml not found.");
    console.error("Copy workspace/state/secrets.example.yaml to get started.");
    process.exit(1);
  }

  const secrets = yaml.load(readFileSync(SECRETS_PATH, "utf8")) ?? {};

  let allOk = true;

  for (const id of active) {
    const required = REQUIRED_SECRETS[id];
    if (!required) continue; // Integration has no secrets requirement

    const integrationSecrets = secrets[id];
    if (!integrationSecrets) {
      console.error(`MISSING: No secrets block found for "${id}" in secrets.yaml`);
      allOk = false;
      continue;
    }

    for (const key of required) {
      if (!integrationSecrets[key] || integrationSecrets[key].startsWith("YOUR_")) {
        console.error(`MISSING: secrets.yaml -> ${id}.${key}`);
        allOk = false;
      }
    }
  }

  if (allOk) {
    console.log(`✓ All secrets present for active integrations: ${active.join(", ")}`);
  } else {
    console.error("\nSome secrets are missing. See the integration READMEs for setup instructions.");
    process.exit(1);
  }
}

main();
