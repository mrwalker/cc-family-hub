/**
 * escape-rooms: your record, and one room you've played (they take turns), over its
 * picture when it has one. The rooms are the hub's own (rooms.js); before a family
 * imports its old list, the published escape-rooms.yaml list is used.
 *
 *   data: { record: { escaped, total },
 *           room: { id, venue, room, city, date, solved, escapeTime, who, url, image } }
 */

export const id = "escape-rooms";

export async function cards(ctx) {
  const kept = typeof ctx.rooms === "function" ? await ctx.rooms() : null;
  const family = kept ? null : await ctx.data("family");
  const rooms = (kept ?? (Array.isArray(family?.escapeRooms) ? family.escapeRooms : []))
    .filter(r => r?.room)
    .filter(r => !ctx.view || !Array.isArray(r.who) || r.who.includes(ctx.view.id))
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  if (!rooms.length) return [];
  const escaped = rooms.filter(r => r.solved).length;
  const r = rooms[ctx.turn % rooms.length];
  const image = kept && r.imageUrl ? ctx.image(`escape-rooms:${r.id}`) : null;
  return [{
    id: "escape-rooms",
    title: "Escape rooms",
    url: `${ctx.hubUrl}#escape-rooms`,
    glance: {
      headline: `${escaped} of ${rooms.length} escaped`,
      detail: [r.room, r.venue].filter(Boolean).join(" · "),
      emoji: "🔐",
      ...(image ? { image } : {}),
    },
    data: {
      record: { escaped, total: rooms.length },
      room: {
        id: r.id ?? null, venue: r.venue ?? null, room: r.room, city: r.city ?? null, date: r.date ?? null,
        solved: !!r.solved, escapeTime: r.escapeTime ?? null, who: Array.isArray(r.who) ? r.who : [],
        url: r.url ?? null, image,
      },
    },
  }];
}
