/**
 * Photos from iCloud shared albums (Apple Photos → Shared Album → Public Website):
 * the family album (the photos component) and trips' own albums. Screens get them
 * through the stream (stream.js → /api/stream/image/<card>).
 *
 * The album link (family.yaml → inputs.icloud-album, or a trip's album) stays
 * server-side. The Worker reads the album the way icloud.com's own pages do. iCloud
 * has two kinds of shared-album link:
 *
 *   https://photos.icloud.com/shared/album/<key>   resolved to an anonymous CloudKit
 *                                                  token; photo records list the
 *                                                  medium JPEG's download URL.
 *   https://www.icloud.com/sharedalbum/#<token>    "shared streams": webstream lists
 *                                                  the photos, and webasseturls gives
 *                                                  one photo's download URL on demand.
 *
 * Neither is a documented Apple API, so they may need updating if Apple changes them.
 */

const LIST_CACHE_SECONDS = 300;
const PHOTO_CACHE_SECONDS = 7 * 86_400;
const MAX_PHOTOS = 500;
const CK = "https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production";
const ORIGIN = { "content-type": "text/plain", Origin: "https://photos.icloud.com" };

const STREAMS_FIRST_HOST = "p23-sharedstreams.icloud.com";   // iCloud redirects to the album's own host
const STREAMS_HEADERS = { "Content-Type": "text/plain", Origin: "https://www.icloud.com" };

/**
 * A shared-album link → the key the reader uses, else null:
 *   "https://photos.icloud.com/shared/album/<key>" (or a bare key)  → "<key>"
 *   "https://www.icloud.com/sharedalbum/#<token>"                   → "s:<token>"
 */
export function albumKey(link) {
  if (!link) return null;
  const streams = String(link).match(/^https:\/\/www\.icloud\.com\/sharedalbum\/(?:[a-z-]+\/)?#([A-Za-z0-9_-]{10,120})\/?$/);
  if (streams) return `s:${streams[1]}`;
  const m = String(link).match(/^(?:https:\/\/(?:photos\.icloud\.com\/shared\/album|share\.icloud\.com\/photos)\/)?([A-Za-z0-9_-]{10,64})\/?(?:[?#].*)?$/);
  return m ? m[1] : null;
}

// ─── The album ────────────────────────────────────────────────────────────────

/** The family album's photos (newest first), or null when no album is set up. Throws if iCloud fails. */
export async function albumPhotos(hub) {
  return albumPhotosFor(hub.photosAlbum);
}

/** Any shared album's photos (a trip's, say), or null for no link. Throws if iCloud fails. */
export async function albumPhotosFor(link) {
  const key = albumKey(link);
  return key ? cachedAlbum(key) : null;
}

/** One family album photo as a JPEG response. */
export async function photoById(hub, id) {
  return photoFromAlbum(hub.photosAlbum, id);
}

/** One photo from any shared album, as a JPEG response. */
export async function photoFromAlbum(link, id) {
  const key = albumKey(link);
  if (!key) return json({ error: "No photo album is set up." }, 404);
  const album = await cachedAlbum(key);
  const photo = album.find(p => p.id === id);
  if (!photo) return json({ error: "No such photo" }, 404);
  return photoResponse(key, photo);
}

async function cachedAlbum(key) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(`https://family-hub.internal/photos/${encodeURIComponent(key)}`);
  const hit = cache && (await cache.match(cacheKey));
  if (hit) return hit.json();

  const album = await readAlbum(key);
  if (cache) {
    await cache.put(cacheKey, new Response(JSON.stringify(album), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${LIST_CACHE_SECONDS}` },
    }));
  }
  return album;
}

/** Every photo in the album, newest first. */
async function readAlbum(key) {
  if (key.startsWith("s:")) return readStreamsAlbum(key.slice(2));
  return readCloudKitAlbum(key);
}

/** A photos.icloud.com album: every photo with a (short-lived) download URL each. */
async function readCloudKitAlbum(key) {
  const resolved = await ck(`${CK}/public/records/resolve?${params({ sharing_url_key: key })}`, {
    shortGUIDs: [{ value: key }],
  });
  const share = resolved.results?.[0];
  const access = share?.anonymousPublicAccess;
  if (!share?.zoneID || !access?.token) {
    throw new Error("the album link didn't resolve. Is Public Website on?");
  }
  const base = `${access.databasePartition || "https://ckdatabasews.icloud.com"}`.replace(/:443$/, "");
  const query = params({ sharing_url_key: key, publicAccessAuthToken: access.token });
  const url = `${base}/database/1/com.apple.photos.cloud/production/shared/records/query?${query}`;

  const assets = [];
  const masters = new Map();
  let marker;
  do {
    const page = await ck(url, {
      query: {
        recordType: "CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted",
        filterBy: [{ fieldName: "direction", comparator: "EQUALS", fieldValue: { value: "DESCENDING", type: "STRING" } }],
      },
      zoneID: share.zoneID,
      resultsLimit: 200,
      ...(marker ? { continuationMarker: marker } : {}),
    });
    for (const r of page.records ?? []) {
      if (r.recordType === "CPLAsset") assets.push(r);
      else if (r.recordType === "CPLMaster") masters.set(r.recordName, r);
    }
    marker = page.continuationMarker;
  } while (marker && assets.length < MAX_PHOTOS * 2);

  const photos = [];
  for (const asset of assets) {
    const a = asset.fields ?? {};
    const master = masters.get(a.masterRef?.value?.recordName);
    const m = master?.fields ?? {};
    if (!master || /movie|mpeg|video|quicktime/i.test(m.itemType?.value ?? "")) continue;
    // Edited photos carry their rendered JPEGs on the asset; originals on the master.
    // iCloud makes no medium or full JPEG for a photo that's already small: then the
    // original, if it's a JPEG or PNG no bigger than a full one, else the thumbnail.
    const has = (f, p) => f[`${p}Res`]?.value?.downloadURL;
    const pick = ["resJPEGMed", "resJPEGFull"].flatMap(p => [[a, p], [m, p]]).find(([f, p]) => has(f, p))
      ?? [[a, "resOriginal"], [m, "resOriginal"]].find(([f, p]) => has(f, p) && smallWebImage(f, p))
      ?? [[a, "resJPEGThumb"], [m, "resJPEGThumb"]].find(([f, p]) => has(f, p));
    if (!pick) continue;
    const [f, p] = pick;
    photos.push({
      id: asset.recordName,
      width: Number(f[`${p}Width`]?.value) || null,
      height: Number(f[`${p}Height`]?.value) || null,
      takenAt: a.assetDate?.value ? new Date(Number(a.assetDate.value)).toISOString() : null,
      fingerprint: f[`${p}Fingerprint`]?.value ?? asset.recordChangeTag ?? "",
      downloadURL: f[`${p}Res`].value.downloadURL,
    });
    if (photos.length >= MAX_PHOTOS) break;
  }
  return photos;
}

/** An original every screen can show as is: a JPEG or PNG at most about 2048 px a side. */
function smallWebImage(f, p) {
  const type = String(f[`${p}FileType`]?.value ?? "");
  const side = Math.max(Number(f[`${p}Width`]?.value) || 0, Number(f[`${p}Height`]?.value) || 0);
  return /^public\.(jpeg|png)$/.test(type) && side > 0 && side <= 2100;
}

// ─── Shared streams (www.icloud.com/sharedalbum/#…) ───────────────────────────

/** POSTs to a shared-streams endpoint, following iCloud's redirect (330) to the album's host. */
async function streamsPost(host, token, path, body) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`https://${host}/${token}/sharedstreams/${path}`, {
      method: "POST", headers: STREAMS_HEADERS, body: JSON.stringify(body),
    });
    if (res.status === 330) {
      const d = await res.json().catch(() => ({}));
      host = res.headers.get("X-Apple-MMe-Host") || d["X-Apple-MMe-Host"];
      if (!host) throw new Error("iCloud redirected without saying where");
      continue;
    }
    if (res.status === 404) throw new Error("the album link didn't resolve. Is Public Website on?");
    if (!res.ok) throw new Error(`iCloud answered ${res.status}`);
    return { host, data: await res.json() };
  }
  throw new Error("iCloud kept redirecting");
}

/** A shared-streams album's photos (videos left out), each with its largest rendition up to about 2048 px. */
async function readStreamsAlbum(token) {
  const { host, data } = await streamsPost(STREAMS_FIRST_HOST, token, "webstream", { streamCtag: null });
  const photos = [];
  for (const p of data.photos ?? []) {
    if (p.mediaAssetType === "video" || !p.photoGuid) continue;
    const sizes = Object.values(p.derivatives ?? {})
      .filter(d => d?.checksum)
      .sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height));
    const d = sizes.find(d => Math.max(Number(d.width), Number(d.height)) <= 2100) ?? sizes[sizes.length - 1];
    if (!d) continue;
    photos.push({
      id: p.photoGuid,
      width: Number(d.width) || null,
      height: Number(d.height) || null,
      takenAt: p.dateCreated ?? p.batchDateCreated ?? null,
      fingerprint: d.checksum,
      host,
    });
  }
  photos.sort((a, b) => String(b.takenAt ?? "").localeCompare(String(a.takenAt ?? "")));
  return photos.slice(0, MAX_PHOTOS);
}

/** One shared-streams photo's download URL. They expire, so they're asked for only when needed. */
async function streamsDownloadURL(token, photo) {
  const { data } = await streamsPost(photo.host, token, "webasseturls", { photoGuids: [photo.id] });
  const item = data.items?.[photo.fingerprint];
  if (!item?.url_location || !item?.url_path) throw new Error("iCloud didn't give a download link");
  return `https://${item.url_location}${item.url_path}`;
}

async function photoResponse(key, photo) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(
    `https://family-hub.internal/photo/${encodeURIComponent(key)}/${encodeURIComponent(photo.id)}/${encodeURIComponent(photo.fingerprint)}`
  );
  let res = cache && (await cache.match(cacheKey));
  if (!res) {
    let url;
    try {
      url = key.startsWith("s:") ? await streamsDownloadURL(key.slice(2), photo) : photo.downloadURL.replace("${f}", "photo.jpg");
    } catch (err) {
      return json({ error: `Couldn't get this photo from iCloud: ${err.message}` }, 502);
    }
    const upstream = await fetch(url, { headers: { Origin: key.startsWith("s:") ? STREAMS_HEADERS.Origin : ORIGIN.Origin } });
    if (!upstream.ok) return json({ error: `iCloud answered ${upstream.status} for this photo` }, 502);
    res = new Response(upstream.body, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": `max-age=${PHOTO_CACHE_SECONDS}` },
    });
    if (cache) await cache.put(cacheKey, res.clone());
  }
  // The edge cache keeps it; clients (behind Access) cache privately.
  return new Response(res.body, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": `private, max-age=${PHOTO_CACHE_SECONDS}` },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function params(extra) {
  return new URLSearchParams({ remapEnums: "true", getCurrentSyncToken: "true", ...extra }).toString();
}

async function ck(url, body) {
  const res = await fetch(url, { method: "POST", headers: ORIGIN, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`iCloud answered ${res.status}`);
  return res.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
