/**
 * A picture for something with a link (an escape room, a movie), taken from its page.
 *
 *   findImage(pageUrl, { name })   → the picture's absolute URL, or null
 *   pickImage(html, baseUrl, name) → the same, from HTML already fetched (pure; tested)
 *   imageResponse(imageUrl)        → the picture, fetched once and cached for a week
 *
 * Which picture: one whose description (alt) or file name names the thing (a venue's
 * page often shows all its rooms), then the page's preview image (og:image,
 * twitter:image, image_src), then one from its structured data, then a large one.
 * Logos, icons and SVGs are skipped.
 *
 * Only public pictures from public pages pass through imageResponse, so the TVs, which
 * can't reach other sites with the hub's token, can show them too.
 */

const PAGE_TIMEOUT_MS = 8000;
const MAX_PAGE_BYTES = 2_000_000;
const MAX_IMAGE_BYTES = 5_000_000;
const CACHE_SECONDS = 7 * 86_400;
const UA = "Mozilla/5.0 (compatible; family-hub; +https://github.com/mrwalker/cc-family-hub)";

const STOP = new Set(["escape", "room", "rooms", "game", "games", "the", "and", "with", "from", "your", "into", "experience"]);
const SKIP = /logo|icon|sprite|favicon|avatar|badge|pixel|spinner|placeholder|blank|flag|payment|tripadvisor|google|facebook|instagram|transparent|\.svg\b|\.gif\b|^data:|[?&]blur=/i;

/** A thumbnail or a blurred stand-in, by its size in the URL (?w=16&h=11). */
const tiny = src => {
  const w = src.match(/[?&](?:w|width)=(\d+)/i), h = src.match(/[?&](?:h|height)=(\d+)/i);
  return (w && +w[1] < 300) || (h && +h[1] < 200);
};

/** A short version of a picture's address, for its link (?v=…): a new picture is a new link. */
export function imageVersion(url) {
  if (!url) return null;
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h * 33) ^ url.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const decode = s => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : null;
}

/** The words of a name worth matching on ("Pirate's Lagoon Quest" → pirate, lagoon, quest). */
export function nameWords(name) {
  return String(name || "").toLowerCase().replace(/[’']s\b/g, "").split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !STOP.has(w));
}

const absolute = (src, base) => {
  try {
    const u = new URL(src, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch { return null; }
};

/** The best picture on a page, or null. */
export function pickImage(html, baseUrl, name = "") {
  const words = nameWords(name);
  const names = text => {
    const t = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
    return words.length && words.filter(w => t.includes(w)).length >= Math.min(2, words.length);
  };
  const found = [];   // { url, score }
  const add = (src, score) => {
    if (!src || SKIP.test(src) || tiny(src)) return;
    const url = absolute(src, baseUrl);
    if (url) found.push({ url, score, order: found.length });
  };

  for (const tag of html.match(/<(meta|link|img|source)\b[^>]*>/gi) ?? []) {
    const kind = tag.slice(1, tag.search(/[\s>]/)).toLowerCase();
    if (kind === "meta") {
      const key = (attr(tag, "property") || attr(tag, "name") || "").toLowerCase();
      if (/^(og:image(:secure_url|:url)?|twitter:image(:src)?)$/.test(key)) {
        const src = attr(tag, "content");
        // A preview image that names the thing beats one that doesn't.
        add(src, names(src) ? 3 : 2);
      }
    } else if (kind === "link") {
      if (/(^|\s)image_src(\s|$)/i.test(attr(tag, "rel") || "")) add(attr(tag, "href"), 2);
    } else if (kind === "img") {
      const src = attr(tag, "src") || attr(tag, "data-src") || attr(tag, "data-lazy-src");
      if (!src) continue;
      const width = parseInt(attr(tag, "width") || "0", 10);
      const big = width >= 600 || /hero|banner|header|cover|feature/i.test(src);
      if (names(attr(tag, "alt")) || names(src)) add(src, big ? 3.5 : 3.2);
      else if (big) add(src, 1);
    }
  }
  // Structured data: "image": "…", "image": ["…"], "image": { "url": "…" }.
  for (const m of html.matchAll(/"image"\s*:\s*(?:\[\s*)?(?:\{[^{}]*?"url"\s*:\s*)?"([^"]+)"/g)) add(m[1].replace(/\\\//g, "/"), 1.5);

  found.sort((a, b) => b.score - a.score || a.order - b.order);
  return found[0]?.url ?? null;
}

/** Fetches a page and picks its picture. Never throws; null when there isn't one. */
export async function findImage(pageUrl, { name = "", fetcher = fetch } = {}) {
  if (!absolute(pageUrl)) return null;
  try {
    const res = await fetcher(pageUrl, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!res.ok || !/html/i.test(res.headers.get("Content-Type") || "text/html")) return null;
    const html = (await res.text()).slice(0, MAX_PAGE_BYTES);
    return pickImage(html, res.url || pageUrl, name);
  } catch {
    return null;
  }
}

/**
 * The picture at `imageUrl`, for the pages and the TVs. Fetched once, then served from
 * the Worker's cache for a week. A 404 when it's gone or isn't a picture.
 */
export async function imageResponse(imageUrl, { fetcher = fetch } = {}) {
  const missing = () => new Response("No picture", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!absolute(imageUrl)) return missing();
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(`https://link-image.family-hub.invalid/v2/${encodeURIComponent(imageUrl)}`);
  const hit = cache && (await cache.match(key));
  if (hit) return hit;
  try {
    // JPEG first. The wall tablet's old browser and the TVs can't show AVIF, which an
    // image CDN may send for ?auto=format whatever's asked for; then ask for ?fm=jpg.
    const get = u => fetcher(u, { headers: { "User-Agent": UA, Accept: "image/jpeg,image/png;q=0.9,image/webp;q=0.8,image/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    let res = await get(imageUrl);
    if (/avif/i.test(res.headers.get("Content-Type") || "") && /[?&]auto=format\b/.test(imageUrl)) {
      const jpeg = await get(imageUrl.replace(/([?&])auto=format\b/, "$1fm=jpg"));
      if (jpeg.ok && /^image\//i.test(jpeg.headers.get("Content-Type") || "")) res = jpeg;
    }
    const type = res.headers.get("Content-Type") || "";
    if (!res.ok || !/^image\//i.test(type) || /svg/i.test(type)) return missing();
    const body = await res.arrayBuffer();
    if (body.byteLength > MAX_IMAGE_BYTES) return missing();
    const out = new Response(body, { headers: { "Content-Type": type, "Cache-Control": `private, max-age=${CACHE_SECONDS}` } });
    if (cache) await cache.put(key, out.clone());
    return out;
  } catch {
    return missing();
  }
}
