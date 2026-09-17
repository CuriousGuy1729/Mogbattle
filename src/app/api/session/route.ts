import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getStore, type Player } from "@/server/store";
import { getLimiter } from "@/server/limiter";
import { scanTtlMs } from "@/server/matchmaker";

export const runtime = "nodejs";

const HANDLE_RE = /^[A-Za-z0-9_]{3,18}$/;
const REGIONS = ["global", "na", "sa", "eu", "mena", "asia", "oce", "africa"];

function clientIp(req: NextRequest) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "local";
}

async function auth(req: NextRequest): Promise<{ token: string; playerId: string } | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!token) return null;
  const session = await getStore().getSession(token);
  return session ? { token, playerId: session.playerId } : null;
}

/** POST — create an anonymous player + session token. */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const rl = await getLimiter().hit(`session:${ip}`, 60 * 60_000, 60);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  const store = getStore();
  let handle = typeof body.handle === "string" && HANDLE_RE.test(body.handle) ? body.handle : null;
  if (!handle) handle = `Challenger-${crypto.randomInt(1000, 9999)}`;
  // handles are display names; identity is the session token, not the name.
  const region = REGIONS.includes(body.region) ? body.region : "global";
  const player = await store.createPlayer(handle, region);
  const token = crypto.randomBytes(32).toString("hex");
  await store.createSession(token, player.id, ip, req.headers.get("user-agent"));
  return NextResponse.json({ token, player: publicPlayer(player) });
}

/** GET — current profile + latest scan summary. */
export async function GET(req: NextRequest) {
  const a = await auth(req);
  if (!a) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const store = getStore();
  const player = await store.getPlayer(a.playerId);
  if (!player) return NextResponse.json({ error: "gone" }, { status: 404 });
  const scan = await store.latestScan(player.id);
  return NextResponse.json({
    player: publicPlayer(player),
    scan: scan
      ? {
          id: scan.id,
          psl: scan.psl,
          confidence: scan.confidence,
          version: scan.version,
          createdAt: scan.createdAt,
          validForMs: scanTtlMs(),
          stillValidMs: Math.max(0, scanTtlMs() - (Date.now() - Date.parse(scan.createdAt))),
          quality: scan.quality,
          components: scan.components,
        }
      : null,
  });
}

/** PATCH — update handle / region. */
export async function PATCH(req: NextRequest) {
  const a = await auth(req);
  if (!a) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await getLimiter().hit(`patch:${a.playerId}`, 60_000, 6);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const body = await req.json().catch(() => ({}));
  const patch: Partial<Player> = {};
  if (typeof body.handle === "string" && HANDLE_RE.test(body.handle)) patch.handle = body.handle;
  if (typeof body.region === "string" && REGIONS.includes(body.region)) patch.region = body.region;
  const player = await getStore().updatePlayer(a.playerId, patch);
  if (!player) return NextResponse.json({ error: "gone" }, { status: 404 });
  return NextResponse.json({ player: publicPlayer(player) });
}

function publicPlayer(p: Player) {
  const total = p.wins + p.losses;
  return {
    id: p.id,
    handle: p.handle,
    region: p.region,
    createdAt: p.createdAt,
    psl: p.psl,
    pslConfidence: p.pslConfidence,
    scanVersion: p.scanVersion,
    elo: p.elo,
    peakElo: p.peakElo,
    wins: p.wins,
    losses: p.losses,
    winRate: total ? Math.round((p.wins / total) * 1000) / 10 : null,
    streak: p.streak,
    bestStreak: p.bestStreak,
    casualWins: p.casualWins,
    casualLosses: p.casualLosses,
  };
}
