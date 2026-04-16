#!/usr/bin/env node
/**
 * Bootstrap script — creates workspace/ from workspace.example/
 * and walks the user through initial configuration.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { createInterface } from "readline";

const ROOT = process.cwd();
const EXAMPLE = join(ROOT, "workspace.example");
const WORKSPACE = join(ROOT, "workspace");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

function copyDir(src, dest) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (!existsSync(destPath)) {
      copyFileSync(srcPath, destPath);
      console.log(`  created: workspace/${relative(WORKSPACE, destPath)}`);
    } else {
      console.log(`  exists (skipped): workspace/${relative(WORKSPACE, destPath)}`);
    }
  }
}

async function main() {
  console.log("\n── Family Hub Setup ────────────────────────────────");

  if (existsSync(WORKSPACE)) {
    console.log("workspace/ already exists.");
    const overwrite = await ask("Re-run setup and copy missing files? (y/N) ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Setup cancelled.");
      rl.close();
      return;
    }
  }

  console.log("\nCopying workspace template...");
  copyDir(EXAMPLE, WORKSPACE);

  console.log("\n── Next Steps ───────────────────────────────────────");
  console.log("");
  console.log("1. Edit workspace/family.yaml — set your family name,");
  console.log("   timezone, and member list.");
  console.log("");
  console.log("2. Customize or replace the member profiles in");
  console.log("   workspace/members/. Each member needs their own");
  console.log("   <id>.yaml file matching the id in family.yaml.");
  console.log("");
  console.log("3. Copy workspace/state/secrets.example.yaml to");
  console.log("   workspace/state/secrets.yaml and fill in your");
  console.log("   API credentials.");
  console.log("");
  console.log("4. Connect your first integration:");
  console.log("   cat integrations/inputs/google-calendar/README.md");
  console.log("");
  console.log("5. Run your first sync:");
  console.log("   npm run sync");
  console.log("");
  console.log("6. Run the planner:");
  console.log("   npm run plan");
  console.log("");
  console.log("Or use Claude Code for guided setup:");
  console.log("   claude /add-member");
  console.log("────────────────────────────────────────────────────\n");

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
