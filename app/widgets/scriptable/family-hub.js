// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: home;

/**
 * Family Hub widget for Scriptable (https://scriptable.app).
 *
 * Shows upcoming events (rest of today + tomorrow, from your family's live
 * calendars) and a countdown to the next trip, from your hub's /api/widget.
 * Works as a small, medium, or large home-screen widget and as a lock-screen
 * widget (rectangular, inline, circular).
 *
 * Setup: see app/widgets/README.md in cc-family-hub. In short:
 *   1. Run this script once in Scriptable and enter your hub URL and a
 *      Cloudflare Access service token (stored in the iOS Keychain).
 *   2. Add a Scriptable widget, choose this script, and set Parameter to a
 *      member id (e.g. "alex") for their events, or "family" for everyone's.
 */

const KEYCHAIN = "family-hub";
const REFRESH_MINUTES = 15;

// ─── Style (matches the hub page) ─────────────────────────────────────────────

const dyn = (light, dark) => (Color.dynamic ? Color.dynamic(light, dark) : dark);
const BG = dyn(new Color("#f2f2ef"), new Color("#08090c"));
const CARD = dyn(new Color("#ffffff"), new Color("#ffffff", 0.06));
const TEXT = dyn(new Color("#0b0d10"), new Color("#f3f5f7"));
const MUTED = dyn(new Color("#0b0d10", 0.56), new Color("#f3f5f7", 0.55));
const ACCENT = dyn(new Color("#0369a1"), new Color("#7dd3fc"));

function font(name, size) {
  return typeof Font[name] === "function" ? Font[name](size) : Font.systemFont(size);
}
const F = {
  label: () => font("mediumMonospacedSystemFont", 10),
  time: () => font("mediumMonospacedSystemFont", 11),
  title: s => font("semiboldSystemFont", s),
  body: s => font("systemFont", s),
  big: s => font("boldRoundedSystemFont", s),
};

// ─── Settings ─────────────────────────────────────────────────────────────────

function readSettings() {
  const get = k => (Keychain.contains(`${KEYCHAIN}.${k}`) ? Keychain.get(`${KEYCHAIN}.${k}`) : "");
  const s = { url: get("url"), clientId: get("clientId"), clientSecret: get("clientSecret") };
  return s.url ? s : null;
}

async function askSettings(current) {
  const a = new Alert();
  a.title = "Family Hub sign-in";
  a.message =
    "Your hub's URL, plus the Cloudflare Access service token made for widgets " +
    "(leave both token fields empty if your hub isn't behind Access).";
  a.addTextField("https://hub.example.com", current?.url || "");
  a.addTextField("Client ID (….access)", current?.clientId || "");
  a.addSecureTextField("Client Secret", current?.clientSecret || "");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  if ((await a.presentAlert()) === -1) return null;
  const url = a.textFieldValue(0).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new Error("The hub URL must start with https://");
  Keychain.set(`${KEYCHAIN}.url`, url);
  Keychain.set(`${KEYCHAIN}.clientId`, a.textFieldValue(1).trim());
  Keychain.set(`${KEYCHAIN}.clientSecret`, a.textFieldValue(2).trim());
  return readSettings();
}

// ─── Data ─────────────────────────────────────────────────────────────────────

function cachePath(view) {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), `family-hub-widget-${view.replace(/[^a-z0-9-]/gi, "")}.json`);
}

async function loadData(settings, view) {
  const fm = FileManager.local();
  const path = cachePath(view);
  try {
    const req = new Request(`${settings.url}/api/widget?view=${encodeURIComponent(view)}`);
    req.timeoutInterval = 20;
    req.headers = settings.clientId
      ? { "CF-Access-Client-Id": settings.clientId, "CF-Access-Client-Secret": settings.clientSecret }
      : {};
    const text = await req.loadString();
    const status = req.response?.statusCode;
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* handled below */ }
    if (status === 200 && data && Array.isArray(data.events)) {
      fm.writeString(path, text);
      return { data, stale: false };
    }
    if (data?.error) throw new Error(data.error);
    if (status === 401 || status === 403 || /cloudflareaccess|<html/i.test(text)) {
      throw new Error("The hub didn't accept this widget's service token. Run the script in Scriptable to re-enter it.");
    }
    throw new Error(`The hub answered ${status ?? "?"}`);
  } catch (err) {
    if (fm.fileExists(path)) {
      return { data: JSON.parse(fm.readString(path)), stale: true, error: err.message };
    }
    throw err;
  }
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

function label(stack, text, color = MUTED) {
  const t = stack.addText(text.toUpperCase());
  t.font = F.label();
  t.textColor = color;
  t.lineLimit = 1;
  return t;
}

function dots(stack, colors, size = 6) {
  const row = stack.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  colors.slice(0, 6).forEach((hex, i) => {
    if (i) row.addSpacer(2);
    const d = row.addStack();
    d.size = new Size(size, size);
    d.cornerRadius = size / 2;
    d.backgroundColor = new Color(hex);
  });
  return row;
}

function bar(stack, colors, height) {
  const b = stack.addStack();
  b.layoutVertically();
  const each = Math.max(2, Math.floor(height / Math.max(1, colors.length)));
  for (const hex of (colors.length ? colors : ["#888888"]).slice(0, 4)) {
    const seg = b.addStack();
    seg.size = new Size(3, each);
    seg.backgroundColor = new Color(hex);
  }
  b.cornerRadius = 1.5;
  return b;
}

function eventRow(stack, e, { titleSize = 13, timeWidth = 58 } = {}) {
  const row = stack.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  bar(row, e.colors, 15);
  row.addSpacer(6);
  const time = row.addStack();
  time.size = new Size(timeWidth, 0);
  const tt = time.addText(e.time);
  tt.font = F.time();
  tt.textColor = MUTED;
  tt.lineLimit = 1;
  tt.minimumScaleFactor = 0.8;
  row.addSpacer(2);
  const title = row.addText(e.title);
  title.font = F.body(titleSize);
  title.textColor = TEXT;
  title.lineLimit = 1;
  row.addSpacer();
  return row;
}

/** Events under "Today"/"Tomorrow" headings; returns how many were shown. */
function eventList(stack, events, max, opts) {
  let shown = 0;
  let day = null;
  for (const e of events.slice(0, max)) {
    if (e.day !== day) {
      if (day !== null) stack.addSpacer(5);
      label(stack, e.day);
      stack.addSpacer(3);
      day = e.day;
    } else {
      stack.addSpacer(4);
    }
    eventRow(stack, e, opts);
    shown++;
  }
  return shown;
}

/** The next timed event (all-day items like "Trash" aren't "next"), else the first event. */
function nextUp(events) {
  return events.find(e => !e.allDay) || events[0];
}

function tripText(trip) {
  if (!trip) return null;
  if (trip.status === "active") return `${trip.name} · day ${trip.day} of ${trip.days}`;
  if (trip.daysUntil === 1) return `${trip.name} tomorrow`;
  return `${trip.name} in ${trip.daysUntil} days`;
}

function tripCard(stack, trip, { big = 34 } = {}) {
  const card = stack.addStack();
  card.layoutVertically();
  card.backgroundColor = CARD;
  card.cornerRadius = 12;
  card.setPadding(8, 10, 8, 10);
  card.url = trip.url;
  label(card, trip.status === "active" ? "On the trip" : "Next trip", ACCENT);
  card.addSpacer(2);
  const n = card.addText(trip.status === "active" ? `Day ${trip.day}` : String(trip.daysUntil));
  n.font = F.big(big);
  n.textColor = TEXT;
  n.minimumScaleFactor = 0.6;
  n.lineLimit = 1;
  const unit = card.addText(
    trip.status === "active" ? `of ${trip.days}` : trip.daysUntil === 1 ? "day to go" : "days to go"
  );
  unit.font = F.body(11);
  unit.textColor = MUTED;
  card.addSpacer(4);
  const name = card.addText(`${trip.emoji ? trip.emoji + " " : ""}${trip.name}`);
  name.font = F.title(12);
  name.textColor = TEXT;
  name.lineLimit = 2;
  name.minimumScaleFactor = 0.8;
  return card;
}

function header(stack, data, right) {
  const h = stack.addStack();
  h.layoutHorizontally();
  h.centerAlignContent();
  label(h, data.view ? data.view.name : "Family", data.view ? new Color(data.view.color) : ACCENT);
  h.addSpacer();
  if (right) label(h, right);
  return h;
}

function staleNote(stack, result) {
  if (!result.stale) return;
  stack.addSpacer(2);
  const when = new Date(result.data.generatedAt);
  const t = stack.addText(`Offline · as of ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  t.font = F.label();
  t.textColor = MUTED;
}

// ─── Layouts ──────────────────────────────────────────────────────────────────

function small(w, result) {
  const { data } = result;
  const next = nextUp(data.events);
  header(w, data);
  w.addSpacer(6);
  if (next) {
    const time = w.addText(next.day === "Today" ? next.time : `${next.day} ${next.time}`);
    time.font = F.title(15);
    time.textColor = ACCENT;
    time.lineLimit = 1;
    time.minimumScaleFactor = 0.7;
    w.addSpacer(2);
    const title = w.addText(next.title);
    title.font = F.title(16);
    title.textColor = TEXT;
    title.lineLimit = 3;
    title.minimumScaleFactor = 0.8;
    w.addSpacer(4);
    dots(w, next.colors);
    w.addSpacer();
    const rest = data.events.length - 1;
    const foot = data.nextTrip ? tripText(data.nextTrip) : rest > 0 ? `+${rest} more` : null;
    if (foot) {
      const f = w.addText(foot);
      f.font = F.body(11);
      f.textColor = MUTED;
      f.lineLimit = 1;
      f.minimumScaleFactor = 0.7;
    }
  } else if (data.nextTrip) {
    w.addSpacer();
    tripCard(w, data.nextTrip, { big: 40 });
    w.addSpacer();
  } else {
    w.addSpacer();
    const t = w.addText("Nothing else today or tomorrow");
    t.font = F.body(13);
    t.textColor = MUTED;
    w.addSpacer();
  }
  staleNote(w, result);
}

function medium(w, result) {
  const { data } = result;
  const row = w.addStack();
  row.layoutHorizontally();
  const left = row.addStack();
  left.layoutVertically();
  header(left, data, data.nextTrip ? null : "Upcoming");
  left.addSpacer(6);
  const max = data.nextTrip ? 4 : 5;
  if (data.events.length) {
    eventList(left, data.events, max, { titleSize: 12, timeWidth: 54 });
  } else {
    const t = left.addText("Nothing else today or tomorrow");
    t.font = F.body(13);
    t.textColor = MUTED;
  }
  left.addSpacer();
  staleNote(left, result);
  if (data.nextTrip) {
    row.addSpacer(10);
    const right = row.addStack();
    right.layoutVertically();
    right.size = new Size(104, 0);
    tripCard(right, data.nextTrip);
    right.addSpacer();
  }
}

function large(w, result) {
  const { data } = result;
  header(w, data, "Upcoming");
  w.addSpacer(8);
  if (data.events.length) {
    const shown = eventList(w, data.events, 10, { titleSize: 14, timeWidth: 62 });
    const more = data.events.length - shown + (data.moreEvents || 0);
    if (more > 0) {
      w.addSpacer(4);
      const m = w.addText(`+${more} more`);
      m.font = F.body(12);
      m.textColor = MUTED;
    }
  } else {
    const t = w.addText("Nothing else today or tomorrow");
    t.font = F.body(14);
    t.textColor = MUTED;
  }
  w.addSpacer();
  if (data.nextTrip) {
    const t = data.nextTrip;
    const foot = w.addStack();
    foot.layoutHorizontally();
    foot.centerAlignContent();
    foot.backgroundColor = CARD;
    foot.cornerRadius = 12;
    foot.setPadding(8, 12, 8, 12);
    foot.url = t.url;
    const n = foot.addText(t.status === "active" ? `Day ${t.day}` : String(t.daysUntil));
    n.font = F.big(26);
    n.textColor = TEXT;
    foot.addSpacer(10);
    const col = foot.addStack();
    col.layoutVertically();
    label(col, t.status === "active" ? `On the trip · of ${t.days}` : t.daysUntil === 1 ? "Day to go" : "Days to go", ACCENT);
    const name = col.addText(`${t.emoji ? t.emoji + " " : ""}${t.name}`);
    name.font = F.title(14);
    name.textColor = TEXT;
    name.lineLimit = 1;
    foot.addSpacer();
  }
  staleNote(w, result);
}

function rectangular(w, result) {
  const { data } = result;
  const next = nextUp(data.events);
  if (next) {
    const t = w.addText(`${next.day === "Today" ? "" : next.day + " "}${next.time}`);
    t.font = F.title(13);
    t.lineLimit = 1;
    const title = w.addText(next.title);
    title.font = F.body(13);
    title.lineLimit = 1;
  }
  const trip = tripText(data.nextTrip);
  if (trip) {
    const tt = w.addText(trip);
    tt.font = F.body(12);
    tt.textOpacity = 0.7;
    tt.lineLimit = 1;
  }
  if (!next && !trip) w.addText("Nothing coming up");
}

function inline(w, result) {
  const { data } = result;
  const next = nextUp(data.events);
  const trip = data.nextTrip;
  if (next) w.addText(`${next.day === "Today" ? "" : next.day + " "}${next.time} ${next.title}`);
  else if (trip) w.addText(tripText(trip));
  else w.addText("Nothing coming up");
}

function circular(w, result) {
  const { data } = result;
  w.addAccessoryWidgetBackground = true;
  const trip = data.nextTrip;
  const top = w.addText(trip ? (trip.status === "active" ? String(trip.day) : String(trip.daysUntil)) : String(data.events.length));
  top.font = F.big(22);
  top.centerAlignText();
  top.minimumScaleFactor = 0.6;
  const sub = w.addText(trip ? (trip.status === "active" ? "DAY" : "DAYS") : "NEXT");
  sub.font = F.label();
  sub.centerAlignText();
}

const LAYOUTS = {
  small, medium, large, extraLarge: large,
  accessoryRectangular: rectangular, accessoryInline: inline, accessoryCircular: circular,
};

function errorWidget(w, message) {
  label(w, "Family Hub", ACCENT);
  w.addSpacer(4);
  const t = w.addText(message);
  t.font = F.body(12);
  t.textColor = TEXT;
  t.minimumScaleFactor = 0.7;
}

async function buildWidget(family, view, settings) {
  const w = new ListWidget();
  const accessory = family.startsWith("accessory");
  if (!accessory) {
    w.backgroundColor = BG;
    w.setPadding(12, 14, 12, 14);
  }
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60_000);
  if (!settings) {
    errorWidget(w, "Open this script in Scriptable to sign in to your hub.");
    return w;
  }
  try {
    const result = await loadData(settings, view);
    w.url = result.data.hubUrl;
    (LAYOUTS[family] || medium)(w, result);
  } catch (err) {
    errorWidget(w, err.message);
  }
  return w;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  let settings = readSettings();
  const view = ((args.widgetParameter || "family") + "").trim().toLowerCase() || "family";

  if (config.runsInWidget) {
    Script.setWidget(await buildWidget(config.widgetFamily || "medium", view, settings));
    return;
  }

  if (!settings) settings = await askSettings(null);
  if (!settings) return;

  const menu = new Alert();
  menu.title = "Family Hub widget";
  menu.message = "Preview a size, or change the hub sign-in. Preview view (a member id or \"family\"):";
  menu.addTextField("family", "family");
  for (const size of ["Small", "Medium", "Large"]) menu.addAction(`Preview ${size}`);
  menu.addAction("Change hub sign-in");
  menu.addCancelAction("Done");
  const choice = await menu.presentAlert();
  if (choice === -1) return;
  if (choice === 3) {
    await askSettings(settings);
    return;
  }
  const previewView = menu.textFieldValue(0).trim().toLowerCase() || "family";
  const family = ["small", "medium", "large"][choice];
  const w = await buildWidget(family, previewView, settings);
  if (family === "small") await w.presentSmall();
  else if (family === "medium") await w.presentMedium();
  else await w.presentLarge();
}

await main();
Script.complete();
