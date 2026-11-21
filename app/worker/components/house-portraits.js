/**
 * house-portraits: one card per place (each house), over its photo, with what's next
 * there. Like pet-portraits: the photos are uploaded on /household/, a place with
 * several shows a different one each turn, and a place without one still gets its card.
 *
 * No household database, or no places: no cards. A house task with no place is on
 * no card; the house component shows it.
 *
 *   data: { place: { id, name, address }, photo: { url, width, height } | null,
 *           next: [{ title, kind, emoji, when, date, overdue, note }] }   (up to 3)
 */

import { upcoming, firstDetail } from "./tasks.js";

export const id = "house-portraits";

/** Every place each pass. */
export const max = 12;

export async function cards(ctx) {
  const places = await ctx.places();
  if (!places?.length) return [];
  const tasks = (await ctx.household()) ?? [];
  const title = places.length === 1 ? "House" : "Houses";
  return places.map(place => {
    const next = upcoming(ctx, tasks, "house", t => t.placeId === place.id);
    const photo = place.photos?.length ? place.photos[ctx.turn % place.photos.length] : null;
    const cardId = `house-portraits:${place.id}`;
    const url = photo ? `${ctx.image(cardId)}?v=${encodeURIComponent(photo.id)}` : null;
    return {
      id: cardId,
      title,
      url: `${ctx.hubUrl}household/#house`,
      glance: {
        headline: place.name,
        detail: firstDetail(next[0]) ?? "Nothing due soon",
        emoji: "🏠",
        ...(url ? { image: url } : {}),
      },
      data: {
        place: { id: place.id, name: place.name, address: place.address ?? null },
        photo: photo ? { url, width: photo.width ?? null, height: photo.height ?? null } : null,
        next,
      },
    };
  });
}
