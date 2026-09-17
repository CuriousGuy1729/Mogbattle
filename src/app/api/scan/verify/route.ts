import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getStore } from "@/server/store";
import { getLimiter } from "@/server/limiter";
import { takeScanSession, verifyEvidence, type ChallengeEvidence } from "@/server/scanSessions";
import { validateAttestation } from "@/server/attest";
import { scanTtlMs } from "@/server/matchmaker";
import type { BattleAttestation } from "@/lib/psl/types";

export const runtime = "nodejs";

/**
 * POST — certify a face-verification scan.
 *
 * The server cross-checks:
 *   1. the session was issued by the server and is unused + unexpired
 *   2. the per-challenge liveness evidence matches the issued order and
 *      passes all thresholds (randomized order defeats replayed clips)
 *   3. the attestation comes from the pinned scoring model (version + hash)
 *      with passing quality gates and complete components
 *   4. the capture digest is not a duplicate of another player's scan
 *      (replay / shared-input detection)
 *
 * Only then is the PSL score recorded. No face image is ever transmitted.
 */
export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const store = getStore();
  const session = await store.getSession(token);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const playerId = session.playerId;

  const rl = await getLimiter().hit(`scan-verify:${playerId}`, 60 * 60_000, 12);
  if (!rl.allowed)
    return NextResponse.json({ error: "rate_limited", message: "Scan rate limit reached. Try again in a bit." }, { status: 429 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body.sessionId !== "string" || !Array.isArray(body.evidence))
    return NextResponse.json({ error: "malformed" }, { status: 400 });

  const scanSession = takeScanSession(body.sessionId, playerId);
  if (!scanSession)
    return NextResponse.json(
      { error: "session_invalid", message: "Verification session expired or already used. Start a new scan." },
      { status: 410 }
    );

  const verdict = verifyEvidence(scanSession.challenges, body.evidence as ChallengeEvidence[]);
  if (!verdict.ok)
    return NextResponse.json({ error: "liveness_failed", message: verdict.reason, rescan: true }, { status: 422 });

  const attestation = body.attestation as BattleAttestation;
  const va = validateAttestation(attestation);
  if (!va.ok)
    return NextResponse.json({ error: "attestation_invalid", message: va.reason, rescan: true }, { status: 422 });

  // Duplicate / replay detection across the whole player base.
  const dup = await store.countScansByDigest(attestation.digest, playerId);
  if (dup > 0) {
    await store.updatePlayer(playerId, { flagged: true });
    await store.addReport(playerId, playerId, null, `auto: duplicate capture digest (${dup} prior match)`);
    return NextResponse.json(
      {
        error: "duplicate_capture",
        message: "This exact capture signature was already used by another account. If this is you on another device, play there.",
        rescan: false,
      },
      { status: 403 }
    );
  }

  // Recent-rescan throttle sanity (extra defense in depth).
  const recent = await store.countScansSince(playerId, new Date(Date.now() - 5 * 60_000).toISOString());
  if (recent >= 6)
    return NextResponse.json({ error: "rate_limited", message: "Too many scans in a short window.", rescan: false }, { status: 429 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const scanId = crypto.randomUUID();
  await store.createScan({
    id: scanId,
    playerId,
    version: attestation.version,
    psl: attestation.score,
    confidence: attestation.confidence,
    quality: { ...attestation.quality } as Record<string, number>,
    components: attestation.components,
    digest: attestation.digest,
    challengeLog: { challenges: scanSession.challenges, evidence: body.evidence },
    ip,
    createdAt: new Date().toISOString(),
  });

  await store.updatePlayer(playerId, {
    psl: attestation.score,
    pslConfidence: attestation.confidence,
    scanVersion: attestation.version,
  });

  return NextResponse.json({
    scanId,
    psl: attestation.score,
    confidence: attestation.confidence,
    version: attestation.version,
    validForMs: scanTtlMs(),
    quality: attestation.quality,
    components: attestation.components,
  });
}
