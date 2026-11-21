# Outputs

An output is somewhere the hub shows up. **Screens** pull the [stream](stream.md) and rotate
through its cards. **Apps** are served by the hub and are interactive. **Pushes** write part
of the plan to another service.

| Output | Kind | Where | Setup |
|--------|------|-------|-------|
| [`hub-page`](#hub-page) | Screen | A wall tablet, or any browser | Comes with the hub |
| [`phone-widget`](#phone-widget) | Screen | iPhone home and lock screens | [`app/widgets/`](../app/widgets/README.md) |
| [`mac-menu-bar`](#mac-menu-bar) | Screen | The Mac menu bar | [`app/macos/`](../app/macos/README.md) |
| [`roku`](#roku) | Screen | A TV: channel and screensaver | [`app/roku/`](../app/roku/README.md) |
| [`tizen-tv`](#tizen-tv) | Screen | A Samsung TV: an app | [`app/tizen/`](../app/tizen/README.md) |
| [`trip-apps`](#trip-apps) | App | Phones, offline | [trip-apps.md](trip-apps.md) |
| [`google-calendar`](#google-calendar) | Push | Event descriptions in Google Calendar | Below |
| [`grocery-email`](#grocery-email) | Push | An email of the shopping list | Below |

Screens work as soon as the hub is deployed. List one in `family.yaml` only to change what
it shows. Pushes are off until you list them.

```yaml
# family.yaml
outputs:
  roku:
    stream: { photosBetween: 3, dwell: 10 }
  google-calendar: {}
  grocery-email:
    url: "https://script.google.com/macros/s/…/exec"
```

## What each screen shows

Every screen can show every component, because every card has a
[glance](stream.md#the-card-contract). The table says how each screen draws each one:
**full** means its own layout for that component, and **glance** means the headline, detail
line, and photo.

| Component | Hub page | Roku, Samsung TV | Mac panel | Widget (medium, large) | Widget (small, lock screen) |
|-----------|----------|------|-----------|------------------------|-----------------------------|
| `today` | full | full | full | full | full |
| `week` | full, interactive | glance | glance | glance | – |
| `plan` | full | glance | glance | glance | – |
| `pets` | glance, links to `/household/` | glance | glance | glance | – |
| `house` | glance, links to `/household/` | glance | glance | glance | – |
| `chores` | full: a column per kid, tap a chore to tick it | glance | glance | glance | – |
| `pet-portraits` | full: the pet full screen over its photo | full | glance | glance | – |
| `photos` | full | full | full | full | – |
| `trips` | full | full | full | full | glance |
| `past-trips` | full | full | glance | glance | – |
| `grocery` | full, editable | full | full | full | glance |
| `escape-rooms` | full: a picture for each room | glance, with the room's picture | glance | glance | – |
| `movies` | full: posters, tap a dot to mark who wants to see or saw it | glance, with the poster | glance | glance | – |
| `workouts` | full | glance | glance | glance | – |

The smallest widgets have room for one thing, so they stay on `today` unless you point them
at another component.

## hub-page

The hub's home page, at your hub's address. It's built for a wall-mounted tablet and works
on phones and laptops.

- **On the wall** it rotates through the stream, one card at a time, each drawn full screen.
- **Tap anything** and rotation stops. Every component has a full view: the calendar scrolls
  by day and by fortnight, the grocery list takes new items, a trip card opens its trip app.
  Tap a person to see only their day. Rotation resumes after two idle minutes.
- **It keeps itself fresh.** It reloads the stream as it rotates and picks up a new deploy
  on its own.

It must keep working on an old Android WebView (Chrome 80 to 86), which is what cheap wall
tablets ship with. See [wall-tablet.md](wall-tablet.md) for kiosk setup.

**On a phone's home screen** it runs like an app: full screen, with its own icon, and the
household page opens inside it. In Safari, tap Share, then Add to Home Screen. The build
writes `manifest.webmanifest` named for the family (`hub.title`, and `hub.shortTitle` for
the name under the icon) and the icons are in `app/public/icons/`. A family can use its own
by putting `manifest.webmanifest` or `icons/hub-180.png`, `hub-192.png` and `hub-512.png` in
its repo's `public/`. A phone picks up a new icon or name only when it's added again.

## phone-widget

Home-screen and lock-screen widgets, running in [Scriptable](https://scriptable.app), so
there's no Xcode and no developer account. Each widget takes a view (one person, or
`family`) and optionally the components to show. A home-screen widget shows one card per
refresh and steps through the stream. Lock-screen widgets show `today`.

## mac-menu-bar

A menu bar app. The menu bar itself shows a card's headline ("in 25m · Soccer practice",
"🏖️ 12d") and can step through the stream. Clicking it opens a panel that rotates the cards.

## roku

A Roku channel that doubles as a screensaver. As a screensaver it's the stream with
`photosBetween: 3` by default: a hub card, three photos, the next hub card, three more
photos. It drifts slowly so nothing burns in. It's sideloaded in developer mode, so it's
private to your Roku and never goes through the Channel Store.

## tizen-tv

A Samsung TV app that rotates the stream the way the Roku does, with three photos between
cards by default. It's installed in the TV's developer mode with one command per TV. Tizen
doesn't allow third-party screensavers, so it runs as an app.

## trip-apps

Phone pages for a trip, usable offline: the schedule, quests with a family leaderboard,
packing lists, and tips. They're interactive, so they're an input as well: check-ins feed the
leaderboard on every trip card.

## google-calendar

After planning, writes Claude's notes for an event (driving time, what to bring, a conflict)
into that event's description, and adds high-priority action items that have due dates as
events. Each calendar must be shared with the service account with **Make changes to events**.

## grocery-email

Emails the shopping list from the hub page's grocery view. It sends through a Google Apps
Script that you deploy from your own account:
[`app/extras/grocery-email.gs`](../app/extras/grocery-email.gs). Anyone with the script's URL
can send mail as you, which is another reason your hub repo is private.

## Giving a screen its key

A widget, a Mac app, or a Roku can't sign in the way a browser does. Each gets a Cloudflare
Access **service token** that can read the stream and nothing else:

1. **Create a token per device** (Zero Trust → Access → Service credentials → Service
   Tokens). One each means you can revoke a lost phone on its own.
2. **Create a policy** named `Hub Screens` with the action **Service Auth**, including
   those tokens.
3. **Create a path-scoped application** for your hub's domain with the path `api/stream`.
   Attach `Hub Screens` only. Cloudflare applies the most specific application, so this one
   governs only `/api/stream`. Don't add screen tokens to your hub's main application.

The hub page reads the same stream at `/api/page/stream`, which stays under your hub's main
application and family sign-in. Access gives each application its own sign-in, so a browser
signed in to the hub can't fetch through the screens' application.

If the policy says "Used by applications: 0", it isn't attached yet, and screens will report
that the hub didn't accept their token.

## Adding an output

A new screen is a client of one endpoint. See [contributing.md](contributing.md#adding-an-output).
