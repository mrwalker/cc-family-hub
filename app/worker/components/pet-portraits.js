/**
 * pet-portraits: one card per pet, over its photo, with what's next for it. The
 * photos are uploaded on /household/; a pet with several shows a different one each
 * turn. A pet without a photo still gets its card, with no image.
 *
 * No household database, or no pets: no cards.
 *
 *   data: { pet: { id, name, species, age }, photo: { url, width, height } | null,
 *           next: [{ title, kind, emoji, when, date, overdue }] }   (up to 3)
 */

import { AREAS, whenOf } from "../household.js";
import { daysBetween, dayName, dateLabel } from "../util.js";

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

/** "The dogs", "The cats", or "The pets". */
function titleFor(pets) {
  const kinds = new Set(pets.map(p => String(p.species || "").toLowerCase()));
  const one = kinds.size === 1 ? [...kinds][0] : "";
  return one && /^[a-z]+$/.test(one) ? `The ${one}s` : "The pets";
}

export async function cards(ctx) {
  const pets = await ctx.pets();
  if (!pets?.length) return [];
  const tasks = (await ctx.household()) ?? [];
  const kinds = AREAS.pets.kinds;
  const title = titleFor(pets);
  return pets.map(pet => {
    const next = tasks
      .filter(t => t.area === "pets" && t.petId === pet.id && whenOf(t))
      .map(t => ({ t, days: daysBetween(ctx.today, whenOf(t)) }))
      .sort((a, b) => a.days - b.days)
      .slice(0, 3)
      .map(({ t, days }) => ({
        title: t.title, kind: t.kind, emoji: kinds[t.kind]?.emoji ?? "🐾",
        date: whenOf(t), overdue: days < 0,
        when: days < 0 ? `overdue since ${dateLabel(whenOf(t), ctx.locale, { month: "short", day: "numeric" })}` : dayName(whenOf(t), ctx.today, ctx.locale),
      }));
    // A different photo each turn, when there's more than one.
    const photo = pet.photos?.length ? pet.photos[ctx.turn % pet.photos.length] : null;
    const cardId = `pet-portraits:${pet.id}`;
    const url = photo ? `${ctx.image(cardId)}?v=${encodeURIComponent(photo.id)}` : null;
    const age = ageOf(pet.birthday, ctx.today);
    const first = next[0];
    return {
      id: cardId,
      title,
      url: `${ctx.hubUrl}household/#pets`,
      glance: {
        headline: pet.name,
        detail: first ? `${first.title} ${first.overdue ? "overdue" : first.when === "Today" || first.when === "Tomorrow" ? first.when.toLowerCase() : first.when}` : age ?? (pet.species || ""),
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
