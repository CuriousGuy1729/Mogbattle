"use client";
/**
 * The Arena: consent → verification scan → mode select → randomized queue →
 * P2P battle → reveal → repeat. One camera stream powers scan and battle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ensureSession, api, type MyPlayer } from "@/lib/client/session";
import { openCamera } from "@/lib/client/face";
import { GameSocket } from "@/lib/client/wsClient";
import ScanWizard, { type VerifiedScan } from "@/components/ScanWizard";
import BattleRoom from "@/components/BattleRoom";
import PslReport from "@/components/PslReport";
import { groupsFromComponents } from "@/lib/psl/report";
import { Badge, Spinner } from "@/components/ui";
import type { BattleMode, ServerMsg } from "@/server/protocol";

type Stage =
  | "loading"
  | "error"
  | "consent"
  | "camera"
  | "scan"
  | "ready"
  | "queue"
  | "friend_wait"
  | "match";

const MODES: Array<{ id: BattleMode; title: string; desc: string; tone: string }> = [
  { id: "ranked", title: "Random Ranked 1v1", desc: "Elo on the line. Both players certified, both scored.", tone: "text-gold-400" },
  { id: "casual", title: "Random Casual 1v1", desc: "Same pipeline, zero pressure. No rating change.", tone: "text-arena-cyan" },
  { id: "duo", title: "Random Duo 2v2", desc: "You + a random teammate vs another pair. Team PSL decides.", tone: "text-arena-violet" },
  { id: "friend", title: "Friend Challenge", desc: "Create a code or join one. Casual bragging rights.", tone: "text-arena-green" },
];

export default function PlayPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [me, setMe] = useState<MyPlayer | null>(null);
  const [scan, setScan] = useState<VerifiedScan | null>(null);
  const [scanValidLeft, setScanValidLeft] = useState(0);
  const [scanIssuedAt, setScanIssuedAt] = useState(0);
  const [queueMode, setQueueMode] = useState<BattleMode | null>(null);
  const [queueInfo, setQueueInfo] = useState<{
    position: number;
    size: number;
    sizes?: Partial<Record<BattleMode, number>>;
    queuedAt?: number;
  } | null>(null);
  const [queueWait, setQueueWait] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [friendCode, setFriendCode] = useState<string | null>(null);
  const [friendInput, setFriendInput] = useState("");
  const [match, setMatch] = useState<Extract<ServerMsg, { t: "match_found" }> | null>(null);

  const socketRef = useRef<GameSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stageRef = useRef<Stage>("loading");
  stageRef.current = stage;

  /* boot: session + socket */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { token, player } = await ensureSession();
        if (!alive) return;
        setMe(player);
        const gs = new GameSocket();
        socketRef.current = gs;
        await gs.connect(token);
        gs.on("scan_required", () => {
          setScan(null);
          setStage("scan");
        });
        gs.on("queue_state", (m) =>
          setQueueInfo({ position: m.position, size: m.size, sizes: m.sizes, queuedAt: m.queuedAt })
        );
        gs.on("queue_left", () => {
          setQueueMode(null);
          setQueueInfo(null);
        });
        gs.on("error", (m) => {
          setNotice(m.message);
          setQueueMode(null);
          setQueueInfo(null);
          if (stageRef.current === "queue" || stageRef.current === "friend_wait") setStage("ready");
          setTimeout(() => setNotice(null), 6000);
        });
        gs.on("friend_code", (m) => {
          setFriendCode(m.code);
          setStage("friend_wait");
        });
        gs.on("match_found", (m) => {
          setMatch(m);
          setQueueMode(null);
          setStage("match");
        });
        // restore existing scan state (page refresh mid-session)
        const sess = await api<{
          player: MyPlayer;
          scan: {
            id: string; psl: number; confidence: number; version: string; validForMs: number;
            stillValidMs: number; quality: Record<string, number>; components: Record<string, number>;
          } | null;
        }>("/api/session");
        setMe(sess.player);
        if (sess.scan && sess.scan.stillValidMs > 0) {
          setScan({
            scanId: sess.scan.id,
            psl: sess.scan.psl,
            confidence: sess.scan.confidence,
            version: sess.scan.version,
            validForMs: sess.scan.validForMs,
            quality: sess.scan.quality,
            components: sess.scan.components,
          });
          setScanIssuedAt(Date.now() - (sess.scan.validForMs - sess.scan.stillValidMs));
          setScanValidLeft(sess.scan.stillValidMs);
          setStage("ready");
        } else {
          setStage("consent");
        }
      } catch (e) {
        setErrMsg((e as Error).message);
        setStage("error");
      }
    })();
    return () => {
      alive = false;
      socketRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /* live "waiting" seconds while queued */
  useEffect(() => {
    if (stage !== "queue") return;
    const iv = setInterval(() => {
      setQueueWait(queueInfo?.queuedAt ? Math.max(0, Math.floor((Date.now() - queueInfo.queuedAt) / 1000)) : 0);
    }, 1000);
    setQueueWait(queueInfo?.queuedAt ? Math.max(0, Math.floor((Date.now() - queueInfo.queuedAt) / 1000)) : 0);
    return () => clearInterval(iv);
  }, [stage, queueInfo?.queuedAt]);

  /* scan validity countdown (display only — gate is currently optional) */
  useEffect(() => {
    if (!scan) return;
    const iv = setInterval(() => {
      const left = (scan.validForMs ?? 0) - (Date.now() - scanIssuedAt);
      setScanValidLeft(Math.max(0, left));
    }, 1000);
    return () => clearInterval(iv);
  }, [scan, scanIssuedAt]);

  async function ensureCamera(): Promise<MediaStream | null> {
    if (streamRef.current?.active) return streamRef.current;
    try {
      streamRef.current = await openCamera();
      return streamRef.current;
    } catch {
      return null;
    }
  }

  const onConsent = useCallback(async () => {
    // Camera is best-effort here — battles open it again if needed.
    void (await ensureCamera());
    setStage("ready");
  }, []);

  const onVerified = useCallback((s: VerifiedScan) => {
    setScan(s);
    setScanIssuedAt(Date.now());
    setScanValidLeft(s.validForMs);
    setStage("ready");
  }, []);

  async function joinQueue(mode: BattleMode) {
    const gs = socketRef.current;
    if (!gs) return;
    await ensureCamera(); // warm the camera while the queue searches
    setQueueMode(mode);
    setQueueInfo(null);
    gs.send({ t: "queue_join", mode });
    setStage("queue");
  }

  function leaveQueue() {
    socketRef.current?.send({ t: "queue_leave" });
    setQueueMode(null);
    setQueueInfo(null);
    setStage("ready");
  }

  function createFriend() {
    setFriendCode(null);
    void ensureCamera();
    socketRef.current?.send({ t: "friend_create" });
  }

  async function joinFriend() {
    if (!/^\d{6}$/.test(friendInput)) return;
    await ensureCamera();
    setQueueMode("friend");
    socketRef.current?.send({ t: "queue_join", mode: "friend", friendCode: friendInput });
    setStage("queue");
  }

  // Fallback stream for browsers where the camera never came up (SSR-safe: MediaStream is browser-only).
  const emptyStream = useMemo(() => (typeof MediaStream !== "undefined" ? new MediaStream() : null), []);

  /* ── render ─────────────────────────────────────────────────────────── */

  if (stage === "loading") {
    return (
      <div className="grid min-h-[50vh] place-items-center">
        <Spinner label="Connecting to the arena…" />
      </div>
    );
  }

  if (stage === "error") {
    return (
      <div className="mx-auto max-w-md space-y-4 py-20 text-center">
        <h2 className="text-xl font-bold">Connection problem</h2>
        <p className="text-sm text-white/50">{errMsg}</p>
        <button className="btn-gold" onClick={() => location.reload()}>Retry</button>
      </div>
    );
  }

  if (stage === "consent") {
    return (
      <div className="mx-auto max-w-2xl space-y-6 py-10 animate-fade-up">
        <div className="text-center">
          <h1 className="text-3xl font-black">Before you enter the arena</h1>
          <p className="mt-2 text-white/50">Every competitor is a verified live human. Here is exactly what happens.</p>
        </div>
        <div className="panel space-y-4 p-6">
          <h3 className="font-bold text-gold-400">Privacy notice</h3>
          <ul className="space-y-2 text-sm text-white/70">
            <li>• Your camera feed is processed <span className="text-white">locally on this device</span>. Face images and video are never uploaded or stored.</li>
            <li>• We keep only non-identifying data: score components, quality metrics, model version and a one-way capture signature (for duplicate/replay detection).</li>
            <li>• Scans expire after 60 minutes for ranked play — re-verification keeps matchmaking fair.</li>
            <li>• You can leave any queue at any time. Blocking a player removes them from your matchmaking pool.</li>
          </ul>
          <h3 className="pt-2 font-bold text-gold-400">Standardized capture instructions</h3>
          <ul className="space-y-1 text-sm text-white/70">
            <li>• Even, frontal light on your face — avoid strong backlight.</li>
            <li>• Camera at eye level, face fills the ring, look into the lens.</li>
            <li>• Remove hats / sunglasses; hair off the brow line helps accuracy.</li>
            <li>• Hold the device steady (a prop is even better).</li>
          </ul>
        </div>
        <div className="flex justify-center">
          <button className="btn-gold px-8" onClick={onConsent}>
            I understand — enable camera
          </button>
        </div>
      </div>
    );
  }

  if (stage === "camera" || stage === "scan") {
    return (
      <div className="mx-auto max-w-3xl space-y-4 py-8 animate-fade-up">
        <div className="text-center">
          <h1 className="text-2xl font-black">Face Verification</h1>
          <p className="text-sm text-white/50">Liveness challenges → neutral capture → certified PSL score.</p>
        </div>
        <ScanWizard onVerified={onVerified} externalStream={streamRef.current} />
      </div>
    );
  }

  if (stage === "ready") {
    return (
      <div className="space-y-6 py-8 animate-fade-up">
        {/* score card — certified scan rater report, or uncertified notice */}
        {scan ? (
        <div className="space-y-4">
          <PslReport
            score={scan.psl}
            confidence={scan.confidence}
            version={scan.version}
            groups={groupsFromComponents(scan.components)}
          />
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="green">liveness verified</Badge>
              <Badge tone="neutral">
                expires in {Math.floor(scanValidLeft / 60000)}:{String(Math.floor((scanValidLeft % 60000) / 1000)).padStart(2, "0")}
              </Badge>
              <Badge tone="neutral">{scan.components && Object.keys(scan.components).length} pinned components</Badge>
            </div>
            <button className="btn-ghost !px-3 !py-2 text-xs" onClick={() => setStage("scan")}>Rescan</button>
          </div>
        </div>
        ) : (
        <div className="panel relative overflow-hidden p-6">
          <div className="bg-grid absolute inset-0 opacity-40" />
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="label-tech">Verification · temporarily optional</div>
              <h2 className="mt-1 text-xl font-bold">Jump straight into the arena</h2>
              <p className="mt-1 max-w-xl text-sm text-white/50">
                The mandatory face-verification scan is switched off for testing. Every match still scores your live
                capture with the same pinned pipeline. Run the verification scan anytime to certify your profile PSL.
              </p>
            </div>
            <button
              className="btn-gold"
              onClick={async () => {
                await ensureCamera();
                setStage("scan");
              }}
            >
              Run verification scan
            </button>
          </div>
        </div>
        )}

        {/* mode select */}
        <div>
          <h2 className="mb-3 text-lg font-bold">Choose your battle</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                className="panel panel-hover p-5 text-left"
                onClick={() => (m.id === "friend" ? setStage("friend_wait") : joinQueue(m.id))}
              >
                <div className={`font-bold ${m.tone}`}>{m.title}</div>
                <div className="mt-1 text-sm text-white/50">{m.desc}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (stage === "friend_wait") {
    return (
      <div className="mx-auto max-w-lg space-y-6 py-12 animate-fade-up">
        <div className="panel space-y-4 p-6 text-center">
          <h2 className="text-xl font-bold">Friend Challenge</h2>
          <button className="btn-gold" onClick={createFriend}>
            {friendCode ? "Regenerate my code" : "Create challenge code"}
          </button>
          {friendCode && (
            <div className="space-y-2">
              <div className="font-mono text-4xl font-black tracking-[0.3em] text-gradient-gold">{friendCode}</div>
              <p className="text-xs text-white/40">Share this code — the match starts the moment they enter it. Waiting…</p>
            </div>
          )}
          <div className="flex items-center gap-3 py-2 text-xs text-white/30">
            <div className="h-px flex-1 bg-white/10" /> OR <div className="h-px flex-1 bg-white/10" />
          </div>
          <div className="flex gap-2">
            <input
              className="input-dark font-mono tracking-widest"
              placeholder="6-digit code"
              value={friendInput}
              maxLength={6}
              onChange={(e) => setFriendInput(e.target.value.replace(/\D/g, ""))}
            />
            <button className="btn-ghost" disabled={friendInput.length !== 6} onClick={joinFriend}>
              Join
            </button>
          </div>
          <button className="text-xs text-white/40 underline-offset-2 hover:underline" onClick={() => setStage("ready")}>
            ← back
          </button>
        </div>
      </div>
    );
  }

  if (stage === "queue") {
    const sizes = queueInfo?.sizes;
    return (
      <div className="mx-auto max-w-md space-y-6 py-16 text-center animate-fade-up">
        {notice && (
          <div className="panel border-arena-red/40 bg-arena-red/10 p-3 text-sm text-arena-red">{notice}</div>
        )}
        <div className="relative mx-auto h-24 w-24">
          <div className="absolute inset-0 animate-spin rounded-full border-2 border-white/10 border-t-gold-500" style={{ animationDuration: "1.6s" }} />
          <div className="absolute inset-3 animate-spin rounded-full border-2 border-white/10 border-b-gold-500/60" style={{ animationDuration: "2.4s" }} />
        </div>
        <div>
          <h2 className="text-xl font-bold">Searching for opponents…</h2>
          <p className="mt-1 text-sm text-white/50">
            {queueMode === "duo"
              ? "Auto-teaming you with a random partner, then matching another duo."
              : "Random matchmaking · longest wait matched first · rematch cooldowns enforced."}
          </p>
          {queueInfo && (
            <p className="mt-2 font-mono text-xs text-white/40">
              position {queueInfo.position} · {queueInfo.size} in queue · waiting {queueWait}s
            </p>
          )}
          {sizes && (
            <div className="mt-3 flex justify-center gap-4 font-mono text-[11px] text-white/40">
              <span>ranked <b className="text-gold-400">{sizes.ranked ?? 0}</b></span>
              <span>casual <b className="text-arena-cyan">{sizes.casual ?? 0}</b></span>
              <span>duo <b className="text-arena-violet">{sizes.duo ?? 0}</b></span>
            </div>
          )}
        </div>
        <button className="btn-ghost" onClick={leaveQueue}>Leave queue</button>
      </div>
    );
  }

  if (stage === "match" && match && me) {
    return (
      <BattleRoom
        socket={socketRef.current!}
        match={match}
        myId={me.id}
        stream={(streamRef.current ?? emptyStream)!}
        onExit={() => {
          setMatch(null);
          setStage("ready");
        }}
      />
    );
  }

  return (
    <div className="grid min-h-[50vh] place-items-center">
      <Spinner />
    </div>
  );
}
