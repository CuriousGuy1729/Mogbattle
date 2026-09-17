/** Season configuration. Season 1 launched with the platform. */
export const SEASON_START = process.env.SEASON_START || "2026-09-01T00:00:00.000Z";
export const SEASON_LABEL = "Season 1";

export function weekStartIso(): string {
  const now = new Date();
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
  return monday.toISOString();
}
