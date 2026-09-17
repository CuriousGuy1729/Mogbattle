import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/server/store";
import { getLimiter } from "@/server/limiter";

export const runtime = "nodejs";

const REASONS = new Set(["cheating", "inappropriate", "fake_video", "harassment", "other"]);

/** POST {targetId, reason, matchId?} */
export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const store = getStore();
  const session = await store.getSession(token);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = await getLimiter().hit(`report:${session.playerId}`, 60 * 60_000, 10);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const body = await req.json().catch(() => null);
  const targetId = typeof body?.targetId === "string" ? body.targetId : null;
  const reason = REASONS.has(body?.reason) ? body.reason : "other";
  if (!targetId || targetId === session.playerId) return NextResponse.json({ error: "malformed" }, { status: 400 });
  const target = await store.getPlayer(targetId);
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await store.addReport(session.playerId, targetId, typeof body?.matchId === "string" ? body.matchId : null, reason);
  const count = await store.countReportsAgainst(targetId);

  // Auto-flag heavily reported accounts for manual review.
  if (count >= 5) await store.updatePlayer(targetId, { flagged: true });

  return NextResponse.json({ ok: true });
}
