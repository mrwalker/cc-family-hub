/**
 * Strava — Input Integration
 *
 * Fetches recent activities for each configured family member and writes
 * them to workspace/state/strava-activities.yaml for the portal to display.
 *
 * Each member needs their own OAuth refresh token (one-time setup per person).
 * A single shared Strava API app (clientId + clientSecret) serves all members.
 *
 * Required config (workspace/state/secrets.yaml):
 *   strava:
 *     clientId: "12345"
 *     clientSecret: "abc..."
 *     members:
 *       emma:
 *         refreshToken: "..."
 *       matt:
 *         refreshToken: "..."
 *
 * Run `npm run setup:strava` once per member to complete the OAuth flow.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { BaseIntegration } from "../../_base/BaseIntegration.js";
import type { InputIntegration } from "../../_base/types.js";

interface StravaSecrets {
  clientId: string;
  clientSecret: string;
  members: Record<string, { refreshToken: string }>;
}

export interface StravaActivity {
  id: number;
  name: string;
  type: string;        // "Run", "Ride", "Walk", etc.
  sportType: string;
  startDate: string;   // ISO 8601 UTC
  distance: number;    // meters
  movingTime: number;  // seconds
  elapsedTime: number; // seconds
  totalElevationGain: number; // meters
  averageSpeed: number;  // m/s
  maxSpeed: number;      // m/s
  averageHeartrate?: number;
  maxHeartrate?: number;
  kudosCount: number;
  memberId: string;
}

const TOKEN_URL = "https://www.strava.com/api/v3/oauth/token";
const ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";
const ACTIVITIES_PER_MEMBER = 20;

export default class StravaInput extends BaseIntegration implements InputIntegration {
  readonly id = "strava";
  readonly displayName = "Strava";

  async healthCheck(): Promise<void> {
    const secrets = this.loadSecrets<StravaSecrets>();
    this.requireSecretKeys(secrets as unknown as Record<string, unknown>, ["clientId", "clientSecret", "members"]);
    if (!secrets.members || Object.keys(secrets.members).length === 0) {
      throw new Error("strava: no members configured. Run npm run setup:strava to add a member.");
    }
    // Verify at least one member token refreshes successfully
    const [firstMemberId, firstMember] = Object.entries(secrets.members)[0];
    await this.refreshAccessToken(secrets, firstMember.refreshToken, firstMemberId);
  }

  async fetchActivities(): Promise<Record<string, StravaActivity[]>> {
    const secrets = this.loadSecrets<StravaSecrets>();
    const result: Record<string, StravaActivity[]> = {};

    for (const [memberId, memberSecrets] of Object.entries(secrets.members)) {
      try {
        const { accessToken, newRefreshToken } = await this.refreshAccessToken(
          secrets,
          memberSecrets.refreshToken,
          memberId
        );

        // Persist the new refresh token immediately
        if (newRefreshToken !== memberSecrets.refreshToken) {
          this.saveRefreshToken(memberId, newRefreshToken);
        }

        const activities = await this.fetchMemberActivities(accessToken, memberId);
        result[memberId] = activities;
        console.log(`  ✓ Strava ${memberId}: ${activities.length} activities`);
      } catch (err) {
        console.warn(`  ⚠ Strava ${memberId}: ${(err as Error).message}`);
        result[memberId] = [];
      }
    }

    return result;
  }

  private async refreshAccessToken(
    secrets: StravaSecrets,
    refreshToken: string,
    memberId: string
  ): Promise<{ accessToken: string; newRefreshToken: string }> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: secrets.clientId,
        client_secret: secrets.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed for ${memberId}: ${res.status} ${text}`);
    }

    const data = await res.json() as { access_token: string; refresh_token: string };
    return { accessToken: data.access_token, newRefreshToken: data.refresh_token };
  }

  private async fetchMemberActivities(
    accessToken: string,
    memberId: string
  ): Promise<StravaActivity[]> {
    const url = `${ACTIVITIES_URL}?per_page=${ACTIVITIES_PER_MEMBER}&page=1`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Activities fetch failed: ${res.status} ${text}`);
    }

    const raw = await res.json() as Record<string, unknown>[];
    return raw.map((a) => ({
      id: Number(a.id),
      name: String(a.name ?? ""),
      type: String(a.type ?? ""),
      sportType: String(a.sport_type ?? a.type ?? ""),
      startDate: String(a.start_date ?? ""),
      distance: Number(a.distance ?? 0),
      movingTime: Number(a.moving_time ?? 0),
      elapsedTime: Number(a.elapsed_time ?? 0),
      totalElevationGain: Number(a.total_elevation_gain ?? 0),
      averageSpeed: Number(a.average_speed ?? 0),
      maxSpeed: Number(a.max_speed ?? 0),
      ...(a.average_heartrate != null ? { averageHeartrate: Number(a.average_heartrate) } : {}),
      ...(a.max_heartrate != null ? { maxHeartrate: Number(a.max_heartrate) } : {}),
      kudosCount: Number(a.kudos_count ?? 0),
      memberId,
    }));
  }

  private saveRefreshToken(memberId: string, newToken: string): void {
    const secretsPath = join(process.cwd(), "workspace", "state", "secrets.yaml");
    if (!existsSync(secretsPath)) return;
    const all = yaml.load(readFileSync(secretsPath, "utf8")) as Record<string, unknown>;
    const strava = all["strava"] as StravaSecrets;
    if (strava?.members?.[memberId]) {
      strava.members[memberId].refreshToken = newToken;
      writeFileSync(secretsPath, yaml.dump(all), "utf8");
    }
  }
}
