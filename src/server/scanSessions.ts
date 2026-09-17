/**
 * Server-issued liveness challenge sessions.
 *
 * The middle challenges are shuffled per session, so a pre-recorded video or
 * a static image cannot anticipate the sequence — the client must respond to
 * prompts in the order and timing the server demanded. Evidence for every
 * challenge is validated server-side before a scan is certified.
 */
import crypto from "node:crypto";

export type ChallengeId = "neutral_start" | "turn_left" | "turn_right" | "blink" | "neutral_end";

export interface ScanSession {
  sessionId: string;
  playerId: string;
  challenges: ChallengeId[];
  createdAt: number;
  used: boolean;
}

/** globalThis slot so all route chunks share one registry (see store.ts). */
const G = globalThis as unknown as { __mogbattle_scan_sessions?: Map<string, ScanSession> };
if (!G.__mogbattle_scan_sessions) G.__mogbattle_scan_sessions = new Map();
const sessions = G.__mogbattle_scan_sessions;

export const SCAN_SESSION_TTL_MS = 5 * 60 * 1000;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createScanSession(playerId: string): ScanSession {
  if (sessions.size > 5000) {
    const now = Date.now();
    for (const [k, s] of sessions) if (now - s.createdAt > SCAN_SESSION_TTL_MS) sessions.delete(k);
  }
  const middle = shuffle<ChallengeId>(["turn_left", "turn_right", "blink"]);
  const s: ScanSession = {
    sessionId: crypto.randomUUID(),
    playerId,
    challenges: ["neutral_start", ...middle, "neutral_end"],
    createdAt: Date.now(),
    used: false,
  };
  sessions.set(s.sessionId, s);
  return s;
}

/** Consumes the session (single-use → replay of an old session is rejected). */
export function takeScanSession(sessionId: string, playerId: string): ScanSession | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  sessions.delete(sessionId);
  if (s.playerId !== playerId) return null;
  if (s.used) return null;
  if (Date.now() - s.createdAt > SCAN_SESSION_TTL_MS) return null;
  s.used = true;
  return s;
}

export interface ChallengeEvidence {
  id: ChallengeId;
  durationMs: number;
  facePresence: number;
  medianYawDeg?: number;
  maxYawDeg?: number;
  minYawDeg?: number;
  medianRollDeg?: number;
  minEar?: number;
  blinkCount?: number;
}

export interface EvidenceVerdict {
  ok: boolean;
  reason?: string;
}

import { LIVENESS } from "@/lib/psl/version";

/** Validates the per-challenge evidence against the issued sequence. */
export function verifyEvidence(issued: ChallengeId[], evidence: ChallengeEvidence[]): EvidenceVerdict {
  if (!Array.isArray(evidence) || evidence.length !== issued.length)
    return { ok: false, reason: "evidence does not match challenge sequence" };

  for (let i = 0; i < issued.length; i++) {
    const id = issued[i];
    const ev = evidence[i];
    if (!ev || ev.id !== id) return { ok: false, reason: "challenge order mismatch" };
    if (!(ev.durationMs >= LIVENESS.challengeMinMs && ev.durationMs <= LIVENESS.challengeMaxMs))
      return { ok: false, reason: `challenge ${id} timing implausible` };
    if (!(typeof ev.facePresence === "number" && ev.facePresence >= 0.75))
      return { ok: false, reason: `challenge ${id}: insufficient face presence` };

    switch (id) {
      case "neutral_start":
      case "neutral_end":
        if (Math.abs(ev.medianYawDeg ?? 99) > LIVENESS.neutralYawMaxDeg)
          return { ok: false, reason: "not facing camera during neutral hold" };
        if (Math.abs(ev.medianRollDeg ?? 99) > LIVENESS.neutralRollMaxDeg)
          return { ok: false, reason: "head tilt too large during neutral hold" };
        break;
      case "turn_left":
        if (!((ev.maxYawDeg ?? 0) >= LIVENESS.turnThresholdDeg))
          return { ok: false, reason: "left turn not detected" };
        break;
      case "turn_right":
        if (!((ev.minYawDeg ?? 0) <= -LIVENESS.turnThresholdDeg))
          return { ok: false, reason: "right turn not detected" };
        break;
      case "blink":
        if (!((ev.minEar ?? 1) <= LIVENESS.blinkEarMin) || (ev.blinkCount ?? 0) < 1)
          return { ok: false, reason: "blink not detected" };
        break;
    }
  }
  return { ok: true };
}
