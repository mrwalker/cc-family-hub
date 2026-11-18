// Plain-JS twin of hub/paths.ts for scripts that run under `node` (not tsx).
// Keep the two in sync.
import { existsSync } from "fs";
import { join, resolve } from "path";

const envFile = join(process.cwd(), ".env");
if (!process.env.HUB_WORKSPACE && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export const WORKSPACE = resolve(process.env.HUB_WORKSPACE || join(process.cwd(), "workspace"));
