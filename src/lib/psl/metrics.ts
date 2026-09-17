import type { Landmarks } from "./types";
import { alignFace, dist, stabilizeFrames, type AlignedFace } from "./geometry";
import { LM, SYMMETRY_PAIRS } from "./landmarks";

export interface ComputedMetrics {
  midToLowerThird: number;
  upperToMidThird: number;
  lowerThirdOfFace: number;
  faceWidthInEyeWidths: number;
  noseToEyeWidth: number;
  ipdToFaceWidth: number;
  mouthToNoseWidth: number;
  canthalTiltDeg: number;
  jawToZygomatic: number;
  chinToMouthSeg: number;
  lipHeightOfLowerThird: number;
  eyeLineOfFace: number;
  browEyeSpacing: number;
  asymmetryIndex: number;
  /** INFORMATIONAL ONLY — classic facial width-to-height ratio. Never scored. */
  fwHR: number;
}

const EPS = 1e-6;

/**
 * Computes every dimensionless PSL metric from a stabilized landmark set.
 * All measurements happen in the aligned canonical frame (see geometry.ts),
 * which removes camera distance, in-plane roll and translation. Ratios are
 * scale-free by construction.
 *
 * Returns null when the geometry is degenerate (unusable capture) — the
 * caller must demand a rescan instead of emitting a number.
 */
export function computeMetrics(stabilized: Landmarks): { metrics: ComputedMetrics; aligned: AlignedFace } | null {
  const { pts } = alignFace(stabilized);
  const p = (i: number) => pts[i];

  const eyeWA = dist(p(LM.eyeA_outer), p(LM.eyeA_inner));
  const eyeWB = dist(p(LM.eyeB_outer), p(LM.eyeB_inner));
  const avgEyeW = (eyeWA + eyeWB) / 2;
  const faceW = dist(p(LM.zygionA), p(LM.zygionB));
  const noseW = dist(p(LM.alaA), p(LM.alaB));
  const mouthW = dist(p(LM.mouthCornerA), p(LM.mouthCornerB));

  if (!(avgEyeW > EPS) || !(faceW > EPS) || !(noseW > EPS) || !(mouthW > EPS)) return null;

  // Vertical midline points.
  const glabella = p(LM.glabella);
  const subnasale = p(LM.subnasale);
  const stomion = p(LM.stomion);
  const menton = p(LM.menton);
  const forehead = p(LM.hairlineApprox);

  // Hairline (trichion) approximation: extrapolate along the forehead axis.
  const fx = forehead.x - glabella.x;
  const fy = forehead.y - glabella.y;
  const flen = Math.hypot(fx, fy);
  if (!(flen > EPS)) return null;
  const trichion = {
    x: forehead.x + (fx / flen) * flen * 0.9,
    y: forehead.y + (fy / flen) * flen * 0.9,
    z: 0,
  };

  const seg = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  const upperThird = seg(trichion, glabella);
  const midThird = seg(glabella, subnasale);
  const lowerThird = seg(subnasale, menton);
  const faceHeight = seg(trichion, menton);
  if (!(upperThird > EPS && midThird > EPS && lowerThird > EPS && faceHeight > EPS)) return null;

  // Canthal tilt: angle of the outer→inner canthus line. In the aligned frame
  // y grows downward and each eye's inner canthus sits toward x = 0, so a
  // positive atan2 here means the outer canthus is higher (positive tilt).
  const tiltA = (Math.atan2(p(LM.eyeA_inner).y - p(LM.eyeA_outer).y, eyeWA) * 180) / Math.PI;
  const tiltB = (Math.atan2(p(LM.eyeB_inner).y - p(LM.eyeB_outer).y, eyeWB) * 180) / Math.PI;
  const canthalTiltDeg = (tiltA + tiltB) / 2;

  const jawW = dist(p(LM.gonionA), p(LM.gonionB));
  const chinSeg = seg(menton, stomion);
  const mouthSeg = seg(subnasale, stomion);
  const lipH = dist(p(LM.upperLipOuter), p(LM.lowerLipOuter));
  if (!(jawW > EPS && chinSeg > EPS && mouthSeg > EPS)) return null;

  // Iris line sits at y = 0 by construction of the aligned frame.
  const eyeLineY = 0;
  const eyeLineOfFace = (eyeLineY - trichion.y) / (menton.y - trichion.y);
  const browEyeSpacing = (Math.abs(p(LM.browA).y) + Math.abs(p(LM.browB).y)) / 2 / avgEyeW;

  // Bilateral symmetry: mirrored deviation per landmark pair, scaled by pair span.
  let acc = 0;
  let n = 0;
  for (const [ia, ib] of SYMMETRY_PAIRS) {
    const a = p(ia);
    const b = p(ib);
    const span = dist(a, b);
    if (!(span > 0.05)) continue; // pair too degenerate to be meaningful
    const dev = Math.hypot(Math.abs(a.x) - Math.abs(b.x), a.y - b.y);
    acc += dev / span;
    n++;
  }
  if (n < 8) return null;
  const asymmetryIndex = acc / n;

  const metrics: ComputedMetrics = {
    midToLowerThird: midThird / lowerThird,
    upperToMidThird: upperThird / midThird,
    lowerThirdOfFace: lowerThird / faceHeight,
    faceWidthInEyeWidths: faceW / avgEyeW,
    noseToEyeWidth: noseW / avgEyeW,
    ipdToFaceWidth: 1 / faceW, // IPD is the unit length of the aligned frame
    mouthToNoseWidth: mouthW / noseW,
    canthalTiltDeg,
    jawToZygomatic: jawW / faceW,
    chinToMouthSeg: chinSeg / mouthSeg,
    lipHeightOfLowerThird: lipH / lowerThird,
    eyeLineOfFace,
    browEyeSpacing,
    asymmetryIndex,
    // Display-only looksmaxxing readout (bizygomatic width ÷ face height).
    // Deliberately NOT in METRIC_SPECS, so it never influences the score.
    fwHR: faceW / faceHeight,
  };

  for (const v of Object.values(metrics)) {
    if (!Number.isFinite(v)) return null;
  }
  return { metrics, aligned: { pts, ipd: 1 } };
}

/** Display-only extra readouts (not part of the scored model). */
export function extraReads(frames: Landmarks[]): { fwHR: number | null } {
  try {
    const median = stabilizeFrames(frames);
    const computed = computeMetrics(median);
    return { fwHR: computed ? computed.metrics.fwHR : null };
  } catch {
    return { fwHR: null };
  }
}
