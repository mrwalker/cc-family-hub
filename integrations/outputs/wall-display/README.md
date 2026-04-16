# Wall Display — Output Integration

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
