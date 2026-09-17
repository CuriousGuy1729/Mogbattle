import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/server/store";

export const runtime = "nodejs";

/** POST {targetId} — blocks matchmaking between you and that player. */
export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const store = getStore();
  const session = await store.getSession(token);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const targetId = typeof body?.targetId === "string" ? body.targetId : null;
  if (!targetId || targetId === session.playerId) return NextResponse.json({ error: "malformed" }, { status: 400 });

  await store.addBlock(session.playerId, targetId);
  return NextResponse.json({ ok: true });
}
