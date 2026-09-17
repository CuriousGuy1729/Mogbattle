import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/server/store";
import { SEASON_LABEL, SEASON_START, weekStartIso } from "@/server/season";

export const runtime = "nodejs";

/** GET ?board=global|weekly|season|region&region=eu */
export async function GET(req: NextRequest) {
  const board = req.nextUrl.searchParams.get("board") ?? "global";
  const region = req.nextUrl.searchParams.get("region") ?? undefined;
  const store = getStore();

  if (board === "weekly") {
    return NextResponse.json({ board, since: weekStartIso(), rows: await store.weeklyLeaderboard(weekStartIso(), 100) });
  }
  if (board === "season") {
    const rows = await store.weeklyLeaderboard(SEASON_START, 100);
    return NextResponse.json({ board, since: SEASON_START, label: SEASON_LABEL, rows });
  }
  if (board === "region") {
    return NextResponse.json({ board, region: region ?? "global", rows: await store.leaderboard("region", region ?? "global", 100) });
  }
  return NextResponse.json({ board: "global", rows: await store.leaderboard("global", undefined, 100) });
}
