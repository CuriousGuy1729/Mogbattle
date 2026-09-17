import type { Landmarks, Pt3 } from "./types";
import { IRIS_RING_A, IRIS_RING_B, LM } from "./landmarks";
import { K_YAW } from "./version";

export const dist = (a: Pt3, b: Pt3) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist3 = (a: Pt3, b: Pt3) => Math.hypot(a.x - b.x, a.y - b.y, (a.z - b.z) * 0.5);

const meanPt = (pts: Pt3[]): Pt3 => {
  const n = pts.length || 1;
  return pts.reduce((acc, p) => ({ x: acc.x + p.x / n, y: acc.y + p.y / n, z: acc.z + p.z / n }), { x: 0, y: 0, z: 0 });
};

export interface HeadPose {
  /** Estimated yaw in degrees (positive = subject turns toward their own left). */
  yawDeg: number;
  /** Estimated roll in degrees (signed). */
  rollDeg: number;
  /** Iris centers used for the estimate. */
  irisL: Pt3;
  irisR: Pt3;
}

function irisCenter(lm: Landmarks, ring: number[]): Pt3 {
  return meanPt(ring.map((i) => lm[i]));
}

/**
 * Head-pose estimate derived from iris position inside the eye aperture.
 *
 * For each eye we measure where the iris sits along the outer→inner canthus
 * axis (0 = outer canthus, 1 = inner canthus). Under yaw rotation the two
 * iris positions move in opposite directions along their respective axes, so
 * (posR − posL)/2 is a monotonic yaw signal that is robust to camera
 * distance and roll. The linear gain K_YAW is calibrated in version.ts.
 * This is an intentionally conservative, documented approximation — scans
 * are only accepted near-frontal (|yaw| ≤ 10°).
 */
export function estimateHeadPose(lm: Landmarks): HeadPose {
  const irisA = irisCenter(lm, IRIS_RING_A);
  const irisB = irisCenter(lm, IRIS_RING_B);

  // Assign subject-left / subject-right by image x (raw, unmirrored frame:
  // subject's left side appears at larger x).
  const aIsLeft = irisA.x > irisB.x;
  const irisL = aIsLeft ? irisA : irisB;
  const irisR = aIsLeft ? irisB : irisA;
  const eyeL = aIsLeft
    ? { inner: lm[LM.eyeA_inner], outer: lm[LM.eyeA_outer] }
    : { inner: lm[LM.eyeB_inner], outer: lm[LM.eyeB_outer] };
  const eyeR = aIsLeft
    ? { inner: lm[LM.eyeB_inner], outer: lm[LM.eyeB_outer] }
    : { inner: lm[LM.eyeA_inner], outer: lm[LM.eyeA_outer] };

  const frac = (iris: Pt3, outer: Pt3, inner: Pt3) => {
    const ax = inner.x - outer.x;
    const ay = inner.y - outer.y;
    const len2 = ax * ax + ay * ay || 1e-9;
    return ((iris.x - outer.x) * ax + (iris.y - outer.y) * ay) / len2;
  };

  const posL = frac(irisL, eyeL.outer, eyeL.inner);
  const posR = frac(irisR, eyeR.outer, eyeR.inner);

  // Turning toward the subject's left shifts both irises toward image +x,
  // which raises posR and lowers posL.
  const yawDeg = K_YAW * ((posR - posL) / 2);

  const dx = irisL.x - irisR.x;
  const dy = irisL.y - irisR.y;
  const rollDeg = (Math.atan2(dy, Math.abs(dx) < 1e-9 ? 1e-9 : dx) * 180) / Math.PI;

  return { yawDeg, rollDeg, irisL, irisR };
}

/** Eye Aspect Ratio — classic blink signal. Low values ⇒ eye closed. */
export function eyeAspectToRatio(lm: Landmarks): number {
  const ear = (upper: Pt3, lower: Pt3, inner: Pt3, outer: Pt3) => {
    const v = dist(upper, lower);
    const h = dist(inner, outer) || 1e-9;
    return v / (2 * h);
  };
  const a = ear(lm[LM.eyeA_upper], lm[LM.eyeA_lower], lm[LM.eyeA_inner], lm[LM.eyeA_outer]);
  const b = ear(lm[LM.eyeB_upper], lm[LM.eyeB_lower], lm[LM.eyeB_inner], lm[LM.eyeB_outer]);
  return (a + b) / 2;
}

export interface AlignedFace {
  /** Landmarks transformed: origin = iris midpoint, unit = IPD, de-rolled. */
  pts: Pt3[];
  ipd: number;
}

/**
 * Capture normalization.
 * Transforms landmarks into a canonical frame:
 *  - translation: origin at the inter-iris midpoint
 *  - scale: 1 unit = interpupillary distance (removes camera distance)
 *  - rotation: iris line becomes the horizontal x-axis (removes roll)
 * Residual perspective error for |yaw| ≤ 10° is bounded and documented.
 */
export function alignFace(lm: Landmarks): AlignedFace {
  const pose = estimateHeadPose(lm);
  const cx = (pose.irisL.x + pose.irisR.x) / 2;
  const cy = (pose.irisL.y + pose.irisR.y) / 2;
  const ipd = Math.hypot(pose.irisL.x - pose.irisR.x, pose.irisL.y - pose.irisR.y) || 1e-9;
  const ang = Math.atan2(pose.irisL.y - pose.irisR.y, pose.irisL.x - pose.irisR.x);
  const cos = Math.cos(-ang);
  const sin = Math.sin(-ang);

  const pts = lm.map((p) => {
    const dx = (p.x - cx) / ipd;
    const dy = (p.y - cy) / ipd;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos, z: (p.z || 0) / ipd };
  });
  return { pts, ipd };
}

/**
 * Temporal stabilization: per-landmark median over a set of frames.
 * Median (not mean) rejects blink/expression micro-outliers deterministically.
 */
export function stabilizeFrames(frames: Landmarks[]): Landmarks {
  if (frames.length === 0) return [];
  const n = frames[0].length;
  const out: Landmarks = [];
  for (let i = 0; i < n; i++) {
    const xs = frames.map((f) => f[i].x).sort((a, b) => a - b);
    const ys = frames.map((f) => f[i].y).sort((a, b) => a - b);
    const zs = frames.map((f) => f[i].z).sort((a, b) => a - b);
    const m = (arr: number[]) => {
      const mid = Math.floor(arr.length / 2);
      return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    };
    out.push({ x: m(xs), y: m(ys), z: m(zs) });
  }
  return out;
}
