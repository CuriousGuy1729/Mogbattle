import type { CaptureQuality, GroupScore, Landmarks, MetricResult, PslResult } from "./types";
import { computeMetrics } from "./metrics";
import { stabilizeFrames } from "./geometry";
import {
  GROUP_LABELS,
  GROUP_WEIGHTS,
  METRIC_SPECS,
  MODEL_CONSTANT_BLOB,
  PSL_MODEL_VERSION,
  SCORE_CLAMP,
  SCORE_CURVE,
  SYMMETRY_REF,
  type GroupKey,
} from "./version";

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Composite capture confidence. This gates whether a score may be issued at
 * all — it never alters the score itself (quality affects trust, not the number).
 */
export function confidenceFromQuality(q: CaptureQuality): number {
  const presence = clamp01(q.facePresence);
  const stability = clamp01(1 - (Math.max(0, q.stability - 0.002) / 0.01));
  const sharp = clamp01((q.sharpness - 80) / 420);
  const light = clamp01(1 - Math.abs(q.brightness - 128) / 96) * clamp01(q.contrast / 24);
  const pose = clamp01(1 - Math.max(Math.abs(q.yawDeg) / 10, Math.abs(q.rollDeg) / 7));
  const frames = clamp01(q.framesUsed / 12) * clamp01(1 - q.badFrameRate);
  return (
    presence * 0.24 + stability * 0.18 + sharp * 0.2 + light * 0.16 + pose * 0.14 + frames * 0.08
  );
}

const groupScoreFromRms = (rmsZ: number) =>
  Math.min(10, Math.max(0, SCORE_CURVE.base + SCORE_CURVE.span * Math.exp(-(rmsZ * rmsZ) / SCORE_CURVE.falloff)));

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function modelHash(): Promise<string> {
  return sha256Hex(MODEL_CONSTANT_BLOB).then((h) => h.slice(0, 16));
}

/**
 * Deterministic PSL pipeline.
 *
 *   stabilized landmarks → canonical alignment → dimensionless metrics →
 *   standardized z-scores vs pinned references → weighted group scores →
 *   weighted overall score.
 *
 * Identical input landmarks always produce an identical score for a given
 * model version. No randomness, no learned black box.
 *
 * Returns null when geometry is degenerate — callers MUST ask for a rescan.
 */
export async function computePsl(frames: Landmarks[], quality: CaptureQuality): Promise<PslResult | null> {
  if (frames.length < 8) return null;
  const median = stabilizeFrames(frames);
  const computed = computeMetrics(median);
  if (!computed) return null;

  const { metrics } = computed;
  const byKey = metrics as unknown as Record<string, number>;

  const groups = new Map<GroupKey, MetricResult[]>();
  for (const spec of METRIC_SPECS) {
    const value = byKey[spec.key];
    const z = Math.max(-(spec.maxZ ?? 4), Math.min(spec.maxZ ?? 4, (value - spec.refMean) / spec.refSd));
    const mr: MetricResult = { key: spec.key, label: spec.label, value, refMean: spec.refMean, refSd: spec.refSd, z };
    if (!groups.has(spec.group)) groups.set(spec.group, []);
    groups.get(spec.group)!.push(mr);
  }

  const groupScores: GroupScore[] = [];
  let total = 0;
  let weightSum = 0;

  for (const [key, results] of groups.entries()) {
    const rms = Math.sqrt(results.reduce((acc, r) => acc + r.z * r.z, 0) / results.length);
    const score = groupScoreFromRms(rms);
    groupScores.push({ key, label: GROUP_LABELS[key], weight: GROUP_WEIGHTS[key], score, metrics: results });
    total += score * GROUP_WEIGHTS[key];
    weightSum += GROUP_WEIGHTS[key];
  }

  // Symmetry is expressed as its own group with a dedicated reference scale.
  const symZ = metrics.asymmetryIndex / SYMMETRY_REF.refSd;
  const symScore = groupScoreFromRms(Math.abs(symZ));
  const symIdx = groupScores.findIndex((g) => g.key === "symmetry");
  if (symIdx === -1) {
    groupScores.push({
      key: "symmetry",
      label: GROUP_LABELS.symmetry,
      weight: GROUP_WEIGHTS.symmetry,
      score: symScore,
      metrics: [
        {
          key: "asymmetryIndex",
          label: "Mean mirrored landmark deviation",
          value: metrics.asymmetryIndex,
          refMean: SYMMETRY_REF.refMean,
          refSd: SYMMETRY_REF.refSd,
          z: symZ,
        },
      ],
    });
    total += symScore * GROUP_WEIGHTS.symmetry;
    weightSum += GROUP_WEIGHTS.symmetry;
  }

  const raw = weightSum > 0 ? total / weightSum : 0;
  const score = Math.round(Math.min(SCORE_CLAMP[1], Math.max(SCORE_CLAMP[0], raw)) * 100) / 100;
  const confidence = Math.round(confidenceFromQuality(quality) * 1000) / 1000;

  return {
    score,
    version: PSL_MODEL_VERSION,
    groups: groupScores,
    quality,
    confidence,
    modelHash: await modelHash(),
  };
}

/**
 * Non-identifying capture digest: hash of the *aligned, quantized* landmark
 * constellation. Used for duplicate/replay detection. It cannot be inverted
 * into a face image and the platform never stores face images.
 */
export async function captureDigest(stabilized: Landmarks): Promise<string> {
  const median = stabilized;
  const KEEP = [
    1, 2, 6, 10, 13, 17, 33, 48, 58, 61, 105, 133, 145, 152, 159, 168, 234, 262, 275, 288, 291, 323, 334, 362, 386,
    454, 468, 473,
  ];
  const blob = median
    .filter((_, i) => KEEP.includes(i))
    .map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)
    .join("|");
  return sha256Hex(`psl-digest-v1:${blob}`);
}

/** Flattened, non-identifying score components stored for auditability. */
export function componentsFromResult(r: PslResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of r.groups) {
    out[`group:${g.key}`] = Math.round(g.score * 1000) / 1000;
    for (const m of g.metrics) out[`metric:${m.key}`] = Math.round(m.value * 10000) / 10000;
  }
  return out;
}
