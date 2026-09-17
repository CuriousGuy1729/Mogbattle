/**
 * PSL scoring model — pinned constants.
 *
 * Every number that influences a PSL score lives in this file. Changing any
 * constant changes MODEL_HASH, which is recorded with every scan so results
 * are always reproducible against the exact model revision that produced them.
 *
 * Reference means/SDs are stylized from classical facial canons (rule of
 * thirds, rule of fifths, neoclassical proportions) and pooled adult
 * anthropometric averages. They are symmetric, sex-neutral reference values —
 * see /methodology for the full honesty statement.
 */

export const PSL_MODEL_VERSION = "PSL-2026.1.0";

/** Linear gain mapping iris-offset ratio to degrees (calibrated near-frontal). */
export const K_YAW = 135;

export interface MetricSpec {
  key: string;
  label: string;
  group: GroupKey;
  refMean: number;
  refSd: number;
  /** Extra clamp for |z| contribution. */
  maxZ?: number;
}

export type GroupKey = "proportions" | "features" | "symmetry" | "structure" | "placement";

export const METRIC_SPECS: MetricSpec[] = [
  // ── Proportions (vertical canons) ──────────────────────────────────────
  { key: "midToLowerThird", label: "Mid-face : lower-face height", group: "proportions", refMean: 1.0, refSd: 0.06 },
  { key: "upperToMidThird", label: "Upper : mid-face height (hairline approx.)", group: "proportions", refMean: 1.0, refSd: 0.09, maxZ: 3 },
  { key: "lowerThirdOfFace", label: "Lower third share of face height", group: "proportions", refMean: 0.333, refSd: 0.02 },

  // ── Feature relationships (horizontal canons) ──────────────────────────
  { key: "faceWidthInEyeWidths", label: "Face width in eye widths (rule of fifths)", group: "features", refMean: 5.0, refSd: 0.35 },
  { key: "noseToEyeWidth", label: "Nose width : eye width", group: "features", refMean: 1.0, refSd: 0.12 },
  { key: "ipdToFaceWidth", label: "Interpupillary distance : face width", group: "features", refMean: 0.46, refSd: 0.02 },
  { key: "mouthToNoseWidth", label: "Mouth width : nose width", group: "features", refMean: 1.5, refSd: 0.12 },
  { key: "canthalTiltDeg", label: "Canthal tilt (°)", group: "features", refMean: 2.5, refSd: 2.0, maxZ: 3.5 },

  // ── Structure (lower-face geometry) ────────────────────────────────────
  { key: "jawToZygomatic", label: "Jaw width : cheekbone width", group: "structure", refMean: 0.85, refSd: 0.05 },
  { key: "chinToMouthSeg", label: "Chin height : mouth-segment height", group: "structure", refMean: 1.9, refSd: 0.25 },
  { key: "lipHeightOfLowerThird", label: "Lip height : lower third", group: "structure", refMean: 0.25, refSd: 0.045, maxZ: 3 },

  // ── Placement (vertical feature positions) ─────────────────────────────
  { key: "eyeLineOfFace", label: "Eye line position on face height", group: "placement", refMean: 0.5, refSd: 0.03 },
  { key: "browEyeSpacing", label: "Brow–eye spacing in eye widths", group: "placement", refMean: 0.55, refSd: 0.15, maxZ: 3 },
];

/** Bilateral asymmetry index: mean relative left/right deviation. */
export const SYMMETRY_REF = { refMean: 0.0, refSd: 0.028 };

export const GROUP_WEIGHTS: Record<GroupKey, number> = {
  proportions: 0.22,
  features: 0.26,
  symmetry: 0.22,
  structure: 0.18,
  placement: 0.12,
};

export const GROUP_LABELS: Record<GroupKey, string> = {
  proportions: "Facial Proportions",
  features: "Feature Relationships",
  symmetry: "Bilateral Symmetry",
  structure: "Jaw & Lower-Face Structure",
  placement: "Feature Placement",
};

/** Score curve: groupScore = BASE + SPAN · exp(−rmsZ² / FALLOFF). */
export const SCORE_CURVE = { base: 1.2, span: 8.8, falloff: 2.8 };

/** Hard clamp applied to final scores (landmark-based analysis cannot honestly reach extremes). */
export const SCORE_CLAMP: [number, number] = [0.5, 9.8];

/** Quality gates for a frame to count toward scoring. */
export const FRAME_GATES = {
  maxYawDeg: 10,
  maxRollDeg: 7,
  minBrightness: 50,
  maxBrightness: 215,
  minSharpness: 80, // Laplacian variance on a 96px face crop
  minFaceWidthRatio: 0.2,
  maxFaceWidthRatio: 0.85,
};

/** Liveness challenge acceptance thresholds. */
export const LIVENESS = {
  turnThresholdDeg: 22, // |yaw| required for LEFT/RIGHT challenges
  blinkEarMin: 0.2, // EAR must dip below this
  neutralYawMaxDeg: 9,
  neutralRollMaxDeg: 7,
  challengeMinMs: 600,
  challengeMaxMs: 12000,
};

export const MIN_SCAN_CONFIDENCE = 0.62;

export const MODEL_CONSTANT_BLOB = JSON.stringify({
  v: PSL_MODEL_VERSION,
  k: K_YAW,
  m: METRIC_SPECS,
  s: SYMMETRY_REF,
  w: GROUP_WEIGHTS,
  c: SCORE_CURVE,
  clamp: SCORE_CLAMP,
  gates: FRAME_GATES,
});

export const METRIC_KEYS = [...METRIC_SPECS.map((m) => m.key), "asymmetryIndex"];
