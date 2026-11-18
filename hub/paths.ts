/**
 * Where the family workspace lives.
 *
 * By default the workspace is `./workspace` inside this repo (gitignored).
 * Set HUB_WORKSPACE (in the environment or in a `.env` file at the repo root)
 * to keep it somewhere else, e.g. in your family's private instance repo:
 *
 *   HUB_WORKSPACE=../walker-family-hub/workspace
 *
 * Secrets (secrets.yaml, google-service-account.json) default to the workspace's
 * state/ folder. Set HUB_SECRETS_DIR to keep them outside any git repo instead.
 * Recommended when the workspace is versioned:
 *
 *   HUB_SECRETS_DIR=~/.config/family-hub      (chmod 700)
 *
 * Relative paths resolve against the current working directory; a leading ~ is
 * expanded to your home directory.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const envFile = join(process.cwd(), ".env");
if (!(process.env.HUB_WORKSPACE && process.env.HUB_SECRETS_DIR) && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export const WORKSPACE = resolve(expand(process.env.HUB_WORKSPACE || join(process.cwd(), "workspace")));
export const STATE_DIR = join(WORKSPACE, "state");
export const CALENDARS_DIR = join(WORKSPACE, "calendars");
export const SECRETS_DIR = resolve(expand(process.env.HUB_SECRETS_DIR || STATE_DIR));
export const SECRETS_PATH = join(SECRETS_DIR, "secrets.yaml");
export const GOOGLE_KEY_PATH = join(SECRETS_DIR, "google-service-account.json");

/** Absolute path to a file inside the workspace, e.g. ws("trips.yaml"). */
export const ws = (...parts: string[]): string => join(WORKSPACE, ...parts);
