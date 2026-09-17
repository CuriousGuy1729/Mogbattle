import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/server/store";
import { getLimiter } from "@/server/limiter";
import { createScanSession } from "@/server/scanSessions";

export const runtime = "nodejs";

/**
 * POST — issue a fresh, randomized liveness challenge sequence.
 * Rate-limited per player: flooding scan sessions is itself a red flag.
 */
export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const session = await getStore().getSession(token);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = await getLimiter().hit(`scan-session:${session.playerId}`, 60 * 60_000, 8);
  if (!rl.allowed)
    return NextResponse.json({ error: "rate_limited", message: "Too many scan sessions. Try again later." }, { status: 429 });

  const s = createScanSession(session.playerId);
  return NextResponse.json({
    sessionId: s.sessionId,
    challenges: s.challenges,
    createdAt: s.createdAt,
    expiresInMs: 5 * 60_000,
  });
}
