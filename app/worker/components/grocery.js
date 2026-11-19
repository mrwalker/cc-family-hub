/**
 * grocery: the shared shopping list. No card when there's nothing to buy.
 *
 *   data: { items: [{ id, name, quantity, store?, addedBy?, done }] }   (to buy first)
 */

import { sortItems } from "../grocery.js";
import { clip } from "../util.js";

export const id = "grocery";

export async function cards(ctx) {
  const items = sortItems(await ctx.grocery());
  const toBuy = items.filter(i => !i.done);
  if (!toBuy.length) return [];
  const n = toBuy.length;
  return [{
    id: "grocery",
    title: "Grocery list",
    url: `${ctx.hubUrl}#grocery`,
    glance: {
      headline: `${n} item${n === 1 ? "" : "s"}`,
      detail: clip(toBuy.map(i => i.name).join(", "), 60),
      emoji: "🛒",
    },
    data: { items: items.map(({ id, name, quantity, store, addedBy, done }) =>
      ({ id, name, quantity, ...(store ? { store } : {}), ...(addedBy ? { addedBy } : {}), done })) },
  }];
}
