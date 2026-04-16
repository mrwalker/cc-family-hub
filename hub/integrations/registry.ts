/**
 * Integration registry — dynamically loads and instantiates all active
 * integrations based on what's configured in workspace/family.yaml.
 */

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
export async function loadRegisteredIntegrations(
  config: FamilyConfig
): Promise<IntegrationRegistry> {
  const registry: IntegrationRegistry = {
    inputs: new Map(),
    outputs: new Map(),
  };

  for (const id of config.integrations.active) {
    // Try input
    try {
      const mod = await import(`../../integrations/inputs/${id}/index.js`);
      if (mod.default) {
        const integration = new mod.default() as InputIntegration;
        await integration.healthCheck();
        registry.inputs.set(id, integration);
        console.log(`  ✓ Input integration loaded: ${id}`);
      }
    } catch {
      // Not an input integration or not yet implemented — that's fine
    }

    // Try output
    try {
      const mod = await import(`../../integrations/outputs/${id}/index.js`);
      if (mod.default) {
        const integration = new mod.default() as OutputIntegration;
        await integration.healthCheck();
        registry.outputs.set(id, integration);
        console.log(`  ✓ Output integration loaded: ${id}`);
      }
    } catch {
      // Not an output integration or not yet implemented — that's fine
    }
  }

  return registry;
}
