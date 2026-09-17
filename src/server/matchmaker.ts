/**
 * Matchmaking + battle rooms.
 *
 * Guarantees enforced here:
 *  - only scan-verified players may queue (every mode — trust first)
 *  - randomized pairing; no immediate rematches (pair cooldown)
 *  - hard daily cap per opponent pair (anti Elo-farming)
 *  - mutual blocks always prevent a pairing
 *  - one active queue slot / room per player
 */
import crypto from "node:crypto";
import type { WebSocket } from "ws";
import { getStore, type Player } from "./store";
import { getLimiter } from "./limiter";
import { computeEloOutcomes } from "./elo";
import { suspicionFlags, validateAttestation } from "./attest";
import { TIMING, type BattleMode, type PublicPlayer, type ServerMsg } from "./protocol";
import type { BattleAttestation } from "@/lib/psl/types";

export const scanTtlMs = () => (parseInt(process.env.SCAN_TTL_MINUTES || "60", 10) || 60) * 60_000;

/**
 * Verification gate. Currently OPTIONAL ("for now") so players can test
 * matchmaking/battles immediately; battle captures are still scored by the
 * same pinned pipeline. Flip to "true" to require a certified scan again.
 */
export const requireVerifiedScan = () =>
  (process.env.REQUIRE_VERIFIED_SCAN ?? "false").trim().toLowerCase() === "true";
const rematchCooldownMs = () => (parseInt(process.env.REMATCH_COOLDOWN_MINUTES || "30", 10) || 30) * 60_000;
const maxDailyPair = () => parseInt(process.env.MAX_DAILY_PAIR_MATCHES || "3", 10) || 3;

export class Conn {
  id = crypto.randomUUID();
  playerId: string | null = null;
  player: Player | null = null;
  blockedSet = new Set<string>();
  room: Room | null = null;
  queuedMode: BattleMode | null = null;
  queuedAt = 0;
  friendCode: string | null = null;
  disconnectedAt: number | null = null;

  constructor(public ws: WebSocket) {}

  send(msg: ServerMsg) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

interface Submission {
  attestation: BattleAttestation;
  suspicious: boolean;
}

type RoomState = "vs" | "capture" | "done";

export class Room {
  id = crypto.randomUUID();
  state: RoomState = "vs";
  submissions = new Map<string, Submission>();
  sideOf = new Map<string, number>(); // connId -> side
  timers: NodeJS.Timeout[] = [];
  resolved = false;

  constructor(
    public mode: BattleMode,
    public conns: Conn[]
  ) {
    conns.forEach((c, i) => {
      const side = mode === "duo" ? (i < 2 ? 0 : 1) : i;
      this.sideOf.set(c.id, side);
      c.room = this;
    });
  }

  conn(playerId: string) {
    return this.conns.find((c) => c.playerId === playerId) ?? null;
  }

  sideConns(side: number) {
    return this.conns.filter((c) => this.sideOf.get(c.id) === side);
  }

  broadcast(msg: ServerMsg, exceptConnId?: string) {
    for (const c of this.conns) if (c.id !== exceptConnId) c.send(msg);
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

export class Matchmaker {
  queues = new Map<BattleMode, Conn[]>();
  rooms = new Map<string, Room>();
  friendCodes = new Map<string, { conn: Conn; created: number }>();
  private tickTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;

  start() {
    this.tickTimer = setInterval(() => void this.tick(), 600);
    this.stateTimer = setInterval(() => this.broadcastQueueStates(), 2000);
  }

  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.stateTimer) clearInterval(this.stateTimer);
  }

  queueFor(mode: BattleMode): Conn[] {
    if (!this.queues.has(mode)) this.queues.set(mode, []);
    return this.queues.get(mode)!;
  }

  dequeue(conn: Conn, notify = true) {
    if (conn.queuedMode) {
      const q = this.queueFor(conn.queuedMode);
      const i = q.indexOf(conn);
      if (i >= 0) q.splice(i, 1);
      conn.queuedMode = null;
      conn.queuedAt = 0;
      if (notify) conn.send({ t: "queue_left" });
    }
    if (conn.friendCode) {
      this.friendCodes.delete(conn.friendCode);
      conn.friendCode = null;
    }
  }

  async onDisconnect(conn: Conn) {
    this.dequeue(conn, false);
    const room = conn.room;
    if (room && room.conns.find((c) => c === conn)?.ws !== conn.ws) return; // socket already replaced by rejoin
    if (conn.room && !conn.room.resolved) {
      conn.disconnectedAt = Date.now();
      conn.room.broadcast({ t: "peer_state", id: conn.playerId ?? "", connected: false }, conn.id);
      const room = conn.room;
      const timer = setTimeout(() => {
        if (!room.resolved && !this.roomFullyConnected(room)) {
          void this.resolveRoom(room, "forfeit");
        }
      }, TIMING.FORFEIT_GRACE_MS);
      room.timers.push(timer);
    }
  }

  private roomFullyConnected(room: Room) {
    return room.conns.every((c) => c.ws.readyState === c.ws.OPEN);
  }

  async rejoin(playerId: string, conn: Conn): Promise<boolean> {
    for (const room of this.rooms.values()) {
      const member = room.conns.find((c) => c.playerId === playerId);
      if (member && !room.resolved) {
        // Swap the socket onto the existing membership.
        member.ws = conn.ws;
        member.disconnectedAt = null;
        conn.room = room;
        conn.playerId = playerId;
        room.broadcast({ t: "peer_state", id: playerId, connected: true }, member.id);
        void this.sendRoomState(member);
        return true;
      }
    }
    return false;
  }

  private async sendRoomState(conn: Conn) {
    const room = conn.room;
    if (!room) return;
    await this.sendMatchFound(room, [conn]);
    if (room.state === "capture" || room.state === "done") {
      const now = Date.now();
      conn.send({
        t: "battle_start",
        matchId: room.id,
        countdownAt: now - 1,
        captureStart: now - 1,
        captureEnd: now + TIMING.CAPTURE_MS,
        submitDeadline: now + TIMING.CAPTURE_MS + TIMING.SUBMIT_GRACE_MS,
      });
    }
  }

  /** Full eligibility check for joining any queue. */
  async canQueue(conn: Conn): Promise<{ ok: boolean; message?: string }> {
    const store = getStore();
    if (!conn.playerId) return { ok: false, message: "not signed in" };
    if (conn.room) return { ok: false, message: "already in a match" };
    if (!requireVerifiedScan()) return { ok: true }; // verification temporarily optional
    const scan = await store.latestScan(conn.playerId);
    if (!scan) return { ok: false, message: "A verified face scan is required before entering any queue." };
    const age = Date.now() - Date.parse(scan.createdAt);
    if (age > scanTtlMs())
      return { ok: false, message: "Your verification scan expired. Please rescan to keep matchmaking fair." };
    return { ok: true };
  }

  async joinQueue(conn: Conn, mode: BattleMode) {
    const check = await this.canQueue(conn);
    if (!check.ok) {
      conn.send({ t: "scan_required", message: check.message ?? "scan required" });
      return;
    }
    this.dequeue(conn, false);
    if (mode === "friend") return; // friend mode uses codes, not the queue
    conn.queuedMode = mode;
    conn.queuedAt = Date.now();
    this.queueFor(mode).push(conn);
    conn.send({ t: "queue_joined", mode, size: this.queueFor(mode).length });
  }

  createFriendCode(conn: Conn) {
    this.dequeue(conn, false);
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    this.friendCodes.set(code, { conn, created: Date.now() });
    conn.friendCode = code;
    conn.send({ t: "friend_code", code });
  }

  async joinFriend(conn: Conn, code: string) {
    const check = await this.canQueue(conn);
    if (!check.ok) {
      conn.send({ t: "scan_required", message: check.message ?? "scan required" });
      return;
    }
    const entry = this.friendCodes.get(code);
    if (!entry || Date.now() - entry.created > 10 * 60_000 || entry.conn.playerId === conn.playerId) {
      conn.send({ t: "error", code: "friend_code_invalid", message: "Friend code invalid or expired." });
      return;
    }
    const host = entry.conn;
    if (host.ws.readyState !== host.ws.OPEN) {
      conn.send({ t: "error", code: "friend_gone", message: "That player is no longer online." });
      return;
    }
    this.friendCodes.delete(code);
    host.friendCode = null;
    this.dequeue(host, false);
    await this.startRoom("friend", [host, conn]);
  }

  /* ── pairing eligibility between two players ─────────────────────────── */
  private async pairBlocked(a: Conn, b: Conn): Promise<boolean> {
    if (!a.playerId || !b.playerId || a.playerId === b.playerId) return true;
    if (a.blockedSet.has(b.playerId) || b.blockedSet.has(a.playerId)) return true;
    const limiter = getLimiter();
    const onCooldown = await limiter.hasPair(a.playerId, b.playerId);
    if (process.env.MB_DEBUG_PAIRS) // eslint-disable-next-line no-console
      console.log(`[pairs] ${a.playerId.slice(0, 6)}~${b.playerId.slice(0, 6)} cooldown=${onCooldown}`);
    if (onCooldown) return true; // rematch cooldown
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const n = await getStore().countMatchesBetween(a.playerId, b.playerId, today.toISOString());
    if (n >= maxDailyPair()) return true; // anti-farm daily cap
    return false;
  }

  private ticking = false;

  private async tick() {
    // Serialize ticks: pairing decisions span async boundaries, so two
    // overlapping ticks could double-book a player (the old "glitch").
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.matchAll1v1("ranked");
      await this.matchAll1v1("casual");
      await this.matchAllDuo();
      // prune stale friend codes
      const now = Date.now();
      for (const [code, e] of this.friendCodes) {
        if (now - e.created > 10 * 60_000 || e.conn.ws.readyState !== e.conn.ws.OPEN) this.friendCodes.delete(code);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[matchmaker] tick error", err);
    } finally {
      this.ticking = false;
    }
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Eligible queue snapshot: connected, still queued for this mode, no room. */
  private eligible(mode: BattleMode): Conn[] {
    return this.queueFor(mode)
      .filter((c) => c.ws.readyState === c.ws.OPEN && !c.room && c.queuedMode === mode)
      .sort((a, b) => a.queuedAt - b.queuedAt); // longest wait first (fairness)
  }

  /**
   * Batch-match 1v1 queues. Loops until no more pairs can be formed, so a
   * queue of 10 produces 5 matches in one tick. The anchor is always the
   * longest-waiting player; candidates are shuffled (random matchmaking).
   * Every state is re-validated after awaits — pairing spans async gaps.
   */
  private async matchAll1v1(mode: BattleMode) {
    const skipped = new Set<Conn>();
    for (;;) {
      const q = this.eligible(mode).filter((c) => !skipped.has(c));
      if (q.length < 2) return;
      const a = q[0];
      let matched = false;
      for (const b of this.shuffle(q.slice(1))) {
        if (b.room || b.queuedMode !== mode) continue;
        if (await this.pairBlocked(a, b)) continue;
        if (a.room || a.queuedMode !== mode || b.room || b.queuedMode !== mode) break; // re-check post-await
        this.dequeue(a, false);
        this.dequeue(b, false);
        await this.startRoom(mode, [a, b]);
        matched = true;
        break;
      }
      if (!matched) skipped.add(a); // a can't face anyone right now (cooldowns/blocks) — try next waiter
    }
  }

  /**
   * Batch-match Random Duo (solo join → random teammate → 2v2).
   * Forms as many teams as possible per pass (block-aware, longest wait
   * first), then matches team-vs-team — every cross-pair must pass the
   * anti-farm checks. Repeats until the queue can't produce another match,
   * so 8 queued players become two simultaneous 2v2 battles in one tick.
   */
  private async matchAllDuo() {
    for (;;) {
      const q = this.eligible("duo");
      if (q.length < 4) return;

      // greedy team formation
      const teams: Conn[][] = [];
      const used = new Set<Conn>();
      for (const a of q) {
        if (used.has(a) || a.room || a.queuedMode !== "duo") continue;
        for (const b of q) {
          if (b === a || used.has(b) || b.room || b.queuedMode !== "duo") continue;
          if (a.blockedSet.has(b.playerId ?? "") || b.blockedSet.has(a.playerId ?? "")) continue;
          teams.push([a, b]);
          used.add(a);
          used.add(b);
          break;
        }
      }
      if (teams.length < 2) return;

      // try to start one match this pass; outer loop will re-scan for more
      let started = false;
      for (let i = 0; i < teams.length && !started; i++) {
        for (let j = i + 1; j < teams.length && !started; j++) {
          const t1 = teams[i];
          const t2 = teams[j];
          let blocked = false;
          for (const x of t1) {
            for (const y of t2) {
              if (await this.pairBlocked(x, y)) {
                blocked = true;
                break;
              }
            }
            if (blocked) break;
          }
          if (blocked) continue;
          const stillValid = [...t1, ...t2].every((c) => !c.room && c.queuedMode === "duo" && c.ws.readyState === c.ws.OPEN);
          if (!stillValid) continue; // re-check post-await
          for (const c of [...t1, ...t2]) this.dequeue(c, false);
          await this.startRoom("duo", [...t1, ...t2]);
          started = true;
        }
      }
      if (!started) return; // every team pair is blocked/cooldown'd — wait for queue changes
    }
  }

  private async startRoom(mode: BattleMode, conns: Conn[]) {
    const store = getStore();
    const room = new Room(mode, conns);
    this.rooms.set(room.id, room);
    await store.createMatch(room.id, mode);
    for (const c of conns) {
      await store.addMatchPlayer(room.id, c.playerId!, this.room_side(room, c));
    }
    // Anti-farm: lock these pairs immediately (random queue only).
    if (mode !== "friend") {
      const limiter = getLimiter();
      for (let i = 0; i < conns.length; i++) {
        for (let j = i + 1; j < conns.length; j++) {
          const a = conns[i].playerId!;
          const b = conns[j].playerId!;
          if (this.room_side(room, conns[i]) !== this.room_side(room, conns[j])) {
            await limiter.setPair(a, b, rematchCooldownMs());
            void limiter.incDailyPair(a, b);
          }
        }
      }
    }
    await this.sendMatchFound(room, conns);
    const timer = setTimeout(() => void this.startBattle(room), TIMING.VS_MS);
    room.timers.push(timer);
  }

  private room_side(room: Room, c: Conn) {
    return room.sideOf.get(c.id) ?? 0;
  }

  private async sendMatchFound(room: Room, targets: Conn[]) {
    const store = getStore();
    const players: PublicPlayer[] = [];
    for (const c of room.conns) {
      const p = c.player ?? (c.playerId ? await store.getPlayer(c.playerId) : null);
      if (!p) continue;
      players.push({
        id: p.id,
        handle: p.handle,
        elo: p.elo,
        psl: p.psl,
        region: p.region,
        side: this.room_side(room, c),
      });
    }
    const now = Date.now();
    for (const c of targets) {
      c.send({
        t: "match_found",
        matchId: room.id,
        mode: room.mode,
        players: players.map((p) => ({ ...p, you: p.id === c.playerId })),
        vsUntil: now + TIMING.VS_MS,
        captureMs: TIMING.CAPTURE_MS,
        countdownMs: TIMING.COUNTDOWN_MS,
      });
    }
  }

  private startBattle(room: Room) {
    if (room.resolved) return;
    room.state = "capture";
    const now = Date.now();
    const msg = {
      t: "battle_start" as const,
      matchId: room.id,
      countdownAt: now + 200,
      captureStart: now + 200 + TIMING.COUNTDOWN_MS,
      captureEnd: now + 200 + TIMING.COUNTDOWN_MS + TIMING.CAPTURE_MS,
      submitDeadline: now + 200 + TIMING.COUNTDOWN_MS + TIMING.CAPTURE_MS + TIMING.SUBMIT_GRACE_MS,
    };
    room.broadcast(msg);
    const timer = setTimeout(() => void this.resolveRoom(room, "deadline"), TIMING.COUNTDOWN_MS + TIMING.CAPTURE_MS + TIMING.SUBMIT_GRACE_MS + 400);
    room.timers.push(timer);
  }

  async submitScore(conn: Conn, attestation: BattleAttestation): Promise<void> {
    const room = conn.room;
    if (!room || room.state !== "capture" || room.resolved) return;
    if (!conn.playerId || room.submissions.has(conn.playerId)) return;

    const v = validateAttestation(attestation);
    if (!v.ok) {
      conn.send({ t: "score_ack", accepted: false, reason: v.reason });
      return;
    }
    const store = getStore();
    const verified = conn.player?.psl ?? null;
    const flags = suspicionFlags(attestation, verified);

    // Replay / duplicate-input detection: same capture digest as ANY scan by
    // a different player means a replayed or shared input — reject it.
    const crossDigest = await store.countScansByDigest(attestation.digest, conn.playerId);
    if (crossDigest > 0) {
      conn.send({ t: "score_ack", accepted: false, reason: "duplicate capture signature detected" });
      store.updatePlayer(conn.playerId, { flagged: true }).catch(() => {});
      return;
    }
    for (const [pid, sub] of room.submissions) {
      if (pid !== conn.playerId && sub.attestation.digest === attestation.digest) {
        conn.send({ t: "score_ack", accepted: false, reason: "duplicate capture signature detected" });
        return;
      }
    }

    const suspicious = flags.length > 0;
    room.submissions.set(conn.playerId, { attestation, suspicious });
    await store.setMatchScore(room.id, conn.playerId, attestation.score, suspicious);
    conn.send({ t: "score_ack", accepted: true });

    const connected = room.conns.filter((c) => c.ws.readyState === c.ws.OPEN).length;
    if (room.submissions.size >= Math.max(1, connected) && room.submissions.size === room.conns.length) {
      const t = setTimeout(() => void this.resolveRoom(room, "deadline"), 900);
      room.timers.push(t);
    }
  }

  private async resolveRoom(room: Room, _why: "deadline" | "forfeit") {
    if (room.resolved) return;
    room.resolved = true;
    room.state = "done";
    room.clearTimers();

    const store = getStore();
    const sidesCount = room.mode === "duo" ? 2 : room.conns.length;
    const sideScores: Array<number | null> = [];
    const suspicious = [...room.submissions.values()].some((s) => s.suspicious);

    for (let s = 0; s < sidesCount; s++) {
      const members = room.conns.filter((c) => this.room_side(room, c) === s);
      const subs = members
        .map((m) => (m.playerId ? room.submissions.get(m.playerId) : undefined))
        .filter((x): x is Submission => !!x);
      sideScores[s] = subs.length ? Math.round((subs.reduce((acc, x) => acc + x.attestation.score, 0) / subs.length) * 100) / 100 : null;
    }

    const anyScore = sideScores.some((s) => s != null);
    const allScored = sideScores.every((s) => s != null);

    let status: "done" | "aborted" = anyScore ? "done" : "aborted";
    let winnerSide: number | null = null;

    if (anyScore) {
      if (allScored) {
        const [s0, s1] = [sideScores[0]!, sideScores[sideScores.length - 1]!];
        winnerSide = s0 === s1 ? null : s0 > s1 ? 0 : sideScores.length - 1;
      } else {
        winnerSide = sideScores.findIndex((s) => s != null);
        status = "done"; // forfeit win
      }
    }

    const rated = (room.mode === "ranked" || room.mode === "duo") && anyScore;

    // Per-player outcome numbers. Draws score 0.5 in Elo.
    const resultFor = (side: number): string => {
      if (!anyScore) return "pending";
      if (winnerSide == null) return "draw";
      return side === winnerSide ? "win" : "loss";
    };

    let eloByPlayer = new Map<string, { eloBefore: number; eloAfter: number }>();
    if (rated) {
      const eloSides = [];
      for (let s = 0; s < sidesCount; s++) {
        const members = room.conns.filter((c) => this.room_side(room, c) === s);
        const outcomeVal: 0 | 0.5 | 1 = winnerSide == null ? 0.5 : winnerSide === s ? 1 : 0;
        eloSides.push(
          members.map((c) => ({
            playerId: c.playerId!,
            elo: c.player?.elo ?? 1000,
            outcome: outcomeVal,
          }))
        );
      }
      for (const o of computeEloOutcomes(eloSides, suspicious)) {
        eloByPlayer.set(o.playerId, { eloBefore: o.eloBefore, eloAfter: o.eloAfter });
      }
    }

    const outcomes = room.conns.map((c) => {
      const side = this.room_side(room, c);
      const elo = eloByPlayer.get(c.playerId!) ?? { eloBefore: c.player?.elo ?? 1000, eloAfter: c.player?.elo ?? 1000 };
      return { playerId: c.playerId!, result: resultFor(side), eloBefore: elo.eloBefore, eloAfter: elo.eloAfter };
    });

    await store.finishMatch(room.id, winnerSide, status, suspicious, outcomes, rated);

    // casual modes: track casual W/L separately, never touch Elo.
    if (!rated && anyScore && (room.mode === "casual" || room.mode === "friend") && winnerSide != null) {
      for (const c of room.conns) {
        if (!c.player) continue;
        const side = this.room_side(room, c);
        const patch = side === winnerSide ? { casualWins: c.player.casualWins + 1 } : { casualLosses: c.player.casualLosses + 1 };
        await store.updatePlayer(c.player.id, patch);
      }
    }

    // Publish scores first (reveal tension), then the authoritative result.
    room.broadcast({
      t: "battle_scores",
      scores: room.conns.map((c) => ({
        playerId: c.playerId ?? "",
        score: c.playerId && room.submissions.has(c.playerId) ? room.submissions.get(c.playerId)!.attestation.score : null,
        submitted: !!(c.playerId && room.submissions.has(c.playerId)),
      })),
    });

    const rankedModes = room.mode === "ranked" || room.mode === "duo";
    for (const c of room.conns) {
      if (!c.playerId) continue;
      const mySide = this.room_side(room, c);
      const outcome = outcomes.find((o) => o.playerId === c.playerId);
      const eloInfo = rated && outcome ? { before: outcome.eloBefore, after: outcome.eloAfter, delta: outcome.eloAfter - outcome.eloBefore, applied: true } : null;
      let rankInfo: { before: number; after: number } | null = null;
      if (eloInfo && eloInfo.applied) {
        rankInfo = { before: await store.rankOf(eloInfo.before), after: await store.rankOf(eloInfo.after) };
      }
      const sidesPayload = Array.from({ length: sidesCount }, (_, s) => ({
        side: s,
        score: sideScores[s],
        players: room.conns
          .filter((x) => this.room_side(room, x) === s)
          .map((x) => ({
            id: x.playerId ?? "",
            handle: x.player?.handle ?? "???",
            score: x.playerId && room.submissions.has(x.playerId) ? room.submissions.get(x.playerId)!.attestation.score : null,
          })),
      }));
      const win = winnerSide == null ? null : winnerSide === mySide;
      c.send({
        t: "match_result",
        matchId: room.id,
        mode: room.mode,
        status: anyScore ? (allScored ? "done" : "forfeit") : "aborted",
        winnerSide,
        yourSide: mySide,
        suspicious,
        sides: sidesPayload,
        elo: eloInfo,
        rank: rankInfo,
        win,
      });
      // refresh cached player
      const fresh = await store.getPlayer(c.playerId);
      if (fresh) c.player = fresh;
    }

    void rankedModes;
    for (const c of room.conns) c.room = null;
    this.rooms.delete(room.id);
  }

  private broadcastQueueStates() {
    // defensive cleanup: drop dead sockets that missed their close event
    for (const [, q] of this.queues) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].ws.readyState !== q[i].ws.OPEN) {
          q[i].queuedMode = null;
          q.splice(i, 1);
        }
      }
    }
    const sizes: Partial<Record<BattleMode, number>> = {};
    for (const mode of ["ranked", "casual", "duo"] as BattleMode[]) sizes[mode] = this.eligible(mode).length;
    for (const [mode, q] of this.queues) {
      const live = q.filter((c) => c.ws.readyState === c.ws.OPEN && c.queuedMode === mode);
      live.forEach((c, i) => c.send({ t: "queue_state", mode, position: i + 1, size: live.length, sizes, queuedAt: c.queuedAt }));
    }
  }
}

export const matchmaker = new Matchmaker();
