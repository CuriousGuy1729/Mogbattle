"use client";
/**
 * On-device face landmark + capture-quality sampler.
 * Everything runs in the browser — no video frame ever leaves the device.
 */
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { Landmarks } from "@/lib/psl/types";
import { eyeAspectToRatio, estimateHeadPose } from "@/lib/psl/geometry";
import { FRAME_GATES } from "@/lib/psl/version";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

export function loadFaceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 2, // detect up to 2 so we can REJECT frames with more than one face
      });
    })();
  }
  return landmarkerPromise;
}

export interface FrameSample {
  ok: boolean;
  faceCount: number;
  landmarks: Landmarks | null;
  yawDeg: number;
  rollDeg: number;
  ear: number;
  brightness: number;
  contrast: number;
  sharpness: number;
  faceWidthRatio: number;
  /** Sample passes every objective capture gate. */
  gated: boolean;
  gateFails: string[];
}

/**
 * Image-quality analysis on a small canvas.
 * - brightness / contrast: mean & std-dev of luminance over the face crop
 * - sharpness: Laplacian variance on a 96×96 grayscale face crop
 *   (blur / out-of-focus / heavily compressed replay footage scores low)
 */
function analyzeCrop(
  ctx: CanvasRenderingContext2D,
  img: ImageData,
  canvasW: number,
  box: { x: number; y: number; w: number; h: number }
): { brightness: number; contrast: number; sharpness: number } {
  const S = 96;
  const sx = Math.max(0, Math.floor(box.x));
  const sy = Math.max(0, Math.floor(box.y));
  const sw = Math.max(8, Math.min(Math.floor(box.w), canvasW - sx));
  const sh = Math.max(8, Math.floor(box.h));
  ctx.clearRect(0, 0, S, S);
  ctx.drawImage(img as unknown as CanvasImageSource, sx, sy, sw, sh, 0, 0, S, S);
  const small = ctx.getImageData(0, 0, S, S);
  const d = small.data;
  const gray = new Float32Array(S * S);
  let sum = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[p] = y;
    sum += y;
  }
  const mean = sum / (S * S);
  let varSum = 0;
  for (let p = 0; p < gray.length; p++) varSum += (gray[p] - mean) ** 2;
  const contrast = Math.sqrt(varSum / (S * S));

  // Laplacian variance (sharpness)
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < S - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      const i = y * S + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - S] - gray[i + S];
      lapSum += lap;
      lapSq += lap * lap;
      n++;
    }
  }
  const lapMean = lapSum / n;
  const sharpness = lapSq / n - lapMean * lapMean;
  return { brightness: mean, contrast, sharpness };
}

export class FaceSampler {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private lastVideoTime = -1;

  constructor(private video: HTMLVideoElement) {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  async sample(): Promise<FrameSample> {
    const fail: FrameSample = {
      ok: false,
      faceCount: 0,
      landmarks: null,
      yawDeg: 0,
      rollDeg: 0,
      ear: 0,
      brightness: 0,
      contrast: 0,
      sharpness: 0,
      faceWidthRatio: 0,
      gated: false,
      gateFails: ["no camera frame"],
    };
    if (!this.video || this.video.readyState < 2 || this.video.videoWidth === 0) return fail;

    // Freeze-frame dedupe: MediaPipe requires a fresh frame timestamp.
    if (this.video.currentTime === this.lastVideoTime) {
      // Same frame; still run detection once per JS tick max.
    }
    this.lastVideoTime = this.video.currentTime;

    const landmarker = await loadFaceLandmarker();
    const result = landmarker.detectForVideo(this.video, performance.now());
    const faces = result.faceLandmarks ?? [];
    const faceCount = faces.length;
    if (faceCount !== 1 || faces[0].length < 478) {
      return { ...fail, faceCount, gateFails: [faceCount === 0 ? "no face detected" : faceCount > 1 ? "multiple faces in frame" : "incomplete landmark set"] };
    }
    const lm: Landmarks = faces[0].map((p) => ({ x: p.x, y: p.y, z: p.z }));

    const pose = estimateHeadPose(lm);
    const ear = eyeAspectToRatio(lm);

    // Downscale for image analysis.
    const targetW = 480;
    const scale = targetW / this.video.videoWidth;
    const w = Math.round(this.video.videoWidth * scale);
    const h = Math.round(this.video.videoHeight * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(this.video, 0, 0, w, h);
    let img: ImageData;
    try {
      img = this.ctx.getImageData(0, 0, w, h);
    } catch {
      return { ...fail, faceCount, landmarks: lm, gateFails: ["canvas blocked"] };
    }

    const xs = lm.map((p) => p.x);
    const ys = lm.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const faceWidthRatio = maxX - minX;
    const box = {
      x: minX * w - (maxX - minX) * w * 0.1,
      y: minY * h - (maxY - minY) * h * 0.15,
      w: (maxX - minX) * w * 1.2,
      h: (maxY - minY) * h * 1.3,
    };
    const { brightness, contrast, sharpness } = analyzeCrop(this.ctx, img, w, box);

    const gateFails: string[] = [];
    if (Math.abs(pose.yawDeg) > FRAME_GATES.maxYawDeg) gateFails.push("face not frontal");
    if (Math.abs(pose.rollDeg) > FRAME_GATES.maxRollDeg) gateFails.push("head tilted");
    if (brightness < FRAME_GATES.minBrightness) gateFails.push("too dark");
    if (brightness > FRAME_GATES.maxBrightness) gateFails.push("overexposed");
    if (sharpness < FRAME_GATES.minSharpness) gateFails.push("image too soft — steady yourself / improve focus");
    if (faceWidthRatio < FRAME_GATES.minFaceWidthRatio) gateFails.push("too far from camera");
    if (faceWidthRatio > FRAME_GATES.maxFaceWidthRatio) gateFails.push("too close to camera");

    return {
      ok: true,
      faceCount,
      landmarks: lm,
      yawDeg: pose.yawDeg,
      rollDeg: pose.rollDeg,
      ear,
      brightness,
      contrast,
      sharpness,
      faceWidthRatio,
      gated: gateFails.length === 0,
      gateFails,
    };
  }
}

/** Convenience: open the user camera with battle-grade constraints.
 *  Audio is best-effort — a mic denial must never block the scan. */
export async function openCamera(): Promise<MediaStream> {
  const video = {
    facingMode: "user" as const,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch {
    return navigator.mediaDevices.getUserMedia({ video, audio: false });
  }
}
