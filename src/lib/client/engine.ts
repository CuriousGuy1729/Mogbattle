"use client";
/**
 * Perception engine: @vladmandic/human (open-source, MIT — the maintained
 * successor of face-api.js, built on TensorFlow.js).
 *
 * What the engine contributes:
 *  - BlazeFace detection + 468-point FaceMesh (+ 10 iris points) — same
 *    topology as the MediaPipe FaceMesh indices used by the scoring layer
 *  - true 3D head rotation (roll / yaw / pitch)
 *  - built-in LIVENESS and ANTI-SPOOF confidence models
 *
 * The engine measures geometry. It never "rates" — the PSL /10 score comes
 * exclusively from the pinned deterministic ratio pipeline (src/lib/psl).
 *
 * The deterministic PSL scoring layer stays on top of the engine's landmarks:
 * pinned constants, reproducible math, no black-box rating.
 *
 * If Human fails to initialize (blocked CDN, old GPU, …) the platform
 * transparently falls back to the MediaPipe sampler.
 */
import type Human from "@vladmandic/human"; // type-only — value is dynamic-imported in the browser
import type { Landmarks } from "@/lib/psl/types";
import { FaceSampler, type FrameSample } from "./face";

const HUMAN_VERSION = "3.3.6"; // must match the installed @vladmandic/human
const MODEL_BASE = `https://cdn.jsdelivr.net/npm/@vladmandic/human@${HUMAN_VERSION}/models`;
const WASM_PATH = `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/`;

let humanPromise: Promise<Human | null> | null = null;

function buildConfig(backend: "wasm" | "webgl") {
  return {
    modelBasePath: MODEL_BASE,
    backend,
    wasmPath: WASM_PATH,
    async: false,
    filter: { enabled: false },
    gesture: { enabled: false },
    object: { enabled: false },
    body: { enabled: false },
    hand: { enabled: false },
    face: {
      enabled: true,
      detector: { enabled: true, maxDetected: 2, rotation: false },
      mesh: { enabled: true },
      iris: { enabled: true },
      description: { enabled: false }, // age/gender not part of the rater — keep it lean
      emotion: { enabled: false },
      antispoof: { enabled: true },
      liveness: { enabled: true },
    },
  };
}

export function loadHuman(): Promise<Human | null> {
  if (!humanPromise) {
    humanPromise = (async () => {
      if (typeof window === "undefined") return null; // browser-only
      // Dynamic import: the Human package bundles TFJS and only loads in the
      // browser — never evaluated during SSR / prerendering.
      const mod = await import("@vladmandic/human");
      const HumanCtor = mod.default;
      for (const backend of ["wasm", "webgl"] as const) {
        try {
          const h = new HumanCtor(buildConfig(backend));
          await h.load();
          // eslint-disable-next-line no-console
          console.log(`[engine] human loaded (backend: ${backend})`);
          return h;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[engine] human ${backend} init failed, trying next…`, err);
        }
      }
      return null;
    })();
  }
  return humanPromise;
}

export interface EngineExtras {
  engine: "human" | "mediapipe";
  humanYawDeg?: number;
  humanPitchDeg?: number;
  live?: number; // engine liveness confidence
  real?: number; // engine anti-spoof confidence
}

export interface Sampler {
  sample(): Promise<FrameSample & Partial<EngineExtras>>;
}

export class HumanSampler implements Sampler {
  constructor(
    private video: HTMLVideoElement,
    private human: Human
  ) {}

  async sample(): Promise<FrameSample & Partial<EngineExtras>> {
    const fail: FrameSample & Partial<EngineExtras> = {
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
      engine: "human",
    };
    if (!this.video || this.video.readyState < 2 || this.video.videoWidth === 0) return fail;

    const result = await this.human.detect(this.video);
    const faces = result.face ?? [];
    if (faces.length !== 1) {
      return {
        ...fail,
        faceCount: faces.length,
        gateFails: [faces.length === 0 ? "no face detected" : "multiple faces in frame"],
      };
    }
    const f = faces[0];

    // Build the 478-point constellation: 468 mesh + 10 iris points.
    // meshRaw is normalized [x, y, z?] — same topology as MediaPipe FaceMesh.
    const lm: Landmarks = f.meshRaw.map((p) => ({ x: p[0], y: p[1], z: p[2] ?? 0 }));
    const irisPts = (f.annotations as Record<string, Array<[number, number, number?]>>)?.iris ?? [];
    if (irisPts.length >= 10) {
      for (let i = 0; i < 10; i++) lm[468 + i] = { x: irisPts[i][0], y: irisPts[i][1], z: irisPts[i][2] ?? 0 };
    }

    // Engine head rotation (degrees). Sign conventions are engine-defined;
    // we gate on absolute values and keep the iris-based signed yaw for
    // directed challenges, so both signals reinforce each other.
    const rot = f.rotation?.angle;
    const extras: Partial<EngineExtras> = {
      engine: "human",
      humanYawDeg: rot?.yaw,
      humanPitchDeg: rot?.pitch,
      live: f.live,
      real: f.real,
    };

    // Delegate EAR + signed pose + quality gates to the shared sampler math.
    const base = await new FaceSampler(this.video).sampleFromLandmarks(lm);
    if (!base) return { ...fail, faceCount: 1, ...extras };
    return { ...base, ...extras };
  }
}

/** Choose the best available engine for this browser. */
export async function createSampler(video: HTMLVideoElement): Promise<{ sampler: Sampler; engine: "human" | "mediapipe" }> {
  const human = await loadHuman();
  if (human) return { sampler: new HumanSampler(video, human), engine: "human" };
  return { sampler: new FaceSampler(video), engine: "mediapipe" };
}

export type { FrameSample };
