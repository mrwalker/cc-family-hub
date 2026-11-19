/**
 * escape-rooms: your record, and one room you've played (they take turns).
 *
 *   data: { record: { escaped, total },
 *           room: { venue, room, city, date, solved, escapeTime, who } }
 */

export const id = "escape-rooms";

export async function cards(ctx) {
  const family = await ctx.data("family");
  const rooms = (Array.isArray(family?.escapeRooms) ? family.escapeRooms : [])
    .filter(r => r?.room)
    .filter(r => !ctx.view || !Array.isArray(r.who) || r.who.includes(ctx.view.id))
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  if (!rooms.length) return [];
  const escaped = rooms.filter(r => r.solved).length;
  const r = rooms[ctx.turn % rooms.length];
  return [{
    id: "escape-rooms",
    title: "Escape rooms",
    url: `${ctx.hubUrl}#escape-rooms`,
    glance: {
      headline: `${escaped} of ${rooms.length} escaped`,
      detail: [r.room, r.venue].filter(Boolean).join(" · "),
      emoji: "🔐",
    },
    data: {
      record: { escaped, total: rooms.length },
      room: {
        venue: r.venue ?? null, room: r.room, city: r.city ?? null, date: r.date ?? null,
        solved: !!r.solved, escapeTime: r.escapeTime ?? null, who: Array.isArray(r.who) ? r.who : [],
      },
    },
  }];
}
