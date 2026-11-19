# Web Portal — Output Integration

> **Retired.** The [hub app](../../../docs/outputs.md#hub-page) replaced this output, and it will be
> removed in v1.0. See [docs/roadmap.md](../../../docs/roadmap.md). This page is kept for families still using it.

Writes plan data as static JSON files to `outputs/web-portal/public/data/`, which a local web app reads to render the family dashboard.

## Setup

No credentials required. The integration writes files locally.

### 1. Activate

In `workspace/family.yaml`:

```yaml
integrations:
  active:
    - web-portal
```

### 2. Start the Portal (Optional)

```bash
cd outputs/web-portal
npm install
npm run dev
```

Open `http://localhost:5173` to see the dashboard.

## Data Files Written

| File | Contents |
|------|----------|
| `public/data/plan.json` | Full WeeklyPlan object |
| `public/data/shopping.json` | Shopping list items |

## Notes

The web portal app (`outputs/web-portal/`) is a separate frontend project — it just reads the JSON files the integration writes. See `outputs/web-portal/README.md` for the frontend setup.
