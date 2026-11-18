/**
 * Where the family workspace lives.
 *
 * By default the workspace is `./workspace` inside this repo (gitignored).
 * Set HUB_WORKSPACE (in the environment or in a `.env` file at the repo root)
 * to keep it somewhere else, e.g. in your family's private instance repo:
 *
 *   HUB_WORKSPACE=../walker-family-hub/workspace
 *
 * Relative paths resolve against the current working directory.
 */

import { existsSync } from "fs";
import { join, resolve } from "path";

const envFile = join(process.cwd(), ".env");
if (!process.env.HUB_WORKSPACE && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export const WORKSPACE = resolve(process.env.HUB_WORKSPACE || join(process.cwd(), "workspace"));
export const STATE_DIR = join(WORKSPACE, "state");
export const CALENDARS_DIR = join(WORKSPACE, "calendars");
export const SECRETS_PATH = join(STATE_DIR, "secrets.yaml");

/** Absolute path to a file inside the workspace, e.g. ws("trips.yaml"). */
export const ws = (...parts: string[]): string => join(WORKSPACE, ...parts);
