/**
 * workouts: the last week's activities for each person, from Strava.
 *
 *   data: { members: [{ id, activities: [{ name, type, startDate, distance, movingTime }] }] }
 */

export const id = "workouts";
const WINDOW_DAYS = 7;

export async function cards(ctx) {
  const strava = await ctx.data("strava");
  const since = ctx.now.getTime() - WINDOW_DAYS * 86_400_000;
  const members = Object.entries(strava?.members ?? {})
    .filter(([id]) => !ctx.view || id === ctx.view.id)
    .map(([id, list]) => ({
      id,
      activities: (Array.isArray(list) ? list : [])
        .filter(a => Date.parse(a.startDate) >= since)
        .map(a => ({ name: a.name ?? "", type: a.type ?? null, startDate: a.startDate,
                     distance: a.distance ?? null, movingTime: a.movingTime ?? null })),
    }))
    .filter(m => m.activities.length);
  if (!members.length) return [];
  const all = members.flatMap(m => m.activities);
  const miles = all.reduce((s, a) => s + (a.distance || 0), 0) / 1609.344;
  return [{
    id: "workouts",
    title: "Workouts",
    url: `${ctx.hubUrl}#workouts`,
    glance: {
      headline: `${all.length} workout${all.length === 1 ? "" : "s"}`,
      detail: miles >= 0.1 ? `This week · ${miles.toFixed(1)} mi` : "This week",
      emoji: "🏃",
    },
    data: { members },
  }];
}
