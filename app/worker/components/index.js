/** Every stream component, in the default rotation order (docs/stream.md). */

import * as today from "./today.js";
import * as week from "./week.js";
import * as plan from "./plan.js";
import * as pets from "./pets.js";
import * as photos from "./photos.js";
import * as trips from "./trips.js";
import * as pastTrips from "./past-trips.js";
import * as grocery from "./grocery.js";
import * as escapeRooms from "./escape-rooms.js";
import * as movies from "./movies.js";
import * as workouts from "./workouts.js";

export const COMPONENTS = [today, week, plan, pets, photos, trips, pastTrips, grocery, escapeRooms, movies, workouts];
export const COMPONENT_IDS = COMPONENTS.map(c => c.id);
export const byId = Object.fromEntries(COMPONENTS.map(c => [c.id, c]));
