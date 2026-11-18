/**
 * Photos from an iCloud shared album (Apple Photos → Shared Album → Public Website),
 * for TV screensavers and other displays. Under /api/widget/ so the same Access
 * service tokens as the widgets cover it.
 *
 *   GET /api/widget/photos       → { photos: [{ id, width, height, takenAt }], generatedAt }
 *   GET /api/widget/photos/:id   → the photo as a JPEG (about 1536 px on the long side)
 *
 * The album link (family.yaml → hub.photos.icloudAlbum) stays server-side. The
 * Worker reads the album the way icloud.com's own album page does: it resolves
 * the link to an anonymous CloudKit token, lists the album's photo records, and
 * downloads each photo's medium JPEG rendition. This isn't a documented Apple API,
 * so it may need updating if Apple changes the page.
 */

const LIST_CACHE_SECONDS = 600;
const PHOTO_CACHE_SECONDS = 7 * 86_400;
const MAX_PHOTOS = 500;
const CK = "https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production";
const ORIGIN = { "content-type": "text/plain", Origin: "https://photos.icloud.com" };

/** "https://photos.icloud.com/shared/album/<key>" (or a bare key) → key, else null. */
export function albumKey(link) {
  if (!link) return null;
  const m = String(link).match(/^(?:https:\/\/(?:photos\.icloud\.com\/shared\/album|share\.icloud\.com\/photos)\/)?([A-Za-z0-9_-]{10,64})\/?(?:[?#].*)?$/);
  return m ? m[1] : null;
}

export async function handlePhotos(request, env, hub, path) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const key = albumKey(hub.photosAlbum);
  if (!key) return json({ error: "No photo album is set up (family.yaml → hub.photos.icloudAlbum)." }, 404);

  let album;
  try {
    album = await cachedAlbum(key);
  } catch (err) {
    return json({ error: `Couldn't read the iCloud album: ${err.message}` }, 502);
  }

  if (path === "") {
    return json({
      photos: album.map(({ id, width, height, takenAt }) => ({ id, width, height, takenAt })),
      generatedAt: new Date().toISOString(),
    });
  }

  const id = decodeURIComponent(path.slice(1));
  let photo = album.find(p => p.id === id);
  if (!photo) return json({ error: "No such photo" }, 404);
  return photoResponse(key, photo);
}

// ─── The album ────────────────────────────────────────────────────────────────

async function cachedAlbum(key) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(`https://family-hub.internal/photos/${key}`);
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

/** Every photo in the album, newest first, with a (short-lived) download URL each. */
async function readAlbum(key) {
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
    const pick = ["resJPEGMed", "resJPEGFull"]
      .flatMap(p => [[a, p], [m, p]])
      .find(([f, p]) => f[`${p}Res`]?.value?.downloadURL);
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

async function photoResponse(key, photo) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(
    `https://family-hub.internal/photo/${key}/${encodeURIComponent(photo.id)}/${encodeURIComponent(photo.fingerprint)}`
  );
  let res = cache && (await cache.match(cacheKey));
  if (!res) {
    const upstream = await fetch(photo.downloadURL.replace("${f}", "photo.jpg"), { headers: { Origin: ORIGIN.Origin } });
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
