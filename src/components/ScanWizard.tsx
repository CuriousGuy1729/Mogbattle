"use client";
/**
 * Mandatory face-verification scan.
 * consent → camera → server-randomized liveness challenges → neutral capture
 * → on-device scoring → server certification. Refuses to emit a score when
 * capture quality is insufficient.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/session";
import { FaceSampler, loadFaceLandmarker, openCamera } from "@/lib/client/face";
import { CHALLENGE_UI, LivenessRunner } from "@/lib/client/liveness";
import { buildAttestation, collectNeutralCapture } from "@/lib/client/attest";
import type { ChallengeId } from "@/server/scanSessions";
import { Badge, ConfidenceBar, QualityBar, Spinner } from "./ui";

export interface VerifiedScan {
  scanId: string;
  psl: number;
  confidence: number;
  version: string;
  validForMs: number;
  quality: Record<string, number>;
  components: Record<string, number>;
}

type Phase = "intro" | "starting" | "challenges" | "capturing" | "verifying" | "failed";

export default function ScanWizard({
  onVerified,
  compact = false,
  externalStream = null,
}: {
  onVerified: (s: VerifiedScan) => void;
  compact?: boolean;
  /** When provided, the wizard reuses this stream and never stops it. */
  externalStream?: MediaStream | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ownsStreamRef = useRef(false);
  const runnerRef = useRef<LivenessRunner | null>(null);
  const rafRef = useRef(0);
  const phaseRef = useRef<Phase>("intro");

  const [phase, _setPhase] = useState<Phase>("intro");
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    _setPhase(p);
  };
  const [challenge, setChallenge] = useState<ChallengeId | null>(null);
  const [progress, setProgress] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [steps, setSteps] = useState<ChallengeId[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [liveIssue, setLiveIssue] = useState<string | null>(null);
  const [capturePct, setCapturePct] = useState(0);
  const [failReason, setFailReason] = useState<{ reason: string; rescan: boolean } | null>(null);

  const cleanup = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (ownsStreamRef.current) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  async function begin() {
    setPhase("starting");
    setFailReason(null);
    try {
      let stream = externalStream;
      ownsStreamRef.current = false;
      if (!stream || !stream.active) {
        stream = await openCamera();
        ownsStreamRef.current = true;
      }
      streamRef.current = stream;
      await loadFaceLandmarker();
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      const session = await api<{ sessionId: string; challenges: ChallengeId[] }>("/api/scan/session", { method: "POST" });
      runnerRef.current = new LivenessRunner(session.challenges);
      setSteps(session.challenges);
      setStepIndex(0);
      setChallenge(session.challenges[0]);
      setProgress(0);
      setPhase("challenges");
      requestAnimationFrame(() => loop(session.sessionId, session.challenges));
    } catch (e) {
      const err = e as Error & { status?: number; payload?: { message?: string } };
      setFailReason({
        reason:
          err?.payload?.message ||
          (err?.message?.includes("Permission") || err?.name === "NotAllowedError"
            ? "Camera permission denied. Allow camera access in your browser and try again."
            : `Could not start the scan: ${err?.message ?? "unknown error"}`),
        rescan: true,
      });
      setPhase("failed");
    }
  }

  async function loop(sessionId: string, challenges: ChallengeId[]) {
    const video = videoRef.current;
    const runner = runnerRef.current;
    if (!video || !runner) return;
    const sampler = new FaceSampler(video);

    while (!runner.done && !runner.failed && phaseRef.current === "challenges") {
      const s = await sampler.sample();
      const advanced = runner.feed(s, Date.now());
      setLiveIssue(s.ok ? (s.gateFails[0] ?? null) : s.gateFails[0] ?? "no camera frame");
      setProgress(runner.progress);
      if (advanced) {
        setStepIndex((i) => Math.min(i + 1, challenges.length));
        setChallenge(runner.current);
      }
      if (runner.failed) {
        setFailReason({ reason: runner.failed, rescan: true });
        setPhase("failed");
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!runner.done) return;

    // Neutral geometry capture for scoring.
    setPhase("capturing");
    const capture = await collectNeutralCapture(sampler, {
      targetFrames: 18,
      maxMs: 9000,
      onProgress: (have, need) => setCapturePct(Math.round((have / need) * 100)),
    });
    if ("error" in capture) {
      setFailReason({ reason: `Capture quality insufficient. ${capture.hint}`, rescan: true });
      setPhase("failed");
      return;
    }

    setPhase("verifying");
    const outcome = await buildAttestation(capture.frames, capture.quality);
    if (!outcome.ok) {
      setFailReason({ reason: `${outcome.reason} ${outcome.hint}`, rescan: true });
      setPhase("failed");
      return;
    }

    try {
      const res = await api<VerifiedScan & { error?: string; message?: string }>("/api/scan/verify", {
        method: "POST",
        body: JSON.stringify({ sessionId, evidence: runner.evidence(), attestation: outcome.attestation }),
      });
      cleanup();
      onVerified(res);
    } catch (e) {
      const err = e as Error & { payload?: { message?: string; rescan?: boolean } };
      setFailReason({ reason: err?.payload?.message ?? err.message, rescan: err?.payload?.rescan ?? true });
      setPhase("failed");
    }
  }

  const ui = challenge ? CHALLENGE_UI[challenge] : null;

  return (
    <div className="panel mx-auto w-full max-w-2xl overflow-hidden">
      <div className="relative aspect-[4/3] w-full bg-black">
        <video ref={videoRef} autoPlay muted playsInline className="mirror h-full w-full object-cover" />

        {/* focus ring overlay */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div
            className={`h-[72%] w-[52%] rounded-[46%] border-2 transition-colors duration-500 ${
              phase === "challenges" || phase === "capturing" ? "border-gold-500/70 animate-pulse-ring" : "border-white/20"
            }`}
          />
        </div>
        {phase === "capturing" && (
          <div className="scanline pointer-events-none absolute left-[10%] right-[10%] h-[2px] bg-gradient-to-r from-transparent via-gold-400 to-transparent" />
        )}

        {phase === "intro" && (
          <div className="absolute inset-0 grid place-items-center bg-black/70 p-6 text-center backdrop-blur-sm">
            <div className="max-w-md space-y-4">
              <h3 className="text-xl font-bold">Face Verification Scan</h3>
              <p className="text-sm text-white/60">
                A short guided scan proves you are a live human with one real face in frame. It also produces your
                certified PSL score. No images are uploaded — analysis runs on this device.
              </p>
              <button className="btn-gold" onClick={begin}>
                Enable Camera &amp; Start
              </button>
            </div>
          </div>
        )}

        {phase === "starting" && (
          <div className="absolute inset-0 grid place-items-center bg-black/70 backdrop-blur-sm">
            <Spinner label="Loading camera + on-device model…" />
          </div>
        )}

        {phase === "failed" && (
          <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center backdrop-blur-sm">
            <div className="max-w-md space-y-4">
              <Badge tone="red">SCAN NOT CERTIFIED</Badge>
              <p className="text-sm text-white/70">{failReason?.reason}</p>
              <p className="text-xs text-white/40">
                We never fabricate a score from unusable input — a clean rescan takes ~20 seconds.
              </p>
              {failReason?.rescan !== false ? (
                <button className="btn-gold" onClick={begin}>
                  Rescan Now
                </button>
              ) : (
                <button className="btn-ghost" onClick={() => location.reload()}>
                  Reload
                </button>
              )}
            </div>
          </div>
        )}

        {ui && phase === "challenges" && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  {ui.arrow && (
                    <span className="text-2xl text-gold-400">{ui.arrow === "left" ? "⟵" : "⟶"}</span>
                  )}
                  <h4 className="text-lg font-bold">{ui.title}</h4>
                </div>
                <p className="text-xs text-white/50">{ui.hint}</p>
              </div>
              <span className="font-mono text-xs text-white/40">
                step {Math.min(stepIndex + 1, steps.length)}/{steps.length}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-gold-500 transition-all duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </div>
        )}

        {phase === "capturing" && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-4">
            <div className="flex items-center justify-between">
              <h4 className="text-lg font-bold">Hold still — measuring geometry</h4>
              <span className="font-mono text-gold-400">{capturePct}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-gold-500 transition-all duration-150" style={{ width: `${capturePct}%` }} />
            </div>
          </div>
        )}

        {phase === "verifying" && (
          <div className="absolute inset-0 grid place-items-center bg-black/70 backdrop-blur-sm">
            <Spinner label="Certifying scan with the server…" />
          </div>
        )}
      </div>

      {!compact && (phase === "challenges" || phase === "capturing") && (
        <div className="space-y-3 border-t border-white/5 p-4">
          <div className="grid grid-cols-2 gap-3">
            <QualityBar label={liveIssue ? `Issue: ${liveIssue}` : "Frame quality OK"} value={liveIssue ? 0.25 : 1} display={liveIssue ? "fix" : "pass"} />
            <QualityBar label="Liveness sequence" value={steps.length ? (stepIndex + progress) / steps.length : 0} />
          </div>
          <p className="text-[11px] leading-relaxed text-white/35">
            Randomized challenge order + timing validation + single-face gate + quality gates protect every scan.
            Screenshots, static photos and replayed clips fail these checks.
          </p>
        </div>
      )}
    </div>
  );
}
