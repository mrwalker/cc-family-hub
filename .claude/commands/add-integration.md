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
   - Required entries in `secrets.yaml`
   - Any platform requirements (e.g., macOS only)

5. Add it to `docs/inputs.md` or `docs/outputs.md`, and its secrets to
   `workspace.example/state/secrets.example.yaml`.

6. Show the user what was created and remind them to:
   - Turn it on in `workspace/family.yaml`, under `inputs:` or `outputs:`
   - Add any required secrets to `secrets.yaml` in `HUB_SECRETS_DIR`

## Reference

Look at `integrations/inputs/google-calendar/index.ts` for a full input example.
Look at `integrations/outputs/google-calendar/index.ts` for a full output example.

If what you're adding should show on screens, it also needs a stream component: see
`docs/contributing.md#adding-a-component`.
The type interfaces are in `integrations/_base/types.ts`.
