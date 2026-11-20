/**
 * escape-rooms: one room you've played (they take turns), over its picture when it
 * has one: its name, how it went, where and when. The record is in the title
 * ("Escape rooms · 21 of 25"). The rooms are the hub's own (rooms.js); before a family
 * imports its old list, the published escape-rooms.yaml list is used.
 *
 *   data: { record: { escaped, total },
 *           room: { id, venue, room, city, date, solved, escapeTime, who, url, image } }
 */

import { dateLabel } from "../util.js";

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
  const image = kept && r.imageUrl ? `${ctx.image(`escape-rooms:${r.id}`)}?v=${r.imageVersion ?? ""}` : null;
  // The room leads (over its picture); the family's record rides in the title.
  const result = r.solved
    ? (r.escapeTime === "-10 seconds" ? "Escaped at the buzzer" : r.escapeTime ? `Escaped in ${r.escapeTime}` : "Escaped")
    : "Didn't escape";
  const when = r.date ? (r.approxDate ? r.date.slice(0, 4) : dateLabel(r.date, ctx.locale, { month: "short", year: "numeric" })) : null;
  return [{
    id: "escape-rooms",
    title: `Escape rooms · ${escaped} of ${rooms.length}`,
    url: `${ctx.hubUrl}#escape-rooms`,
    glance: {
      headline: r.room,
      detail: [result, r.venue, when].filter(Boolean).join(" · "),
      // Over a picture, an emoji only gets in the way.
      ...(image ? { image } : { emoji: "🔐" }),
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
