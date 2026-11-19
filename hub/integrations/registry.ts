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
 * Loads the inputs and outputs the family turned on (config.pipeline, worked
 * out by the loader from family.yaml). Each module exports a default class
 * implementing InputIntegration or OutputIntegration, at:
 *
 *   integrations/inputs/<id>/index.ts
 *   integrations/outputs/<id>/index.ts
 *
 * Some ids name things the pipeline doesn't run: screens, and inputs the hub
 * Worker reads itself (the photo album, trips, the grocery list). Those are
 * skipped. Any other id without a module is reported as a failure.
 */
const INTEGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "integrations");

/** Ids in family.yaml that the hub Worker or a screen handles, not the pipeline. */
export const NOT_PIPELINE = new Set([
  "icloud-album", "trips", "trip-apps", "grocery", "escape-rooms", "movies", "notes",
  "hub-page", "phone-widget", "mac-menu-bar", "roku", "grocery-email",
]);

export async function loadRegisteredIntegrations(
  config: FamilyConfig
): Promise<IntegrationRegistry> {
  const registry: IntegrationRegistry = {
    inputs: new Map(),
    outputs: new Map(),
    failures: [],
  };
  const legacy = new Set(config.integrations?.active ?? []);
  const wanted: Array<[string, "inputs" | "outputs"]> = [
    ...config.pipeline.inputs.map(id => [id, "inputs"] as [string, "inputs"]),
    ...config.pipeline.outputs.map(id => [id, "outputs"] as [string, "outputs"]),
  ];
  const found = new Set<string>();

  for (const [id, kind] of wanted) {
    if (NOT_PIPELINE.has(id)) continue;
    if (!existsSync(join(INTEGRATIONS_DIR, kind, id, "index.ts"))) {
      // An integrations.active id only needs one of the two.
      if (!legacy.has(id)) {
        registry.failures.push({ id, kind: kind === "inputs" ? "input" : "output", error: `No ${kind.slice(0, -1)} module at integrations/${kind}/${id}/` });
        console.error(`  ✗ ${id}: no such ${kind.slice(0, -1)} (check family.yaml)`);
      }
      continue;
    }
    found.add(id);
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
  for (const id of legacy) {
    if (!found.has(id) && !NOT_PIPELINE.has(id)) {
      registry.failures.push({ id, kind: "unknown", error: `No integration module at integrations/{inputs,outputs}/${id}/` });
      console.error(`  ✗ ${id}: no such integration (check integrations.active in family.yaml)`);
    }
  }

  return registry;
}
