/**
 * Web Portal — Output Integration
 *
 * Writes the weekly plan as a static JSON file that the web portal
 * reads on page load. The portal itself is a separate app in outputs/web-portal/app/.
 *
 * No credentials required — writes to a local directory that the portal serves.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { BaseIntegration } from "../../_base/BaseIntegration.js";
import type { OutputIntegration, WeeklyPlan, ShoppingItem } from "../../_base/types.js";

const PORTAL_DATA_DIR = join(process.cwd(), "outputs", "web-portal", "public", "data");

export default class WebPortalOutput extends BaseIntegration implements OutputIntegration {
  readonly id = "web-portal";
  readonly displayName = "Web Portal";

  async healthCheck(): Promise<void> {
    mkdirSync(PORTAL_DATA_DIR, { recursive: true });
  }

  async publishPlan(plan: WeeklyPlan): Promise<void> {
    mkdirSync(PORTAL_DATA_DIR, { recursive: true });
    writeFileSync(
      join(PORTAL_DATA_DIR, "plan.json"),
      JSON.stringify(plan, null, 2),
      "utf8"
    );
    console.log(`  Web portal plan written to outputs/web-portal/public/data/plan.json`);
  }

  async publishShoppingList(items: ShoppingItem[]): Promise<void> {
    mkdirSync(PORTAL_DATA_DIR, { recursive: true });
    writeFileSync(
      join(PORTAL_DATA_DIR, "shopping.json"),
      JSON.stringify(items, null, 2),
      "utf8"
    );
  }
}
