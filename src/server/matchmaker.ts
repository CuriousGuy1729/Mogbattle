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
const rematchCooldownMs = () => (parseInt(process.env.REMATCH_COOLDOWN_MINUTES || "30", 10) || 30) * 60_000;
const maxDailyPair = () => parseInt(process.env.MAX_DAILY_PAIR_MATCHES || "3", 10) || 3;

export class Conn {
  id = crypto.randomUUID();
  playerId: string | null = null;
  player: Player | null = null;
  blockedSet = new Set<string>();
  room: Room | null = null;
  queuedMode: BattleMode | null = null;
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

  private async tick() {
    try {
      await this.tryMatch1v1("ranked");
      await this.tryMatch1v1("casual");
      await this.tryMatchDuo();
      // prune stale friend codes
      const now = Date.now();
      for (const [code, e] of this.friendCodes) {
        if (now - e.created > 10 * 60_000 || e.conn.ws.readyState !== e.conn.ws.OPEN) this.friendCodes.delete(code);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[matchmaker] tick error", err);
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

  private async tryMatch1v1(mode: BattleMode) {
    const q = this.queueFor(mode).filter((c) => c.ws.readyState === c.ws.OPEN && !c.room);
    if (q.length < 2) return;
    const shuffled = this.shuffle(q);
    for (let i = 0; i < shuffled.length; i++) {
      const a = shuffled[i];
      if (a.room || !this.queueFor(mode).includes(a)) continue;
      for (let j = i + 1; j < shuffled.length; j++) {
        const b = shuffled[j];
        if (b.room || !this.queueFor(mode).includes(b)) continue;
        if (await this.pairBlocked(a, b)) continue;
        this.dequeue(a, false);
        this.dequeue(b, false);
        await this.startRoom(mode, [a, b]);
        break;
      }
    }
  }

  private async tryMatchDuo() {
    const q = this.queueFor("duo").filter((c) => c.ws.readyState === c.ws.OPEN && !c.room);
    if (q.length < 4) return;
    const shuffled = this.shuffle(q);

    // 1) form two solo-players-into-a-team pairs
    const teams: Conn[][] = [];
    const used = new Set<Conn>();
    for (let i = 0; i < shuffled.length && teams.length < 2; i++) {
      const a = shuffled[i];
      if (used.has(a)) continue;
      for (let j = i + 1; j < shuffled.length; j++) {
        const b = shuffled[j];
        if (used.has(b)) continue;
        if (a.blockedSet.has(b.playerId ?? "") || b.blockedSet.has(a.playerId ?? "")) continue;
        teams.push([a, b]);
        used.add(a);
        used.add(b);
        break;
      }
    }
    if (teams.length < 2) return;

    // 2) every cross-pairing must pass cooldown / daily-cap / block checks
    for (const x of teams[0]) {
      for (const y of teams[1]) {
        if (await this.pairBlocked(x, y)) return;
      }
    }
    for (const c of [...teams[0], ...teams[1]]) this.dequeue(c, false);
    await this.startRoom("duo", [...teams[0], ...teams[1]]);
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
    for (const [mode, q] of this.queues) {
      const live = q.filter((c) => c.ws.readyState === c.ws.OPEN);
      live.forEach((c, i) => c.send({ t: "queue_state", mode, position: i + 1, size: live.length }));
    }
  }
}

export const matchmaker = new Matchmaker();
