/**
 * Integration registry — dynamically loads and instantiates all active
 * integrations based on what's configured in workspace/family.yaml.
 */

import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type {
  FamilyConfig,
  IntegrationRegistry,
  InputIntegration,
  OutputIntegration,
} from "../../integrations/_base/types.js";

/**
 * Loads all integrations listed in family.yaml under integrations.active.
 * Each integration module must export a default class that implements
 * InputIntegration or OutputIntegration (or both).
 *
 * Integration modules are resolved from:
 *   integrations/inputs/<id>/index.ts
 *   integrations/outputs/<id>/index.ts
 */
const INTEGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "integrations");

/**
 * An integration is "absent" (not an input, or not an output) only if its module
 * file doesn't exist. Any other problem, such as a failed health check or an import
 * error, is recorded in registry.failures instead of being swallowed.
 */
export async function loadRegisteredIntegrations(
  config: FamilyConfig
): Promise<IntegrationRegistry> {
  const registry: IntegrationRegistry = {
    inputs: new Map(),
    outputs: new Map(),
    failures: [],
  };

  for (const id of config.integrations.active) {
    let found = false;
    for (const kind of ["inputs", "outputs"] as const) {
      if (!existsSync(join(INTEGRATIONS_DIR, kind, id, "index.ts"))) continue;
      found = true;
      try {
        const mod = await import(`../../integrations/${kind}/${id}/index.js`);
        const integration = new mod.default();
        await integration.healthCheck();
        if (kind === "inputs") registry.inputs.set(id, integration as InputIntegration);
        else registry.outputs.set(id, integration as OutputIntegration);
        console.log(`  ✓ ${kind === "inputs" ? "Input" : "Output"} integration loaded: ${id}`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        registry.failures.push({ id, kind: kind === "inputs" ? "input" : "output", error });
        console.error(`  ✗ ${id} (${kind.slice(0, -1)}) failed to load: ${error}`);
      }
    }
    if (!found) {
      registry.failures.push({ id, kind: "unknown", error: `No integration module at integrations/{inputs,outputs}/${id}/` });
      console.error(`  ✗ ${id}: no such integration (check integrations.active in family.yaml)`);
    }
  }

  return registry;
}
