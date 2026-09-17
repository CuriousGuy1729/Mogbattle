"use client";
/**
 * Capture → attestation pipeline (used by both the verification scan and the
 * in-battle capture). Runs fully on-device and produces:
 *   - a deterministic PSL score from the pinned model
 *   - capture-quality metrics
 *   - a non-identifying capture digest
 * If quality is insufficient it refuses to produce a number — the honest path.
 */
import type { BattleAttestation, CaptureQuality, Landmarks, PslResult } from "@/lib/psl/types";
import { alignFace, stabilizeFrames } from "@/lib/psl/geometry";
import { captureDigest, componentsFromResult, computePsl } from "@/lib/psl/score";
import { FRAME_GATES } from "@/lib/psl/version";
import type { FrameSample, FaceSampler } from "./face";

export interface NeutralCapture {
  frames: Landmarks[];
  quality: CaptureQuality;
}

export type CaptureOutcome =
  | { ok: true; attestation: BattleAttestation; result: PslResult }
  | { ok: false; reason: string; hint: string };

/**
 * Collects neutral-frontal frames while quality gates pass.
 * Requires ≥ 12 usable frames; otherwise the capture is rejected with a
 * concrete remediation hint instead of emitting a fake score.
 */
export async function collectNeutralCapture(
  sampler: FaceSampler,
  opts: { targetFrames?: number; maxMs?: number; onProgress?: (have: number, need: number) => void } = {}
): Promise<NeutralCapture | { error: string; hint: string }> {
  const target = opts.targetFrames ?? 18;
  const deadline = Date.now() + (opts.maxMs ?? 8000);
  const frames: Landmarks[] = [];
  let totalFrames = 0;
  let badFrames = 0;
  const brightness: number[] = [];
  const contrast: number[] = [];
  const sharpness: number[] = [];
  const yaws: number[] = [];
  const rolls: number[] = [];
  const stabs: number[] = [];
  const failCounts = new Map<string, number>();

  while (Date.now() < deadline && frames.length < target) {
    const s = await sampler.sample();
    totalFrames++;
    if (s.ok && s.landmarks) {
      brightness.push(s.brightness);
      contrast.push(s.contrast);
      sharpness.push(s.sharpness);
      yaws.push(s.yawDeg);
      rolls.push(s.rollDeg);
      if (frames.length > 0) {
        const prev = frames[frames.length - 1];
        let d = 0;
        for (let i = 0; i < prev.length; i += 20) {
          d += Math.abs(prev[i].x - s.landmarks[i].x) + Math.abs(prev[i].y - s.landmarks[i].y);
        }
        stabs.push(d / Math.floor(prev.length / 20));
      }
    }
    if (s.ok && s.gated && s.landmarks) {
      frames.push(s.landmarks);
      opts.onProgress?.(frames.length, target);
    } else {
      badFrames++;
      for (const f of s.gateFails) failCounts.set(f, (failCounts.get(f) ?? 0) + 1);
    }
    await new Promise((r) => setTimeout(r, 66));
  }

  if (frames.length < 12) {
    const top = [...failCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      error: "insufficient_capture",
      hint: top ?? "Not enough usable frames. Improve lighting, face the camera directly and hold still.",
    };
  }

  const med = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const quality: CaptureQuality = {
    brightness: Math.round(med(brightness) * 10) / 10,
    contrast: Math.round(med(contrast) * 10) / 10,
    sharpness: Math.round(med(sharpness)),
    facePresence: Math.round((frames.length / totalFrames) * 1000) / 1000,
    stability: Math.round(med(stabs) * 10000) / 10000,
    yawDeg: Math.round(med(yaws) * 10) / 10,
    rollDeg: Math.round(med(rolls) * 10) / 10,
    badFrameRate: Math.round((badFrames / totalFrames) * 1000) / 1000,
    framesUsed: frames.length,
  };
  return { frames, quality };
}

/** Neutral pose guard for the *battle* capture window (slightly stricter time budget). */
export function frameIsBattleUsable(s: FrameSample): boolean {
  return s.ok && s.gated && !!s.landmarks && Math.abs(s.yawDeg) <= FRAME_GATES.maxYawDeg;
}

export async function buildAttestation(frames: Landmarks[], quality: CaptureQuality): Promise<CaptureOutcome> {
  const result = await computePsl(frames, quality);
  if (!result) {
    return {
      ok: false,
      reason: "Degenerate facial geometry in this capture.",
      hint: "Hold your face upright, centered and well-lit, then scan again.",
    };
  }
  if (result.confidence < 0.62) {
    return {
      ok: false,
      reason: `Capture confidence ${(result.confidence * 100).toFixed(0)}% is below the required 62%.`,
      hint: "Improve lighting or camera stability and rescan — we refuse to guess.",
    };
  }
  const median = stabilizeFrames(frames);
  const { pts } = alignFace(median);
  const digest = await captureDigest(pts);
  return {
    ok: true,
    result,
    attestation: {
      version: result.version,
      score: result.score,
      confidence: result.confidence,
      quality,
      components: componentsFromResult(result),
      digest,
      modelHash: result.modelHash,
    },
  };
}
