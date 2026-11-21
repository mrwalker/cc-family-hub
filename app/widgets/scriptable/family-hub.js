// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: home;

/**
 * Family Hub widget for Scriptable (https://scriptable.app).
 *
 * Shows one card from your hub's stream (docs/stream.md) per refresh, and steps
 * to the next card each time iOS refreshes the widget. Reads
 * GET <hub>/api/stream?view=<view>&output=phone-widget[&components=a,b].
 * Works as a small, medium, or large home-screen widget and as a lock-screen
 * widget (rectangular, inline, circular).
 *
 * Setup: see app/widgets/README.md in cc-family-hub. In short:
 *   1. Run this script once in Scriptable and enter your hub URL and a
 *      Cloudflare Access service token (stored in the iOS Keychain).
 *   2. Add a Scriptable widget, choose this script, and set Parameter to
 *      "<view> [component …]", e.g. "family", "alex", "alex today",
 *      "family photos trips".
 *
 * Parameter:
 *   The first word that isn't a component is the view: a member id, or "family"
 *   (the default). Every other word is a component id (today, week, plan, photos,
 *   trips, past-trips, grocery, …). The older words still work: "mix" is the
 *   default stream, "photo(s)" is photos, "trip(s)" is trips.
 *   With no components named, medium and large widgets show the stream set for
 *   phone-widget; small widgets show today. Lock-screen widgets always show today.
 *
 * Drawing: today, photos, trips and grocery have their own layouts at medium and
 * large; today also at small and on the lock screen. Every other card (and any
 * component added later) is drawn from its glance: headline, detail, image,
 * emoji, colors.
 */

const KEYCHAIN = "family-hub";
const REFRESH_MINUTES = 15;
const OUTPUT_ID = "phone-widget";

/** Component ids the hub knows today. Used to tell the view from components in the Parameter. */
const KNOWN_COMPONENTS = [
  "today", "week", "plan", "pets", "house", "chores", "pet-portraits", "house-portraits", "photos", "trips", "past-trips", "grocery", "escape-rooms", "movies", "workouts",
];
/** Older Parameter words: "mix" was the rotating widget, which is now the default. */
const LEGACY_WORDS = { mix: null, photo: "photos", trip: "trips" };

// ─── Style (matches the hub page) ─────────────────────────────────────────────

const dyn = (light, dark) => (Color.dynamic ? Color.dynamic(light, dark) : dark);
const BG = dyn(new Color("#f2f2ef"), new Color("#08090c"));
const CARD = dyn(new Color("#ffffff"), new Color("#ffffff", 0.06));
const TEXT = dyn(new Color("#0b0d10"), new Color("#f3f5f7"));
const MUTED = dyn(new Color("#0b0d10", 0.56), new Color("#f3f5f7", 0.55));
const ACCENT = dyn(new Color("#0369a1"), new Color("#7dd3fc"));
const URGENT = dyn(new Color("#b91c1c"), new Color("#fca5a5"));

// Over images, text is always white.
const WHITE = new Color("#ffffff");
const WHITE_MUTED = new Color("#ffffff", 0.75);
const SKY = new Color("#7dd3fc");
const NIGHT = new Color("#08090c");

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

function authHeaders(settings) {
  return settings.clientId
    ? { "CF-Access-Client-Id": settings.clientId, "CF-Access-Client-Secret": settings.clientSecret }
    : {};
}

// ─── Parameter ────────────────────────────────────────────────────────────────

/**
 * "alex photos trips" → { view: "alex", components: ["photos", "trips"] }.
 * The first word that isn't a component or an older word is the view. Any other
 * word is passed to the hub as a component, so components added to the hub later
 * work too; the hub answers "Unknown component …" for a word it doesn't know.
 */
function parseParam(text) {
  const raw = String(text || "").trim();
  const words = raw.toLowerCase().split(/[\s,]+/).filter(Boolean);
  let view = null;
  const components = [];
  for (const word of words) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(word)) {
      return { raw, error: `"${word}" in the Parameter isn't a member id or a component. Use "<view> [component …]", e.g. "family photos trips".` };
    }
    let component = null;
    if (Object.prototype.hasOwnProperty.call(LEGACY_WORDS, word)) {
      component = LEGACY_WORDS[word];
      if (!component) continue; // "mix": the default stream
    } else if (KNOWN_COMPONENTS.includes(word)) {
      component = word;
    } else if (!view) {
      view = word;
      continue;
    } else {
      component = word;
    }
    if (!components.includes(component)) components.push(component);
  }
  return { raw, view: view || "family", components };
}

/** What this widget asks the hub for: lock screen and small default to today. */
function requestFor(param, family) {
  let components = param.components;
  if (family.startsWith("accessory")) components = ["today"];
  else if (family === "small" && !components.length) components = ["today"];
  const key = [param.view, ...components].join("-").replace(/[^a-z0-9_-]/g, "") || "family";
  return { view: param.view, components, key };
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const UPGRADE = "This hub has no /api/stream. Upgrade its cc-family-hub to v0.9.0 or later.";
const BAD_TOKEN =
  "The hub didn't accept this widget's service token. Run the script in Scriptable to re-enter it.";

function docPath(name) {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), name);
}

/** An error the hub reported about the request itself. Not hidden behind the offline cache. */
class HubError extends Error {}

/**
 * Fetches the stream. A network failure, a rejected token or a server error
 * falls back to the last stream fetched for this Parameter, marked stale.
 */
async function loadStream(settings, request, param) {
  const fm = FileManager.local();
  const path = docPath(`family-hub-stream-${request.key}.json`);
  const cached = err => {
    if (fm.fileExists(path)) {
      try {
        return { data: JSON.parse(fm.readString(path)), stale: true, error: err.message };
      } catch (_) { /* a bad cache file: report the original error */ }
    }
    throw err;
  };

  let url = `${settings.url}/api/stream?view=${encodeURIComponent(request.view)}&output=${OUTPUT_ID}`;
  if (request.components.length) url += `&components=${request.components.map(encodeURIComponent).join(",")}`;

  let text, status;
  try {
    const req = new Request(url);
    req.timeoutInterval = 20;
    req.headers = authHeaders(settings);
    text = await req.loadString();
    status = req.response?.statusCode;
  } catch (err) {
    return cached(new Error(`Couldn't reach the hub (${err.message || err})`));
  }

  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* handled below */ }
  if (status === 200 && data && Array.isArray(data.cards)) {
    fm.writeString(path, text);
    return { data, stale: false };
  }
  if (status === 401 || status === 403 || /cloudflareaccess/i.test(text || "")) return cached(new Error(BAD_TOKEN));
  if (status === 404) throw new HubError(UPGRADE);
  if (status === 400 && data?.error) {
    const where = param.raw ? `Parameter "${param.raw}": ` : "";
    throw new HubError(`${where}${data.error}`);
  }
  // A 200 that isn't the stream (an older hub serving its page here) is also a hub without the stream.
  if (status === 200 && /<html/i.test(text || "")) throw new HubError(UPGRADE);
  return cached(new Error(data?.error || `The hub answered ${status ?? "?"}`));
}

/**
 * glance.image is an absolute URL under /api/stream/image/. It's fetched from
 * the hub this widget signed in to, so the service token only goes there.
 */
function imageURL(settings, url) {
  if (!url) return null;
  if (url.startsWith(`${settings.url}/`)) return url;
  if (url.startsWith("/")) return `${settings.url}${url}`;
  const i = url.indexOf("/api/stream/image/");
  return i >= 0 ? `${settings.url}${url.slice(i)}` : null;
}

async function hubImage(settings, url) {
  const src = imageURL(settings, url);
  if (!src) return null;
  try {
    const req = new Request(src);
    req.timeoutInterval = 30;
    req.headers = authHeaders(settings);
    return await req.loadImage();
  } catch (_) {
    return null;
  }
}

/**
 * The card after the one shown last time for this Parameter. If that card has
 * left the stream, the card after its old position, wrapping around.
 */
function nextCard(cards, key, advance) {
  const fm = FileManager.local();
  const path = docPath(`family-hub-rotation-${key}.json`);
  let state = null;
  try { if (fm.fileExists(path)) state = JSON.parse(fm.readString(path)); } catch (_) { /* start over */ }
  let i = 0;
  if (state && typeof state === "object") {
    const at = state.id != null ? cards.findIndex(c => c.id === state.id) : -1;
    if (at >= 0) i = (at + 1) % cards.length;
    else if (Number.isInteger(state.index)) i = (state.index + 1) % cards.length;
  }
  if (advance) fm.writeString(path, JSON.stringify({ id: cards[i].id, index: i }));
  return cards[i];
}

/** Widget size in pixels (approximate; iOS picks the exact size). */
function pixelSize(family) {
  const s = { small: [340, 340], medium: [720, 340], large: [720, 760], extraLarge: [1520, 760] }[family];
  return s || [720, 340];
}

/** Scale `img` to fill `size` (cropping), darken it by `shade`, and return the new image. */
function fillImage(img, [w, h], shade) {
  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = true;
  ctx.respectScreenScale = false;
  const scale = Math.max(w / img.size.width, h / img.size.height);
  const dw = img.size.width * scale;
  const dh = img.size.height * scale;
  ctx.drawImageInRect(img, new Rect((w - dw) / 2, (h - dh) / 2, dw, dh));
  if (shade) {
    ctx.setFillColor(new Color("#000000", shade));
    ctx.fillRect(new Rect(0, 0, w, h));
  }
  return ctx.getImage();
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

function label(stack, text, color = MUTED) {
  const t = stack.addText(String(text).toUpperCase());
  t.font = F.label();
  t.textColor = color;
  t.lineLimit = 1;
  return t;
}

function dots(stack, colors, size = 6) {
  const row = stack.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  (colors || []).slice(0, 6).forEach((hex, i) => {
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
  const list = colors && colors.length ? colors : ["#888888"];
  const each = Math.max(2, Math.floor(height / list.length));
  for (const hex of list.slice(0, 4)) {
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
  const tt = time.addText(e.time || "");
  tt.font = F.time();
  tt.textColor = MUTED;
  tt.lineLimit = 1;
  tt.minimumScaleFactor = 0.8;
  row.addSpacer(2);
  const title = row.addText(e.title || "");
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
      label(stack, e.day || "");
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

function whenText(e) {
  return e.day === "Today" ? e.time : `${e.day} ${e.time}`;
}

/** Plain text with the usual settings; `shadow` for text over a photo. */
function txt(stack, text, f, color, lines = 1, shadow = false) {
  const t = stack.addText(String(text ?? ""));
  t.font = f;
  t.textColor = color;
  t.lineLimit = lines;
  t.minimumScaleFactor = 0.7;
  if (shadow) {
    t.shadowColor = new Color("#000000", 0.6);
    t.shadowRadius = 2;
  }
  return t;
}

function whiteText(stack, text, f, color = WHITE, lines = 1) {
  return txt(stack, text, f, color, lines, true);
}

function viewLabel(stack, stream, onImage) {
  const v = stream.view;
  return label(stack, v ? v.name : "Family", v ? new Color(v.color) : onImage ? SKY : ACCENT);
}

function header(stack, stream, right) {
  const h = stack.addStack();
  h.layoutHorizontally();
  h.centerAlignContent();
  viewLabel(h, stream, false);
  h.addSpacer();
  if (right) label(h, right);
  return h;
}

function staleNote(stack, x, color = MUTED) {
  if (!x.stale) return;
  stack.addSpacer(2);
  const when = new Date(x.stream.generatedAt);
  const t = stack.addText(`Offline · as of ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  t.font = F.label();
  t.textColor = color;
  t.lineLimit = 1;
}

function flagLine(stack, flag, size = 12) {
  const t = stack.addText(`🚨 ${flag.message}`);
  t.font = F.title(size);
  t.textColor = URGENT;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

function nothing(stack, today, size) {
  const t = stack.addText(today.eventsError ? "Couldn't read the calendar" : "Nothing else today or tomorrow");
  t.font = F.body(size);
  t.textColor = MUTED;
  return t;
}

function memberName(stream, id) {
  return (stream.members || []).find(m => m.id === id) || { id, name: id, color: "#888888" };
}

// ─── today ────────────────────────────────────────────────────────────────────

function todayData(card) {
  const d = card.data || {};
  return { events: d.events || [], moreEvents: d.moreEvents || 0, flags: d.flags || [], eventsError: d.eventsError };
}

function todaySmall(w, x) {
  const d = todayData(x.card);
  const next = nextUp(d.events);
  header(w, x.stream);
  w.addSpacer(6);
  if (next) {
    const time = w.addText(whenText(next));
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
    const rest = d.events.length - 1 + d.moreEvents;
    if (d.flags.length) flagLine(w, d.flags[0], 11);
    else if (rest > 0) txt(w, `+${rest} more`, F.body(11), MUTED);
  } else {
    w.addSpacer();
    if (d.flags.length) flagLine(w, d.flags[0], 13);
    else nothing(w, d, 13);
    w.addSpacer();
  }
  staleNote(w, x);
}

function todayMedium(w, x) {
  const d = todayData(x.card);
  header(w, x.stream, "Upcoming");
  w.addSpacer(6);
  if (d.flags.length) {
    flagLine(w, d.flags[0]);
    w.addSpacer(4);
  }
  if (d.events.length) eventList(w, d.events, d.flags.length ? 4 : 5, { titleSize: 12, timeWidth: 54 });
  else nothing(w, d, 13);
  w.addSpacer();
  staleNote(w, x);
}

function todayLarge(w, x) {
  const d = todayData(x.card);
  header(w, x.stream, "Upcoming");
  w.addSpacer(8);
  for (const f of d.flags.slice(0, 2)) {
    flagLine(w, f, 13);
    w.addSpacer(4);
  }
  if (d.events.length) {
    const shown = eventList(w, d.events, d.flags.length ? 9 : 10, { titleSize: 14, timeWidth: 62 });
    const more = d.events.length - shown + d.moreEvents;
    if (more > 0) {
      w.addSpacer(4);
      txt(w, `+${more} more`, F.body(12), MUTED);
    }
  } else {
    nothing(w, d, 14);
  }
  w.addSpacer();
  staleNote(w, x);
}

function todayRectangular(w, x) {
  const d = todayData(x.card);
  const next = nextUp(d.events);
  if (next) {
    const t = w.addText(whenText(next));
    t.font = F.title(13);
    t.lineLimit = 1;
    const title = w.addText(next.title);
    title.font = F.body(13);
    title.lineLimit = 1;
    const rest = d.events.length - 1 + d.moreEvents;
    const third = d.flags.length ? `🚨 ${d.flags[0].message}` : rest > 0 ? `+${rest} more` : null;
    if (third) {
      const tt = w.addText(third);
      tt.font = F.body(12);
      tt.textOpacity = 0.7;
      tt.lineLimit = 1;
    }
  } else {
    glanceRectangular(w, x);
  }
}

function todayInline(w, x) {
  const next = nextUp(todayData(x.card).events);
  if (next) w.addText(`${next.day === "Today" ? "" : next.day + " "}${next.time} ${next.title}`);
  else glanceInline(w, x);
}

function todayCircular(w, x) {
  const d = todayData(x.card);
  w.addAccessoryWidgetBackground = true;
  const n = d.events.filter(e => e.day === "Today").length;
  const top = w.addText(d.flags.length && !n ? "!" : String(n));
  top.font = F.big(22);
  top.centerAlignText();
  top.minimumScaleFactor = 0.6;
  const sub = w.addText(d.flags.length && !n ? "PLAN" : "TODAY");
  sub.font = F.label();
  sub.centerAlignText();
  sub.minimumScaleFactor = 0.6;
}

// ─── photos ───────────────────────────────────────────────────────────────────

function photoFull(w, x) {
  const g = x.card.glance || {};
  w.backgroundImage = fillImage(x.image, pixelSize(x.family), 0);
  w.setPadding(0, 0, 0, 0);
  w.addSpacer();
  const strip = w.addStack();
  strip.layoutVertically();
  strip.backgroundColor = new Color("#000000", 0.5);
  strip.setPadding(6, 12, 8, 12);
  const row = strip.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  whiteText(row, g.headline || x.card.title || "Photos", F.title(13));
  row.addSpacer();
  viewLabel(row, x.stream, true);
  if (g.detail) whiteText(strip, g.detail, F.body(11), WHITE_MUTED);
  staleNote(strip, x, WHITE_MUTED);
}

// ─── trips ────────────────────────────────────────────────────────────────────

function tripFull(w, x) {
  const t = x.card.data || {};
  const g = x.card.glance || {};
  const large = x.family !== "medium";
  if (x.image) w.backgroundImage = fillImage(x.image, pixelSize(x.family), 0.55);
  else w.backgroundColor = NIGHT;
  const row = w.addStack();
  row.layoutHorizontally();

  const left = row.addStack();
  left.layoutVertically();
  whiteText(left, `${g.emoji ? g.emoji + " " : ""}${t.name || x.card.title}`, F.title(18), WHITE, 2);
  whiteText(left, t.dates || "", F.body(11), WHITE_MUTED);
  if (large && t.resort) whiteText(left, t.resort, F.body(11), WHITE_MUTED);
  left.addSpacer();
  const active = t.status === "active";
  whiteText(left, active ? `Day ${t.day}` : String(t.daysUntil ?? g.headline ?? ""), F.big(54));
  const unit = active ? `of ${t.days}` : `${t.daysUntil === 1 ? "day" : "days"} ${t.countdown || "to go"}`;
  whiteText(left, unit, F.body(11), SKY, 2);
  staleNote(left, x, WHITE_MUTED);

  row.addSpacer(14);
  const right = row.addStack();
  right.layoutVertically();
  // An active trip shows today's schedule first; medium has room for one list, large for both.
  const schedule = active && Array.isArray(t.today) ? t.today : [];
  const board = Array.isArray(t.leaderboard) ? t.leaderboard : [];
  let room = large ? 12 : 5;
  if (schedule.length) {
    label(right, "Today", SKY);
    right.addSpacer(4);
    const n = Math.min(schedule.length, large ? 5 : room);
    schedule.slice(0, n).forEach((s, i) => {
      if (i) right.addSpacer(3);
      whiteText(right, `${s.time ? s.time + "  " : ""}${s.emoji ? s.emoji + " " : ""}${s.title || ""}`, F.body(12));
    });
    room = large ? room - n - 2 : 0;
    if (room > 1) right.addSpacer(10);
  }
  if (room > 1 && board.length) {
    label(right, "Leaderboard", SKY);
    right.addSpacer(4);
    board.slice(0, room).forEach((r, i) => {
      if (i) right.addSpacer(3);
      const line = right.addStack();
      line.layoutHorizontally();
      line.centerAlignContent();
      const dot = line.addStack();
      dot.size = new Size(7, 7);
      dot.cornerRadius = 3.5;
      dot.backgroundColor = new Color(r.color || "#888888");
      line.addSpacer(6);
      whiteText(line, r.name, F.body(12));
      line.addSpacer();
      whiteText(line, String(r.points ?? 0), F.title(12));
    });
  } else if (room > 1 && Array.isArray(t.who) && t.who.length) {
    label(right, "Who's going", SKY);
    right.addSpacer(4);
    t.who.slice(0, room).forEach((id, i) => {
      if (i) right.addSpacer(3);
      const m = memberName(x.stream, id);
      const line = right.addStack();
      line.layoutHorizontally();
      line.centerAlignContent();
      dots(line, [m.color], 7);
      line.addSpacer(6);
      whiteText(line, m.name, F.body(12));
      line.addSpacer();
    });
  }
  right.addSpacer();
  if (t.questsTotal) whiteText(right, `${t.questsDone || 0} of ${t.questsTotal} quests`, F.body(10), WHITE_MUTED);
}

// ─── grocery ──────────────────────────────────────────────────────────────────

function groceryFull(w, x) {
  const items = ((x.card.data || {}).items || []).filter(i => !i.done);
  const rows = x.family === "medium" ? 5 : 12;
  const h = w.addStack();
  h.layoutHorizontally();
  h.centerAlignContent();
  label(h, `${(x.card.glance || {}).emoji || "🛒"} ${x.card.title || "Grocery list"}`, ACCENT);
  h.addSpacer();
  label(h, `${items.length} to buy`);
  w.addSpacer(8);

  const fits = rows * 2;
  const shown = items.length > fits ? items.slice(0, fits - 1) : items;
  const cols = w.addStack();
  cols.layoutHorizontally();
  for (let c = 0; c < 2; c++) {
    const col = cols.addStack();
    col.layoutVertically();
    shown.slice(c * rows, (c + 1) * rows).forEach((item, i) => {
      if (i) col.addSpacer(4);
      const line = col.addStack();
      line.layoutHorizontally();
      line.centerAlignContent();
      const box = line.addStack();
      box.size = new Size(8, 8);
      box.cornerRadius = 4;
      box.borderWidth = 1;
      box.borderColor = MUTED;
      line.addSpacer(6);
      const qty = item.quantity > 1 ? ` ×${item.quantity}` : "";
      txt(line, `${item.name}${qty}`, F.body(x.family === "medium" ? 12 : 13), TEXT);
      line.addSpacer();
    });
    if (c === 1 && items.length > shown.length) {
      col.addSpacer(4);
      txt(col, `+${items.length - shown.length} more`, F.body(12), MUTED);
    }
    if (c === 0) cols.addSpacer(10);
  }
  w.addSpacer();
  staleNote(w, x);
}

// ─── Glance: any card, from its envelope and glance alone ────────────────────

function glanceLayout(w, x) {
  const { card, family, image } = x;
  const g = card.glance || {};
  const small = family === "small";
  const onImage = !!image;
  if (onImage) w.backgroundImage = fillImage(image, pixelSize(family), 0.45);
  const fg = onImage ? WHITE : TEXT;
  const muted = onImage ? WHITE_MUTED : MUTED;

  const top = w.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  label(top, card.title || card.component || "", onImage ? SKY : ACCENT);
  top.addSpacer();
  if (!small) viewLabel(top, x.stream, onImage);
  w.addSpacer();

  if (g.emoji) {
    txt(w, g.emoji, F.body(small ? 26 : 32), fg);
    w.addSpacer(2);
  }
  const headSize = small ? 20 : family === "medium" ? 26 : 32;
  txt(w, g.headline || card.title || "", F.big(headSize), fg, small ? 3 : 2, onImage);
  if (g.detail) {
    w.addSpacer(2);
    txt(w, g.detail, F.body(small ? 12 : 14), muted, small ? 2 : family === "medium" ? 2 : 4, onImage);
  }
  if (Array.isArray(g.colors) && g.colors.length) {
    w.addSpacer(4);
    dots(w, g.colors);
  }
  staleNote(w, x, muted);
}

function glanceRectangular(w, x) {
  const g = x.card.glance || {};
  const head = w.addText(`${g.emoji ? g.emoji + " " : ""}${g.headline || x.card.title || ""}`);
  head.font = F.title(13);
  head.lineLimit = 2;
  if (g.detail) {
    const d = w.addText(g.detail);
    d.font = F.body(12);
    d.textOpacity = 0.7;
    d.lineLimit = 1;
  }
}

function glanceInline(w, x) {
  const g = x.card.glance || {};
  w.addText(`${g.emoji ? g.emoji + " " : ""}${g.headline || x.card.title || ""}`);
}

function glanceCircular(w, x) {
  const g = x.card.glance || {};
  w.addAccessoryWidgetBackground = true;
  const t = w.addText(g.emoji || (g.headline || x.card.title || "").slice(0, 3));
  t.font = F.big(20);
  t.centerAlignText();
  t.minimumScaleFactor = 0.5;
}

// ─── Choosing a layout ────────────────────────────────────────────────────────

/** Components drawn in full, by widget size. Anything else is drawn from its glance. */
const NATIVE = {
  today: {
    small: todaySmall, medium: todayMedium, large: todayLarge,
    accessoryRectangular: todayRectangular, accessoryInline: todayInline, accessoryCircular: todayCircular,
  },
  photos: { medium: photoFull, large: photoFull },
  trips: { medium: tripFull, large: tripFull },
  grocery: { medium: groceryFull, large: groceryFull },
};
const GLANCE = {
  accessoryRectangular: glanceRectangular, accessoryInline: glanceInline, accessoryCircular: glanceCircular,
};
/** Layouts that need the card's image; without one they fall back to the glance. */
const NEEDS_IMAGE = new Set([photoFull]);

function layoutFor(card, family) {
  const size = family === "extraLarge" ? "large" : family;
  const fn = NATIVE[card.component]?.[size] || GLANCE[family] || glanceLayout;
  return fn;
}

function errorWidget(w, message) {
  label(w, "Family Hub", ACCENT);
  w.addSpacer(4);
  const t = w.addText(message);
  t.font = F.body(12);
  t.textColor = TEXT;
  t.minimumScaleFactor = 0.7;
}

function emptyWidget(w, x, request) {
  const names = request.components.length ? request.components.join(", ") : "the stream";
  header(w, x.stream);
  w.addSpacer();
  txt(w, `Nothing in ${names} right now`, F.body(13), MUTED, 3);
  for (const e of (x.stream.errors || []).slice(0, 2)) {
    w.addSpacer(2);
    txt(w, `${e.component}: ${e.error}`, F.body(11), MUTED, 2);
  }
  w.addSpacer();
  staleNote(w, x);
}

/** `advance`: step the rotation (the widget, and previews in the app). */
async function buildWidget(family, param, settings, advance = true) {
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
  if (param.error) {
    errorWidget(w, param.error);
    return w;
  }
  try {
    const request = requestFor(param, family);
    const result = await loadStream(settings, request, param);
    const stream = result.data;
    const x = { stream, family, stale: result.stale, card: null, image: null };
    w.url = stream.hubUrl || `${settings.url}/`;
    const cards = (stream.cards || []).filter(c => c && c.id != null);
    if (!cards.length) {
      if (accessory) w.addText("Nothing to show");
      else emptyWidget(w, x, request);
      return w;
    }
    const card = accessory
      ? cards.find(c => c.component === "today") || cards[0]
      : nextCard(cards, request.key, advance);
    x.card = card;
    if (card.url) w.url = card.url;

    let fn = layoutFor(card, family);
    if (!accessory && card.glance?.image) x.image = await hubImage(settings, card.glance.image);
    if (NEEDS_IMAGE.has(fn) && !x.image) fn = glanceLayout;
    fn(w, x);
  } catch (err) {
    errorWidget(w, err.message);
  }
  return w;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  let settings = readSettings();
  const param = parseParam(args.widgetParameter);

  if (config.runsInWidget) {
    Script.setWidget(await buildWidget(config.widgetFamily || "medium", param, settings));
    return;
  }

  if (!settings) settings = await askSettings(null);
  if (!settings) return;

  const menu = new Alert();
  menu.title = "Family Hub widget";
  menu.message =
    "Preview a size, or change the hub sign-in. Preview parameter: a member id or \"family\", " +
    "then any components (e.g. \"family photos trips\"). Each preview steps to the next card.";
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
  const previewParam = parseParam(menu.textFieldValue(0));
  const family = ["small", "medium", "large"][choice];
  const w = await buildWidget(family, previewParam, settings);
  if (family === "small") await w.presentSmall();
  else if (family === "medium") await w.presentMedium();
  else await w.presentLarge();
}

await main();
Script.complete();
