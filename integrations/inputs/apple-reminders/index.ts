/**
 * Apple Reminders — Input Integration
 *
 * Reads reminders from Apple Reminders via AppleScript (macOS only).
 * Converts reminders into context items (todos) for the planner.
 *
 * No secrets required — uses native macOS Reminders access.
 * Grant access when macOS prompts for Reminders permission.
 *
 * Setup: see integrations/inputs/apple-reminders/README.md
 */

import { exec } from "child_process";
import { promisify } from "util";
import { BaseIntegration } from "../../_base/BaseIntegration.js";
import type { InputIntegration, ContextItem } from "../../_base/types.js";

const execAsync = promisify(exec);

export default class AppleRemindersInput extends BaseIntegration implements InputIntegration {
  readonly id = "apple-reminders";
  readonly displayName = "Apple Reminders";

  private cursor: string = new Date(0).toISOString();

  async healthCheck(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("Apple Reminders integration is only available on macOS.");
    }
    // Quick smoke test — list reminder lists
    await execAsync(`osascript -e 'tell application "Reminders" to count every list'`);
  }

  async fetchContextItems(since?: string): Promise<ContextItem[]> {
    if (since) this.cursor = since;
    const sinceDate = new Date(this.cursor);

    const script = `
      tell application "Reminders"
        set output to ""
        repeat with aList in every list
          repeat with aReminder in every reminder of aList
            if (not completed of aReminder) then
              set output to output & name of aReminder & "\\n"
            end if
          end repeat
        end repeat
        return output
      end tell
    `;

    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    const now = new Date().toISOString();

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((title, i) => ({
        id: `apple-reminders:${Date.now()}-${i}`,
        type: "todo" as const,
        content: title,
        createdAt: now,
        consumed: false,
      }));
  }

  getCursor(): string {
    return this.cursor;
  }
}
