export interface Pt3 {
  x: number;
  y: number;
  z: number;
}

/** Raw MediaPipe FaceLandmarker output (normalized image coords). */
export type Landmarks = Pt3[];

export interface CaptureQuality {
  /** Mean luminance (0..255) of the face crop. */
  brightness: number;
  /** Standard deviation of luminance — proxy for contrast. */
  contrast: number;
  /** Laplacian variance of the face crop — sharpness proxy. */
  sharpness: number;
  /** Fraction of sampled frames where exactly one face was present. */
  facePresence: number;
  /** Mean absolute landmark displacement between consecutive frames (px, normalized). */
  stability: number;
  /** Median estimated yaw (degrees) across captured frames. */
  yawDeg: number;
  /** Median estimated roll (degrees). */
  rollDeg: number;
  /** Fraction of frames failing the quality gates. */
  badFrameRate: number;
  /** Frames actually used. */
  framesUsed: number;
}

export interface MetricResult {
  key: string;
  label: string;
  value: number;
  refMean: number;
  refSd: number;
  /** Clamped standardized deviation. */
  z: number;
}

export interface GroupScore {
  key: string;
  label: string;
  weight: number;
  score: number;
  metrics: MetricResult[];
}

export interface PslResult {
  /** Overall PSL score on a 0..10 scale, 2 decimals. */
  score: number;
  version: string;
  groups: GroupScore[];
  quality: CaptureQuality;
  /** Composite confidence 0..1 derived from capture quality. */
  confidence: number;
  /** sha-256 over the model constants — pins the exact scoring revision. */
  modelHash: string;
}

export interface BattleAttestation {
  version: string;
  score: number;
  confidence: number;
  quality: CaptureQuality;
  components: Record<string, number>;
  digest: string;
  modelHash: string;
}
