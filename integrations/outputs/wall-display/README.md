# Wall Display — Output Integration

> **Retired.** The [hub app](../../../docs/outputs.md#hub-page) replaced this output, and it will be
> removed in v1.0. The Android app it pushes to was never written. To put the hub on a wall tablet, see
> [docs/wall-tablet.md](../../../docs/wall-tablet.md). See also [docs/roadmap.md](../../../docs/roadmap.md). This page is kept for families still using it.

Pushes plan updates to a wall-mounted Android tablet running the Family Hub Display app over local Wi-Fi.

## Setup

### 1. Install the Display App

Install the Family Hub Display app on the Android tablet. (App source: `outputs/wall-display/android/` — coming soon.)

### 2. Configure the App

In the app settings:
- Set a strong API key
- Note the tablet's local IP address (Settings → About → IP Address)

### 3. Configure Secrets

Add to `workspace/state/secrets.yaml`:

```yaml
wall-display:
  deviceUrl: "http://192.168.1.100:8080"    # Tablet's local IP
  apiKey: "your-strong-api-key"
```

### 4. Activate

In `workspace/family.yaml`:

```yaml
integrations:
  active:
    - wall-display
```

## What Gets Displayed

- Weekly plan view (scrollable, day-by-day)
- Upcoming events for the next 48 hours
- Shopping list
- Active flags/alerts

## Troubleshooting

**Integration unreachable** — verify the tablet is on the same Wi-Fi network and that the IP address is correct. Android may assign a new IP after a restart; consider reserving the IP in your router's DHCP settings.
