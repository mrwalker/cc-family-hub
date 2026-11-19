/**
 * photos: one card per photo from the family's iCloud shared album, shuffled.
 *
 *   data: { photo: { id, width, height, takenAt } }
 */

import { shuffled, dateLabel, ymd } from "../util.js";

export const id = "photos";

/** Every album photo as a card, in a shuffled order that changes each minute. */
export async function cards(ctx) {
  const album = await ctx.photos();
  if (!album?.length) return [];
  return shuffled(album, ctx.photoSeed).map(p => photoCard(ctx, p));
}

export function photoCard(ctx, p) {
  const cardId = `photos:${p.id}`;
  return {
    id: cardId,
    title: "Photos",
    url: `${ctx.hubUrl}#photos`,
    glance: {
      headline: p.takenAt ? dateLabel(ymd(new Date(p.takenAt), ctx.tz), ctx.locale, { month: "long", day: "numeric", year: "numeric" }) : "Family photos",
      detail: "",
      image: ctx.image(cardId),
    },
    data: { photo: { id: p.id, width: p.width, height: p.height, takenAt: p.takenAt } },
  };
}
