/**
 * Abstract base class providing common helpers for all integrations.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

const SECRETS_PATH = join(process.cwd(), "workspace", "state", "secrets.yaml");

export abstract class BaseIntegration {
  abstract readonly id: string;
  abstract readonly displayName: string;

  abstract healthCheck(): Promise<void>;

  /**
   * Load this integration's secrets from workspace/state/secrets.yaml.
   * Returns the object at the key matching this integration's ID.
   */
  protected loadSecrets<T = Record<string, string>>(): T {
    if (!existsSync(SECRETS_PATH)) {
      throw new Error(
        `workspace/state/secrets.yaml not found. ` +
          `Create it from workspace/state/secrets.example.yaml.`
      );
    }
    const all = yaml.load(readFileSync(SECRETS_PATH, "utf8")) as Record<string, unknown>;
    const secrets = all[this.id];
    if (!secrets) {
      throw new Error(
        `No secrets found for integration "${this.id}" in workspace/state/secrets.yaml.`
      );
    }
    return secrets as T;
  }

  /**
   * Assert that all required secret keys are present.
   */
  protected requireSecretKeys(secrets: Record<string, unknown>, keys: string[]): void {
    const missing = keys.filter((k) => !secrets[k]);
    if (missing.length > 0) {
      throw new Error(
        `Integration "${this.id}" is missing required secrets: ${missing.join(", ")}`
      );
    }
  }
}
