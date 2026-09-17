"use client";
/**
 * Liveness challenge runner — executes the server-issued (randomized)
 * challenge sequence and accumulates per-challenge evidence that the server
 * validates before certifying a scan.
 */
import type { ChallengeId } from "@/server/scanSessions";
import { LIVENESS } from "@/lib/psl/version";
import type { FrameSample } from "./face";

export interface ChallengeUi {
  id: ChallengeId;
  title: string;
  hint: string;
  arrow: "left" | "right" | null;
}

export const CHALLENGE_UI: Record<ChallengeId, ChallengeUi> = {
  neutral_start: { id: "neutral_start", title: "Look straight at the lens", hint: "Center your face in the ring. Relax your expression.", arrow: null },
  turn_left: { id: "turn_left", title: "Turn your head left", hint: "Slowly turn toward the arrow, then hold.", arrow: "left" },
  turn_right: { id: "turn_right", title: "Turn your head right", hint: "Slowly turn toward the arrow, then hold.", arrow: "right" },
  blink: { id: "blink", title: "Blink naturally", hint: "Keep facing the camera and blink once or twice.", arrow: null },
  neutral_end: { id: "neutral_end", title: "Return to neutral", hint: "Face the lens again and hold still.", arrow: null },
};

interface ChallengeEvidenceAcc {
  id: ChallengeId;
  startedAt: number;
  goodMs: number;
  frames: number;
  goodFrames: number;
  yaws: number[];
  rolls: number[];
  maxYaw: number;
  minYaw: number;
  minEar: number;
  blinkCount: number;
  earPhase: "baseline" | "closing" | "open";
  baselineMs: number;
  lastSampleAt: number;
}

const NEUTRAL_HOLD_MS = 1400;

export class LivenessRunner {
  private accs: ChallengeEvidenceAcc[];
  private idx = 0;
  failed: string | null = null;

  constructor(public challenges: ChallengeId[]) {
    this.accs = challenges.map((id) => ({
      id,
      startedAt: 0,
      goodMs: 0,
      frames: 0,
      goodFrames: 0,
      yaws: [],
      rolls: [],
      maxYaw: -Infinity,
      minYaw: Infinity,
      minEar: Infinity,
      blinkCount: 0,
      earPhase: "baseline",
      baselineMs: 0,
      lastSampleAt: 0,
    }));
  }

  get current(): ChallengeId | null {
    return this.idx < this.challenges.length ? this.challenges[this.idx] : null;
  }

  get progress(): number {
    const a = this.accs[this.idx];
    if (!a) return 1;
    switch (a.id) {
      case "neutral_start":
      case "neutral_end":
        return Math.min(1, a.goodMs / NEUTRAL_HOLD_MS);
      case "turn_left":
        return Math.min(1, Math.max(0, a.maxYaw) / LIVENESS.turnThresholdDeg);
      case "turn_right":
        return Math.min(1, Math.max(0, -a.minYaw) / LIVENESS.turnThresholdDeg);
      case "blink":
        return Math.min(1, a.blinkCount);
    }
  }

  get done(): boolean {
    return this.idx >= this.challenges.length;
  }

  /** Feed one camera sample. Returns true when a challenge just completed. */
  feed(sample: FrameSample, at: number): boolean {
    if (this.done || this.failed) return false;
    const a = this.accs[this.idx];
    const dt = a.lastSampleAt ? Math.max(0, Math.min(200, at - a.lastSampleAt)) : 33;
    a.lastSampleAt = at;
    if (a.startedAt === 0) a.startedAt = at;
    a.frames++;

    const present = sample.ok && sample.faceCount === 1;
    if (present) a.goodFrames++;

    switch (a.id) {
      case "neutral_start":
      case "neutral_end": {
        if (present) {
          a.yaws.push(sample.yawDeg);
          a.rolls.push(sample.rollDeg);
          if (Math.abs(sample.yawDeg) <= LIVENESS.neutralYawMaxDeg && Math.abs(sample.rollDeg) <= LIVENESS.neutralRollMaxDeg) {
            a.goodMs += dt;
          }
        }
        if (a.goodMs >= NEUTRAL_HOLD_MS) return this.advance(at);
        break;
      }
      case "turn_left": {
        if (present) {
          a.yaws.push(sample.yawDeg);
          a.maxYaw = Math.max(a.maxYaw, sample.yawDeg);
        }
        if (a.maxYaw >= LIVENESS.turnThresholdDeg) return this.advance(at);
        break;
      }
      case "turn_right": {
        if (present) {
          a.yaws.push(sample.yawDeg);
          a.minYaw = Math.min(a.minYaw, sample.yawDeg);
        }
        if (a.minYaw <= -LIVENESS.turnThresholdDeg) return this.advance(at);
        break;
      }
      case "blink": {
        if (present) {
          a.minEar = Math.min(a.minEar, sample.ear);
          if (a.earPhase === "baseline") {
            a.baselineMs += dt;
            if (sample.ear < LIVENESS.blinkEarMin && a.baselineMs > 250) a.earPhase = "closing";
          } else if (a.earPhase === "closing") {
            if (sample.ear > LIVENESS.blinkEarMin) {
              a.blinkCount++;
              return this.advance(at);
            }
          }
        }
        break;
      }
    }

    if (at - a.startedAt > LIVENESS.challengeMaxMs) {
      this.failed = `Challenge "${a.id}" timed out. Please restart the scan.`;
    }
    return false;
  }

  private advance(at: number): boolean {
    this.idx++;
    if (this.idx < this.accs.length) this.accs[this.idx].startedAt = at;
    return true;
  }

  evidence(): Array<Record<string, unknown>> {
    return this.accs.map((a) => {
      const dur = a.lastSampleAt - a.startedAt;
      const presence = a.frames ? a.goodFrames / a.frames : 0;
      const med = (arr: number[]) => {
        if (!arr.length) return 0;
        const s = [...arr].sort((x, y) => x - y);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      };
      const base: Record<string, unknown> = {
        id: a.id,
        durationMs: Math.round(dur),
        facePresence: Math.round(presence * 1000) / 1000,
      };
      if (a.id === "neutral_start" || a.id === "neutral_end") {
        base.medianYawDeg = Math.round(med(a.yaws) * 10) / 10;
        base.medianRollDeg = Math.round(med(a.rolls) * 10) / 10;
      }
      if (a.id === "turn_left") base.maxYawDeg = a.maxYaw === -Infinity ? 0 : Math.round(a.maxYaw * 10) / 10;
      if (a.id === "turn_right") base.minYawDeg = a.minYaw === Infinity ? 0 : Math.round(a.minYaw * 10) / 10;
      if (a.id === "blink") {
        base.minEar = a.minEar === Infinity ? 1 : Math.round(a.minEar * 1000) / 1000;
        base.blinkCount = a.blinkCount;
      }
      return base;
    });
  }
}
