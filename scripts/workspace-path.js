// Plain-JS twin of hub/paths.ts for scripts that run under `node` (not tsx).
// Keep the two in sync.
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const envFile = join(process.cwd(), ".env");
if (!(process.env.HUB_WORKSPACE && process.env.HUB_SECRETS_DIR) && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export const WORKSPACE = resolve(expand(process.env.HUB_WORKSPACE || join(process.cwd(), "workspace")));
export const SECRETS_DIR = resolve(expand(process.env.HUB_SECRETS_DIR || join(WORKSPACE, "state")));
