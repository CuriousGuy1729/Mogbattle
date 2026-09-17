"use client";
/**
 * Calibration Lab — transparency tooling.
 * Live camera diagnostics (pose, EAR, lighting, sharpness) plus a TEST score
 * computed fully on-device and never submitted or stored.
 */
import { useEffect, useRef, useState } from "react";
import { FaceSampler, openCamera } from "@/lib/client/face";
import { buildAttestation, collectNeutralCapture } from "@/lib/client/attest";
import { QualityBar, Badge } from "@/components/ui";
import type { PslResult } from "@/lib/psl/types";

interface Diagnostics {
  faceCount: number;
  yawDeg: number;
  rollDeg: number;
  ear: number;
  brightness: number;
  contrast: number;
  sharpness: number;
  faceWidthRatio: number;
  gateFails: string[];
}

export default function LabPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<PslResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [camError, setCamError] = useState<string | null>(null);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    (async () => {
      try {
        const stream = await openCamera();
        streamRef.current = stream;
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        const sampler = new FaceSampler(video);
        while (alive) {
          const s = await sampler.sample();
          if (!alive) break;
          setDiag({
            faceCount: s.faceCount,
            yawDeg: s.yawDeg,
            rollDeg: s.rollDeg,
            ear: s.ear,
            brightness: s.brightness,
            contrast: s.contrast,
            sharpness: s.sharpness,
            faceWidthRatio: s.faceWidthRatio,
            gateFails: s.gateFails,
          });
          await new Promise((r) => setTimeout(r, 90));
        }
      } catch (e) {
        setCamError((e as Error).message || "Camera unavailable");
        setRunning(false);
      }
    })();
    return () => {
      alive = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [running]);

  async function runTestScore() {
    if (!videoRef.current) return;
    setBusy(true);
    setTestResult(null);
    setTestError(null);
    try {
      const sampler = new FaceSampler(videoRef.current);
      const cap = await collectNeutralCapture(sampler, { targetFrames: 18, maxMs: 9000 });
      if ("error" in cap) {
        setTestError(`Insufficient capture: ${cap.hint}`);
        return;
      }
      const outcome = await buildAttestation(cap.frames, cap.quality);
      if (!outcome.ok) {
        setTestError(`${outcome.reason} ${outcome.hint}`);
        return;
      }
      setTestResult(outcome.result);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 py-8">
      <div>
        <h1 className="text-3xl font-black">Calibration Lab</h1>
        <p className="mt-1 text-sm text-white/45">
          Inspect exactly what the scoring pipeline sees. Test scores are computed on-device and{" "}
          <span className="text-gold-400">never leave this page</span>.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel overflow-hidden">
          <div className="relative aspect-[4/3] bg-black">
            <video ref={videoRef} autoPlay muted playsInline className="mirror h-full w-full object-cover" />
            {!running && (
              <div className="absolute inset-0 grid place-items-center bg-black/70">
                <button className="btn-gold" onClick={() => setRunning(true)}>Start camera diagnostics</button>
              </div>
            )}
            {camError && (
              <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center text-sm text-arena-red">{camError}</div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-white/5 p-4">
            <div className="text-xs text-white/40">Live frame analysis · ~11 fps</div>
            <button className="btn-ghost !px-4 !py-2 text-sm" disabled={!running || busy} onClick={runTestScore}>
              {busy ? "Measuring…" : "Run test score (not saved)"}
            </button>
          </div>
        </div>

        <div className="panel space-y-4 p-5">
          <h2 className="font-bold">Live gates</h2>
          {diag ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge tone={diag.faceCount === 1 ? "green" : "red"}>{diag.faceCount} face(s)</Badge>
                <Badge tone={Math.abs(diag.yawDeg) <= 10 ? "green" : "red"}>yaw {diag.yawDeg.toFixed(1)}°</Badge>
                <Badge tone={Math.abs(diag.rollDeg) <= 7 ? "green" : "red"}>roll {diag.rollDeg.toFixed(1)}°</Badge>
                <Badge tone={diag.ear > 0.18 ? "green" : "gold"}>EAR {diag.ear.toFixed(3)}</Badge>
              </div>
              <QualityBar label="Brightness (target ~128)" value={1 - Math.abs(diag.brightness - 128) / 128} display={diag.brightness.toFixed(0)} />
              <QualityBar label="Contrast" value={Math.min(1, diag.contrast / 60)} display={diag.contrast.toFixed(0)} />
              <QualityBar label="Sharpness (Laplacian var.)" value={Math.min(1, diag.sharpness / 500)} display={diag.sharpness.toFixed(0)} />
              <QualityBar label="Face size in frame" value={diag.faceWidthRatio >= 0.2 && diag.faceWidthRatio <= 0.85 ? 1 : 0.2} display={`${Math.round(diag.faceWidthRatio * 100)}%`} />
              {diag.gateFails.length > 0 ? (
                <p className="text-xs text-arena-red">Failing: {diag.gateFails.join(" · ")}</p>
              ) : (
                <p className="text-xs text-arena-green">All capture gates passing ✓</p>
              )}
            </>
          ) : (
            <p className="text-sm text-white/35">Start the camera to see live diagnostics.</p>
          )}
        </div>
      </div>

      {testResult && (
        <div className="panel space-y-5 p-6 animate-fade-up">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="label-tech">TEST SCORE · not stored</div>
              <div className="font-mono text-5xl font-black text-gradient-gold">
                {testResult.score.toFixed(2)}<span className="text-xl text-white/40"> /10</span>
              </div>
              <div className="mt-1 flex gap-2">
                <Badge tone="gold">{testResult.version}</Badge>
                <Badge tone="neutral">confidence {(testResult.confidence * 100).toFixed(0)}%</Badge>
              </div>
            </div>
            <p className="max-w-sm text-xs text-white/40">
              Every group below is a weighted bundle of standardized geometric deviations from pinned reference
              values. Identical input produces an identical output — rerun the test to verify reproducibility.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {testResult.groups.map((g) => (
              <div key={g.key} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{g.label}</span>
                  <span className="font-mono font-bold text-gold-400">{g.score.toFixed(2)}</span>
                </div>
                <div className="mt-1 text-[10px] text-white/35">weight {(g.weight * 100).toFixed(0)}%</div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full bg-gold-500" style={{ width: `${g.score * 10}%` }} />
                </div>
                <ul className="mt-3 space-y-1 text-[11px] text-white/50">
                  {g.metrics.map((m) => (
                    <li key={m.key} className="flex justify-between gap-2">
                      <span className="truncate">{m.label}</span>
                      <span className="font-mono shrink-0">
                        {m.value.toFixed(3)} <span className="text-white/30">(ref {m.refMean})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
      {testError && (
        <div className="panel border-arena-red/30 bg-arena-red/[0.06] p-5 text-sm text-arena-red animate-fade-up">{testError}</div>
      )}
    </div>
  );
}
