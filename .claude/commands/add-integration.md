# /add-integration

Scaffold a new input or output integration.

## Steps

1. Ask the user:
   - Integration name (kebab-case, e.g. `notion`, `slack`, `apple-calendar`)
   - Type: `input`, `output`, or `both`
   - What data it should provide or consume

2. Create the integration directory:
   - Input: `integrations/inputs/<name>/`
   - Output: `integrations/outputs/<name>/`

3. Create `integrations/<type>/<name>/index.ts` that:
   - Imports from `../../_base/BaseIntegration.js` and `../../_base/types.js`
   - Extends `BaseIntegration`
   - Implements `InputIntegration` and/or `OutputIntegration`
   - Includes a `loadSecrets()` call in `healthCheck()` if credentials are needed
   - Has `TODO` comments where the actual API calls need to be implemented

4. Create `integrations/<type>/<name>/README.md` that explains:
   - What the integration does
   - Setup steps (API keys, OAuth, etc.)
   - Required entries in `workspace/state/secrets.yaml`
   - Any platform requirements (e.g., macOS only)

5. Show the user what was created and remind them to:
   - Add the integration ID to `workspace/family.yaml` under `integrations.active`
   - Add any required secrets to `workspace/state/secrets.yaml`

## Reference

Look at `integrations/inputs/google-calendar/index.ts` for a full input example.
Look at `integrations/outputs/wall-display/index.ts` for a full output example.
The type interfaces are in `integrations/_base/types.ts`.
