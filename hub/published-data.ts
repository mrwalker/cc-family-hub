/**
 * The data a hub page displays besides the plan: trips, escape rooms, movies
 * (from workspace YAML) and Strava activities (from sync state).
 *
 * Output integrations (hub-api, github-pages) publish these alongside the plan.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { ws, STATE_DIR } from "./paths.js";

export interface FamilyData {
  generatedAt: string;
  trips: unknown[];
  escapeRooms: unknown[];
  movies: unknown[];
}

export interface StravaData {
  generatedAt?: string;
  members: Record<string, unknown[]>;
}

function readYamlList(file: string): unknown[] {
  const p = ws(file);
  if (!existsSync(p)) return [];
  const raw = yaml.load(readFileSync(p, "utf8"));
  return Array.isArray(raw) ? raw : [];
}

export function buildFamilyData(): FamilyData {
  return {
    generatedAt: new Date().toISOString(),
    trips: readYamlList("trips.yaml"),
    escapeRooms: readYamlList("escape-rooms.yaml"),
    movies: readYamlList("movies.yaml"),
  };
}

/** Strava activities from the last sync, or null if Strava has never synced. */
export function loadStravaData(): StravaData | null {
  const p = join(STATE_DIR, "strava-activities.yaml");
  if (!existsSync(p)) return null;
  const raw = yaml.load(readFileSync(p, "utf8")) as Partial<StravaData> | null;
  return { ...(raw ?? {}), members: raw?.members ?? {} };
}
