/**
 * pet-portraits: one card per pet, over its photo, with what's next for it. The
 * photos are uploaded on /household/; a pet with several shows a different one each
 * turn. A pet without a photo still gets its card, with no image.
 *
 * No household database, or no pets: no cards.
 *
 *   data: { pet: { id, name, species, age }, photo: { url, width, height } | null,
 *           next: [{ title, kind, emoji, when, date, overdue, note }] }   (up to 3)
 *
 * `note` says what the pets component's card would: "not booked yet", the time, who
 * does it, or when a stay ends. So a family can show these cards instead of those.
 */

import { upcoming, firstDetail } from "./tasks.js";

export const id = "pet-portraits";

/** Every pet each pass, rather than taking turns three at a time. */
export const max = 12;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "4 years old", "8 months old", or null. */
export function ageOf(birthday, today) {
  if (!birthday) return null;
  const [y, m, d] = birthday.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  let months = (ty - y) * 12 + (tm - m) - (td < d ? 1 : 0);
  if (months < 0) return null;
  return months < 24 ? `${plural(months, "month")} old` : `${plural(Math.floor(months / 12), "year")} old`;
}

/** "Dogs", "Cats", or "Pets". */
export function titleFor(pets) {
  const kinds = new Set(pets.map(p => String(p.species || "").toLowerCase()));
  const one = kinds.size === 1 ? [...kinds][0] : "";
  return one && /^[a-z]+$/.test(one) ? `${one[0].toUpperCase()}${one.slice(1)}s` : "Pets";
}

export async function cards(ctx) {
  const pets = await ctx.pets();
  if (!pets?.length) return [];
  const tasks = (await ctx.household()) ?? [];
  const title = titleFor(pets);
  return pets.map(pet => {
    const next = upcoming(ctx, tasks, "pets", t => t.petId === pet.id);
    // A different photo each turn, when there's more than one.
    const photo = pet.photos?.length ? pet.photos[ctx.turn % pet.photos.length] : null;
    const cardId = `pet-portraits:${pet.id}`;
    const url = photo ? `${ctx.image(cardId)}?v=${encodeURIComponent(photo.id)}` : null;
    const age = ageOf(pet.birthday, ctx.today);
    return {
      id: cardId,
      title,
      url: `${ctx.hubUrl}household/#pets`,
      glance: {
        headline: pet.name,
        detail: firstDetail(next[0]) ?? age ?? (pet.species || ""),
        emoji: "🐾",
        ...(url ? { image: url } : {}),
      },
      data: {
        pet: { id: pet.id, name: pet.name, species: pet.species ?? null, age },
        photo: photo ? { url, width: photo.width ?? null, height: photo.height ?? null } : null,
        next,
      },
    };
  });
}
