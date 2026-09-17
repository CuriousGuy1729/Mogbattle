/**
 * Server-side validation of client attestations (scan verify + battle scores).
 *
 * The PSL pipeline runs on-device for privacy (no face images ever leave the
 * device). The server therefore validates the *attestation*: model version,
 * pinned model hash, component completeness, plausibility ranges and capture
 * quality gates. A number is only ever accepted from the documented pipeline.
 */
import crypto from "node:crypto";
import type { BattleAttestation } from "@/lib/psl/types";
import {
  GROUP_WEIGHTS,
  METRIC_KEYS,
  MIN_SCAN_CONFIDENCE,
  MODEL_CONSTANT_BLOB,
  PSL_MODEL_VERSION,
  SCORE_CLAMP,
} from "@/lib/psl/version";

export const envMinConfidence = () =>
  Math.max(0.3, Math.min(0.95, parseFloat(process.env.MIN_SCAN_CONFIDENCE || "") || MIN_SCAN_CONFIDENCE));

export function expectedModelHash(): string {
  return crypto.createHash("sha256").update(MODEL_CONSTANT_BLOB).digest("hex").slice(0, 16);
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function validateAttestation(a: BattleAttestation): { ok: true } | { ok: false; reason: string } {
  if (!a || typeof a !== "object") return { ok: false, reason: "malformed attestation" };
  if (a.version !== PSL_MODEL_VERSION) return { ok: false, reason: `unsupported model version (${a.version})` };
  if (a.modelHash !== expectedModelHash()) return { ok: false, reason: "model hash mismatch (tampered client)" };
  if (!fin(a.score) || a.score < SCORE_CLAMP[0] - 1e-9 || a.score > SCORE_CLAMP[1] + 1e-9)
    return { ok: false, reason: "score outside valid range" };
  if (!fin(a.confidence) || a.confidence < envMinConfidence())
    return { ok: false, reason: "capture confidence below threshold — rescan required" };

  const q = a.quality;
  if (
    !q ||
    !fin(q.brightness) || q.brightness < 0 || q.brightness > 255 ||
    !fin(q.sharpness) || q.sharpness < 0 || q.sharpness > 100000 ||
    !fin(q.facePresence) || q.facePresence < 0.7 || q.facePresence > 1.0001 ||
    !fin(q.framesUsed) || q.framesUsed < 8 ||
    !fin(q.yawDeg) || Math.abs(q.yawDeg) > 10 ||
    !fin(q.rollDeg) || Math.abs(q.rollDeg) > 7
  ) {
    return { ok: false, reason: "capture quality metrics fail server gates" };
  }

  if (!a.components || typeof a.components !== "object") return { ok: false, reason: "missing components" };
  for (const key of METRIC_KEYS) {
    if (!fin(a.components[`metric:${key}`])) return { ok: false, reason: `missing metric ${key}` };
  }
  for (const g of Object.keys(GROUP_WEIGHTS)) {
    if (!fin(a.components[`group:${g}`])) return { ok: false, reason: `missing group ${g}` };
  }
  if (typeof a.digest !== "string" || !/^[a-f0-9]{64}$/.test(a.digest))
    return { ok: false, reason: "invalid capture digest" };
  return { ok: true };
}

/**
 * Suspicion heuristics applied to an otherwise-valid attestation.
 * These never fabricate a different score — they only flag the result and
 * halve any Elo gained, keeping the ladder honest.
 */
export function suspicionFlags(a: BattleAttestation, verifiedPsl: number | null): string[] {
  const flags: string[] = [];
  if (verifiedPsl != null && Math.abs(a.score - verifiedPsl) > 2.0) flags.push("battle score diverges from verified scan");
  const sym = a.components["metric:asymmetryIndex"];
  if (fin(sym) && (sym < 0 || sym > 0.25)) flags.push("implausible symmetry value");
  if (a.confidence >= 0.995) flags.push("implausibly perfect capture quality");
  return flags;
}
