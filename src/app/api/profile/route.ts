import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/server/store";

export const runtime = "nodejs";

/** GET — full own profile: stats, rating history, match history, latest scan audit. */
export async function GET(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const store = getStore();
  const session = await store.getSession(token);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const player = await store.getPlayer(session.playerId);
  if (!player) return NextResponse.json({ error: "gone" }, { status: 404 });

  const [ratings, matches, scan] = await Promise.all([
    store.ratingHistory(player.id, 60),
    store.matchHistory(player.id, 25),
    store.latestScan(player.id),
  ]);

  return NextResponse.json({
    player: {
      id: player.id,
      handle: player.handle,
      region: player.region,
      psl: player.psl,
      pslConfidence: player.pslConfidence,
      scanVersion: player.scanVersion,
      elo: player.elo,
      peakElo: player.peakElo,
      wins: player.wins,
      losses: player.losses,
      streak: player.streak,
      bestStreak: player.bestStreak,
      casualWins: player.casualWins,
      casualLosses: player.casualLosses,
      createdAt: player.createdAt,
    },
    ratings,
    matches,
    scan: scan
      ? {
          id: scan.id,
          psl: scan.psl,
          confidence: scan.confidence,
          version: scan.version,
          createdAt: scan.createdAt,
          quality: scan.quality,
          components: scan.components,
        }
      : null,
  });
}
