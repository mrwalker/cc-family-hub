# Contributing

## Adding a New Integration

1. Choose a kebab-case ID (e.g. `notion`, `todoist`, `slack`)
2. Create the directory: `integrations/inputs/<id>/` and/or `integrations/outputs/<id>/`
3. Implement the interface (see below)
4. Write a `README.md` in the integration directory
5. Add secrets documentation to the README and `workspace.example/state/secrets.example.yaml`

### Input Integration Skeleton

```typescript
// integrations/inputs/my-service/index.ts
import { BaseIntegration } from "../../_base/BaseIntegration.js";
import type { InputIntegration, CalendarEvent, ContextItem } from "../../_base/types.js";

export default class MyServiceInput extends BaseIntegration implements InputIntegration {
  readonly id = "my-service";
  readonly displayName = "My Service";

  async healthCheck(): Promise<void> {
    const secrets = this.loadSecrets();
    this.requireSecretKeys(secrets, ["apiKey"]);
    // TODO: verify connectivity
  }

  async fetchEvents(startDate: string, endDate: string): Promise<CalendarEvent[]> {
    // TODO: fetch and map to CalendarEvent[]
    return [];
  }
}
```

### Output Integration Skeleton

```typescript
// integrations/outputs/my-service/index.ts
import { BaseIntegration } from "../../_base/BaseIntegration.js";
import type { OutputIntegration, WeeklyPlan } from "../../_base/types.js";

export default class MyServiceOutput extends BaseIntegration implements OutputIntegration {
  readonly id = "my-service";
  readonly displayName = "My Service";

  async healthCheck(): Promise<void> {
    // TODO: verify connectivity
  }

  async publishPlan(plan: WeeklyPlan): Promise<void> {
    // TODO: send plan to this service
  }
}
```

## Changing Core Types

The types in `integrations/_base/types.ts` are the stable API surface. Changes there affect all integrations. When adding fields:
- Make new fields optional (`?`) unless you're sure all integrations can provide them
- Update `integrations/_base/schemas.ts` if the field needs validation
- Update `workspace.example/` to reflect the new schema

## Testing Changes

There's no formal test suite yet (the hub is inherently integration-heavy). Manual testing steps:
1. Copy `workspace.example/` to a temp workspace
2. Run `npm run build` to check TypeScript
3. Run `npm run sync` and verify calendar data is written correctly
4. Run `npm run plan` and inspect `workspace/state/last-plan.yaml`
