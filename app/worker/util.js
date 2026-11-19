/**
 * Small helpers the Worker modules share: dates in the family's timezone, and
 * JSON responses. Dates are "YYYY-MM-DD" strings throughout.
 */

/** The calendar date of `date` in `tz`, as YYYY-MM-DD. */
export function ymd(date, tz) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** "3:20 PM" in the family's timezone and locale. */
export function timeLabel(date, tz, locale) {
  return new Intl.DateTimeFormat(locale || "en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(date);
}

/** A YYYY-MM-DD date formatted with `opts` (it's a calendar date, so no timezone shift). */
export function dateLabel(day, locale, opts) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale || "en-US", { timeZone: "UTC", ...opts });
}

/** "Jul 3 – 9", "Dec 24 – Jan 2", or with years when they differ from `today`'s. */
export function dateRange(a, b, locale, today) {
  const year = d => d.slice(0, 4);
  const showYear = today && (year(a) !== year(today) || year(b) !== year(today));
  const md = { month: "short", day: "numeric" };
  if (year(a) !== year(b)) {
    return `${dateLabel(a, locale, { ...md, year: "numeric" })} – ${dateLabel(b, locale, { ...md, year: "numeric" })}`;
  }
  const end = a.slice(0, 7) === b.slice(0, 7) ? dateLabel(b, locale, { day: "numeric" }) : dateLabel(b, locale, md);
  return `${dateLabel(a, locale, md)} – ${end}${showYear ? `, ${year(b)}` : ""}`;
}

/** "Today", "Tomorrow", or "Thu, Nov 20". */
export function dayName(day, today, locale) {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  return dateLabel(day, locale, { weekday: "short", month: "short", day: "numeric" });
}

/** Cut `s` to `n` characters at a word boundary, with an ellipsis. */
export function clip(s, n) {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const space = cut.lastIndexOf(" ");
  return (space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "") + "…";
}

/** The first sentence of `s`. */
export function firstSentence(s) {
  const m = String(s ?? "").replace(/\s+/g, " ").trim().match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : String(s ?? "").trim();
}

export function json(data, status = 200, cache = "private, no-store") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cache },
  });
}

/** A deterministic shuffle: the same `seed` gives the same order. */
export function shuffled(list, seed) {
  const out = list.slice();
  let s = (seed >>> 0) || 1;
  const rand = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
