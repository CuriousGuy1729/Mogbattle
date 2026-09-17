"use client";
/**
 * The battle: VS screen → synchronized countdown → live capture window →
 * on-device scoring → server-mediated reveal. Video runs peer-to-peer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameSocket } from "@/lib/client/wsClient";
import type { BattleMode, PublicPlayer, ServerMsg } from "@/server/protocol";
import { MeshRTC, type SignalPayload } from "@/lib/client/webrtc";
import { createSampler } from "@/lib/client/engine";
import { buildAttestation, collectNeutralCapture } from "@/lib/client/attest";
import { api } from "@/lib/client/session";
import { Badge, CountUp, Modal } from "./ui";

type MatchFound = Extract<ServerMsg, { t: "match_found" }>;
type MatchResult = Extract<ServerMsg, { t: "match_result" }>;

type Phase = "vs" | "countdown" | "capture" | "await" | "reveal";

export default function BattleRoom({
  socket,
  match,
  myId,
  stream,
  onExit,
}: {
  socket: GameSocket;
  match: MatchFound;
  myId: string;
  stream: MediaStream;
  onExit: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("vs");
  const [count, setCount] = useState<number | "GO" | null>(null);
  const [capturePct, setCapturePct] = useState(0);
  const [submitState, setSubmitState] = useState<"idle" | "submitted" | "failed">("idle");
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [peerDown, setPeerDown] = useState<Record<string, boolean>>({});
  const [reportTarget, setReportTarget] = useState<string | null>(null);
  const [reported, setReported] = useState(false);
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

  const meshRef = useRef<MeshRTC | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const captureStarted = useRef(false);
  const timingsRef = useRef<{ countdownAt: number; captureStart: number; captureEnd: number } | null>(null);

  const mode = match.mode;
  const mySide = match.players.find((p) => p.you)?.side ?? 0;
  const enemies = useMemo(() => match.players.filter((p) => p.side !== mySide), [match, mySide]);
  const allies = useMemo(() => match.players.filter((p) => p.side === mySide && !p.you), [match, mySide]);

  /* attach local preview */
  useEffect(() => {
    if (localVideoRef.current && stream) {
      localVideoRef.current.srcObject = stream;
    }
  }, [phase, stream]);

  /* attach remote streams as they arrive */
  useEffect(() => {
    for (const [id, s] of Object.entries(remoteStreams)) {
      const el = remoteVideoRefs.current[id];
      if (el && el.srcObject !== s) el.srcObject = s;
    }
  }, [remoteStreams, phase]);

  /* WebRTC mesh lifecycle */
  useEffect(() => {
    const mesh = new MeshRTC(
      myId,
      (to, data: SignalPayload) => socket.send({ t: "rtc_signal", to, data }),
      (from, s) => setRemoteStreams((prev) => ({ ...prev, [from]: s }))
    );
    meshRef.current = mesh;
    mesh.setLocalStream(stream);
    for (const p of match.players) {
      if (p.id !== myId) void mesh.openPeer(p.id);
    }
    const offSignal = socket.on("rtc_signal", (m) => void mesh.handleSignal(m.from, m.data as SignalPayload));
    const offPeer = socket.on("peer_state", (m) => setPeerDown((prev) => ({ ...prev, [m.id]: !m.connected })));
    return () => {
      offSignal();
      offPeer();
      mesh.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.matchId]);

  /* server-driven pacing */
  useEffect(() => {
    const offStart = socket.on("battle_start", (m) => {
      timingsRef.current = { countdownAt: m.countdownAt, captureStart: m.captureStart, captureEnd: m.captureEnd };
      setPhase("countdown");
    });
    const offResult = socket.on("match_result", (m) => {
      setResult(m);
      setPhase("reveal");
    });
    const offAck = socket.on("score_ack", (m) => {
      setSubmitState(m.accepted ? "submitted" : "failed");
      if (!m.accepted && m.reason) setFailMsg(m.reason);
    });
    return () => {
      offStart();
      offResult();
      offAck();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* countdown → capture driver */
  useEffect(() => {
    if (phase !== "countdown") return;
    let raf = 0;
    const tick = () => {
      const t = timingsRef.current;
      if (!t) return;
      const now = socket.now();
      if (now >= t.captureStart) {
        setCount("GO");
        setPhase("capture");
        return;
      }
      const remain = t.captureStart - now;
      const total = t.captureStart - t.countdownAt;
      const n = Math.max(1, Math.ceil((remain / total) * 3));
      setCount(n);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /* capture window */
  useEffect(() => {
    if (phase !== "capture" || captureStarted.current) return;
    captureStarted.current = true;
    (async () => {
      const t = timingsRef.current;
      const video = localVideoRef.current;
      if (!t || !video) return;
      const budget = Math.max(2500, t.captureEnd - socket.now() - 400);
      const { sampler } = await createSampler(video);
      const capture = await collectNeutralCapture(sampler, {
        targetFrames: 16,
        maxMs: budget,
        onProgress: (have, need) => setCapturePct(Math.min(100, Math.round((have / need) * 100))),
      });
      if ("error" in capture) {
        setSubmitState("failed");
        setFailMsg(`Capture failed: ${capture.hint}`);
        setPhase("await");
        return;
      }
      const outcome = await buildAttestation(capture.frames, capture.quality);
      if (!outcome.ok) {
        setSubmitState("failed");
        setFailMsg(`${outcome.reason} ${outcome.hint}`);
        setPhase("await");
        return;
      }
      socket.send({ t: "battle_score", attestation: outcome.attestation });
      setPhase("await");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function doReport(reason: string) {
    if (!reportTarget) return;
    try {
      await api("/api/report", { method: "POST", body: JSON.stringify({ targetId: reportTarget, reason, matchId: match.matchId }) });
      setReported(true);
    } catch {
      /* rate limited — surface nothing dramatic */
    }
  }

  async function doBlock(id: string) {
    try {
      await api("/api/block", { method: "POST", body: JSON.stringify({ targetId: id }) });
      setBlockedIds((prev) => new Set(prev).add(id));
    } catch {
      /* noop */
    }
  }

  const modeLabel: Record<BattleMode, string> = { ranked: "RANKED 1v1", casual: "CASUAL 1v1", duo: "RANDOM DUO 2v2", friend: "FRIEND CHALLENGE" };

  /* ── REVEAL ─────────────────────────────────────────────────────────── */
  if (phase === "reveal" && result) {
    const rated = result.elo != null;
    const myResult = result.win === null ? "DRAW" : result.win ? "WIN" : "LOSS";
    return (
      <div className="mx-auto max-w-3xl space-y-6 py-8">
        <div className="text-center">
          <div className="label-tech mb-2">{modeLabel[result.mode]} · MATCH {result.matchId.slice(0, 8)}</div>
          <div
            className={`animate-pop-in text-6xl font-black tracking-tight sm:text-7xl ${
              myResult === "WIN" ? "text-arena-green" : myResult === "LOSS" ? "text-arena-red" : "text-gold-400"
            }`}
          >
            {myResult}
          </div>
          {rated && result.elo && (
            <div className="animate-fade-up mt-3 inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-6 py-3" style={{ animationDelay: "0.3s" }}>
              <span className="font-mono text-2xl font-bold" style={{ color: result.elo.delta >= 0 ? "#3ddc84" : "#ff4d5e" }}>
                {result.elo.delta >= 0 ? "+" : ""}
                {result.elo.delta} ELO
              </span>
              <span className="text-sm text-white/50">
                {result.elo.before} → {result.elo.after}
              </span>
              {result.rank && (
                <span className="chip ml-2">
                  rank {result.rank.before} → {result.rank.after}
                </span>
              )}
            </div>
          )}
          {!rated && result.status !== "aborted" && (
            <div className="mt-3 text-sm text-white/50">Casual match — no rating change. W/L tracked separately.</div>
          )}
          {result.status === "aborted" && <div className="mt-3 text-sm text-white/50">Match aborted — no usable capture on either side. Nothing was scored.</div>}
          {result.suspicious && (
            <div className="mx-auto mt-3 max-w-md rounded-xl border border-gold-500/30 bg-gold-500/10 px-4 py-2 text-xs text-gold-300">
              ⚠ This match was flagged by anti-cheat heuristics. Elo gains are halved and the result is logged for review.
            </div>
          )}
        </div>

        <div className="panel space-y-4 p-5">
          {result.sides.map((side) => {
            const winner = result.winnerSide === side.side;
            const isMySide = side.side === mySide;
            return (
              <div
                key={side.side}
                className={`flex items-center justify-between rounded-xl border p-4 ${
                  winner ? "border-gold-500/50 bg-gold-500/[0.06]" : "border-white/10 bg-white/[0.02]"
                }`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone={winner ? "gold" : "neutral"}>{winner ? "WINNER" : isMySide ? "YOU" : "OPPONENT"}</Badge>
                  {side.players.map((p) => (
                    <div key={p.id} className="flex items-center gap-2">
                      <span className="font-semibold">{p.handle}</span>
                      {blockedIds.has(p.id) && <Badge tone="cyan">blocked</Badge>}
                    </div>
                  ))}
                </div>
                <div className="font-mono text-2xl font-bold text-white">
                  {side.score != null ? <CountUp value={side.score} /> : <span className="text-white/30">—</span>}
                  <span className="text-sm text-white/40"> /10</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <button className="btn-gold" onClick={onExit}>
            Continue
          </button>
          {enemies.map((e) => (
            <div key={e.id} className="flex gap-2">
              <button
                className="btn-ghost !px-3 !py-2 text-xs"
                onClick={() => {
                  setReported(false);
                  setReportTarget(e.id);
                }}
              >
                Report {e.handle}
              </button>
              <button className="btn-ghost !px-3 !py-2 text-xs" disabled={blockedIds.has(e.id)} onClick={() => doBlock(e.id)}>
                {blockedIds.has(e.id) ? "Blocked ✓" : "Block"}
              </button>
            </div>
          ))}
        </div>

        <Modal open={!!reportTarget} onClose={() => setReportTarget(null)} title="Report player">
          {reported ? (
            <div className="space-y-4">
              <p className="text-sm text-white/70">Report filed. Our trust systems review patterns automatically — thank you for keeping the arena honest.</p>
              <button className="btn-gold w-full" onClick={() => setReportTarget(null)}>Close</button>
            </div>
          ) : (
            <div className="space-y-2">
              {[
                ["cheating", "Cheating / spoofed camera"],
                ["fake_video", "Replayed or synthetic video"],
                ["inappropriate", "Inappropriate behavior"],
                ["harassment", "Harassment"],
              ].map(([id, label]) => (
                <button key={id} className="btn-ghost w-full justify-start text-sm" onClick={() => doReport(id)}>
                  {label}
                </button>
              ))}
              <button className="btn-ghost w-full justify-start text-sm" onClick={() => doReport("other")}>Something else</button>
            </div>
          )}
        </Modal>
      </div>
    );
  }

  /* ── LIVE STAGE ─────────────────────────────────────────────────────── */
  return (
    <div className="space-y-4 py-4">
      <div className="flex items-center justify-between">
        <Badge tone="gold">{modeLabel[mode]}</Badge>
        <span className="font-mono text-xs text-white/40">match {match.matchId.slice(0, 8)} · P2P video live</span>
      </div>

      {/* VS header during intro */}
      {phase === "vs" && (
        <div className="panel grid grid-cols-[1fr_auto_1fr] items-center gap-2 p-6">
          <SideRoster players={match.players.filter((p) => p.side === mySide)} highlight={myId} align="left" />
          <div className="animate-vs-flash px-2 text-center">
            <div className="text-5xl font-black italic text-gradient-gold sm:text-6xl">VS</div>
            <VsTimer socket={socket} until={match.vsUntil} />
          </div>
          <SideRoster players={match.players.filter((p) => p.side !== mySide)} align="right" />
        </div>
      )}

      {/* video grid */}
      <div className={`grid gap-3 ${match.players.length > 2 ? "grid-cols-2" : "grid-cols-2"}`}>
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black">
          <video ref={localVideoRef} autoPlay muted playsInline className="mirror aspect-[4/3] w-full object-cover" />
          <div className="absolute bottom-2 left-2 flex items-center gap-2">
            <Badge tone="green">YOU</Badge>
            {phase === "capture" && <Badge tone="gold">capturing {capturePct}%</Badge>}
            {submitState === "submitted" && <Badge tone="green">score locked ✓</Badge>}
            {submitState === "failed" && <Badge tone="red">capture failed</Badge>}
          </div>
        </div>

        {enemies.map((e) => (
          <div key={e.id} className="relative overflow-hidden rounded-2xl border border-white/10 bg-black">
            <video
              ref={(el) => {
                remoteVideoRefs.current[e.id] = el;
              }}
              autoPlay
              playsInline
              muted
              className="aspect-[4/3] w-full object-cover"
            />
            <div className="absolute bottom-2 left-2 flex items-center gap-2">
              <Badge tone="red">{e.handle}</Badge>
              {peerDown[e.id] && <Badge tone="neutral">reconnecting…</Badge>}
            </div>
          </div>
        ))}
        {allies.map((a) => (
          <div key={a.id} className="relative overflow-hidden rounded-2xl border border-white/10 bg-black">
            <video
              ref={(el) => {
                remoteVideoRefs.current[a.id] = el;
              }}
              autoPlay
              playsInline
              muted
              className="aspect-[4/3] w-full object-cover"
            />
            <div className="absolute bottom-2 left-2">
              <Badge tone="cyan">ALLY · {a.handle}</Badge>
            </div>
          </div>
        ))}
      </div>

      {/* countdown / status strip */}
      <div className="panel p-5 text-center">
        {phase === "vs" && <p className="text-sm text-white/60">Opponent verified. Battle starts automatically…</p>}
        {phase === "countdown" && count !== null && (
          <div key={String(count)} className="animate-count-pop text-6xl font-black text-gradient-gold">
            {count}
          </div>
        )}
        {phase === "capture" && (
          <div className="space-y-2">
            <p className="text-lg font-bold text-gold-400">CAPTURE WINDOW OPEN — neutral face, look into the lens</p>
            <div className="mx-auto h-2 max-w-md overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-gold-500 transition-all duration-200" style={{ width: `${capturePct}%` }} />
            </div>
            <p className="text-xs text-white/40">Scoring runs on your device from stabilized landmarks — identical conditions give identical scores.</p>
          </div>
        )}
        {phase === "await" && (
          <div className="space-y-2">
            {submitState === "submitted" ? (
              <p className="text-lg font-bold text-arena-green">Battle score locked. Waiting for opponent…</p>
            ) : (
              <div className="space-y-1">
                <p className="text-lg font-bold text-arena-red">Your capture was not certified.</p>
                {failMsg && <p className="text-xs text-white/50">{failMsg}</p>}
                <p className="text-xs text-white/40">Without a certified capture you forfeit this round — by design, we never estimate.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function VsTimer({ socket, until }: { socket: GameSocket; until: number }) {
  const [pct, setPct] = useState(100);
  useEffect(() => {
    const iv = setInterval(() => {
      const remain = until - socket.now();
      setPct(Math.max(0, Math.min(100, (remain / 5200) * 100)));
    }, 60);
    return () => clearInterval(iv);
  }, [socket, until]);
  return <div className="mx-auto mt-3 h-1 w-24 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-gold-500" style={{ width: `${pct}%` }} /></div>;
}

function SideRoster({ players, align, highlight }: { players: PublicPlayer[]; align: "left" | "right"; highlight?: string }) {
  return (
    <div className={`space-y-2 ${align === "right" ? "text-right" : ""}`}>
      {players.map((p) => (
        <div key={p.id} className={align === "right" ? "flex flex-col items-end" : ""}>
          <div className={`font-bold ${p.id === highlight ? "text-gold-400" : ""}`}>{p.handle}{p.you ? " (you)" : ""}</div>
          <div className="flex gap-2 font-mono text-xs text-white/50">
            <span>ELO {p.elo}</span>
            <span>PSL {p.psl != null ? p.psl.toFixed(2) : "—"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
