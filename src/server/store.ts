/**
 * Storage layer.
 *
 * Two interchangeable implementations behind one interface:
 *  - PgStore   → real PostgreSQL (set DATABASE_URL; schema in db/schema.sql)
 *  - MemStore  → embedded, JSON-persisted store used when no DATABASE_URL is
 *                configured (single-node dev / demo deployments).
 *
 * The app never invents precision either way: all scoring data is written
 * exactly as attested by the scan pipeline.
 */
import { promises as fs, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PgStore } from "./pgStore";

export interface Player {
  id: string;
  handle: string;
  region: string;
  createdAt: string;
  psl: number | null;
  pslConfidence: number | null;
  scanVersion: string | null;
  elo: number;
  peakElo: number;
  wins: number;
  losses: number;
  streak: number;
  bestStreak: number;
  casualWins: number;
  casualLosses: number;
  reportsReceived: number;
  flagged: boolean;
}

export interface ScanRow {
  id: string;
  playerId: string;
  version: string;
  psl: number;
  confidence: number;
  quality: Record<string, number>;
  components: Record<string, number>;
  digest: string;
  challengeLog: unknown;
  ip: string | null;
  createdAt: string;
}

export interface LeaderboardRow {
  rank: number;
  id: string;
  handle: string;
  region: string;
  elo: number;
  peakElo: number;
  psl: number | null;
  wins: number;
  losses: number;
  streak: number;
}

export interface WeeklyRow {
  rank: number;
  id: string;
  handle: string;
  region: string;
  delta: number;
  matches: number;
  elo: number;
  psl: number | null;
}

export interface MatchRow {
  id: string;
  mode: string;
  createdAt: string;
  finishedAt: string | null;
  status: string;
  winnerSide: number | null;
  suspicious: boolean;
  players: Array<{
    playerId: string;
    handle: string;
    side: number;
    score: number | null;
    eloBefore: number | null;
    eloAfter: number | null;
    result: string;
  }>;
}

export interface Store {
  kind: "postgres" | "memory";
  createPlayer(handle: string, region: string): Promise<Player>;
  getPlayer(id: string): Promise<Player | null>;
  updatePlayer(id: string, patch: Partial<Player>): Promise<Player | null>;
  createSession(token: string, playerId: string, ip: string | null, ua: string | null): Promise<void>;
  getSession(token: string): Promise<{ token: string; playerId: string } | null>;
  touchSession(token: string): Promise<void>;

  createScan(row: ScanRow): Promise<void>;
  latestScan(playerId: string): Promise<ScanRow | null>;
  countScansSince(playerId: string, sinceIso: string): Promise<number>;
  countScansByDigest(digest: string, excludePlayerId?: string): Promise<number>;

  createMatch(id: string, mode: string): Promise<void>;
  addMatchPlayer(matchId: string, playerId: string, side: number): Promise<void>;
  setMatchScore(matchId: string, playerId: string, score: number, suspicious: boolean): Promise<void>;
  finishMatch(
    matchId: string,
    winnerSide: number | null,
    status: "done" | "aborted",
    suspicious: boolean,
    outcomes: Array<{ playerId: string; result: string; eloBefore: number; eloAfter: number }>,
    rated: boolean
  ): Promise<void>;
  ratingHistory(playerId: string, limit: number): Promise<Array<{ elo: number; delta: number; at: string; matchId: string | null }>>;
  matchHistory(playerId: string, limit: number): Promise<MatchRow[]>;
  countMatchesBetween(a: string, b: string, sinceIso: string): Promise<number>;

  leaderboard(kind: "global" | "region", region?: string, limit?: number): Promise<LeaderboardRow[]>;
  weeklyLeaderboard(sinceIso: string, limit?: number): Promise<WeeklyRow[]>;
  rankOf(elo: number): Promise<number>;

  addReport(reporterId: string, targetId: string, matchId: string | null, reason: string): Promise<void>;
  countReportsAgainst(targetId: string): Promise<number>;
  addBlock(playerId: string, blockedId: string): Promise<void>;
  blockedBy(playerId: string): Promise<string[]>;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Embedded (memory + JSON persistence) implementation                      */
/* ──────────────────────────────────────────────────────────────────────── */

interface MemSession {
  token: string;
  playerId: string;
  createdAt: string;
}

interface MemMatchPlayer {
  playerId: string;
  side: number;
  score: number | null;
  eloBefore: number | null;
  eloAfter: number | null;
  result: string;
  suspicious: boolean;
}

interface MemMatch {
  id: string;
  mode: string;
  status: string;
  winnerSide: number | null;
  suspicious: boolean;
  createdAt: string;
  finishedAt: string | null;
  players: MemMatchPlayer[];
}

interface MemRating {
  playerId: string;
  elo: number;
  delta: number;
  matchId: string | null;
  at: string;
}

interface MemReport {
  reporterId: string;
  targetId: string;
  matchId: string | null;
  reason: string;
  at: string;
}

interface Snapshot {
  players: Record<string, Player>;
  sessions: Record<string, MemSession>;
  scans: ScanRow[];
  matches: Record<string, MemMatch>;
  ratings: MemRating[];
  reports: MemReport[];
  blocks: Record<string, string[]>;
}

const emptySnapshot = (): Snapshot => ({
  players: {},
  sessions: {},
  scans: [],
  matches: {},
  ratings: [],
  reports: [],
  blocks: {},
});

class MemStore implements Store {
  kind = "memory" as const;
  private snap: Snapshot = emptySnapshot();
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "db.json");
    mkdirSync(dataDir, { recursive: true });
    try {
      const raw = readFileSync(this.file, "utf8");
      this.snap = { ...emptySnapshot(), ...JSON.parse(raw) };
    } catch {
      /* first boot */
    }
  }

  private persist() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      try {
        await fs.writeFile(this.file + ".tmp", JSON.stringify(this.snap));
        await fs.rename(this.file + ".tmp", this.file);
      } catch {
        /* best effort */
      }
    }, 400);
  }

  async createPlayer(handle: string, region: string): Promise<Player> {
    const p: Player = {
      id: crypto.randomUUID(),
      handle,
      region,
      createdAt: new Date().toISOString(),
      psl: null,
      pslConfidence: null,
      scanVersion: null,
      elo: 1000,
      peakElo: 1000,
      wins: 0,
      losses: 0,
      streak: 0,
      bestStreak: 0,
      casualWins: 0,
      casualLosses: 0,
      reportsReceived: 0,
      flagged: false,
    };
    this.snap.players[p.id] = p;
    this.persist();
    return p;
  }

  async getPlayer(id: string) {
    return this.snap.players[id] ?? null;
  }

  async updatePlayer(id: string, patch: Partial<Player>) {
    const p = this.snap.players[id];
    if (!p) return null;
    Object.assign(p, patch);
    this.persist();
    return p;
  }

  async createSession(token: string, playerId: string) {
    this.snap.sessions[token] = { token, playerId, createdAt: new Date().toISOString() };
    this.persist();
  }

  async getSession(token: string) {
    const s = this.snap.sessions[token];
    return s ? { token: s.token, playerId: s.playerId } : null;
  }

  async touchSession(_token: string) {
    /* noop in memory store */
  }

  async createScan(row: ScanRow) {
    this.snap.scans.push(row);
    if (this.snap.scans.length > 5000) this.snap.scans.splice(0, this.snap.scans.length - 5000);
    this.persist();
  }

  async latestScan(playerId: string) {
    for (let i = this.snap.scans.length - 1; i >= 0; i--) {
      if (this.snap.scans[i].playerId === playerId) return this.snap.scans[i];
    }
    return null;
  }

  async countScansSince(playerId: string, sinceIso: string) {
    const t = Date.parse(sinceIso);
    return this.snap.scans.filter((s) => s.playerId === playerId && Date.parse(s.createdAt) >= t).length;
  }

  async countScansByDigest(digest: string, excludePlayerId?: string) {
    return this.snap.scans.filter((s) => s.digest === digest && s.playerId !== excludePlayerId).length;
  }

  async createMatch(id: string, mode: string) {
    this.snap.matches[id] = {
      id,
      mode,
      status: "live",
      winnerSide: null,
      suspicious: false,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      players: [],
    };
    this.persist();
  }

  async addMatchPlayer(matchId: string, playerId: string, side: number) {
    const m = this.snap.matches[matchId];
    if (m) m.players.push({ playerId, side, score: null, eloBefore: null, eloAfter: null, result: "pending", suspicious: false });
    this.persist();
  }

  async setMatchScore(matchId: string, playerId: string, score: number, suspicious: boolean) {
    const mp = this.snap.matches[matchId]?.players.find((p) => p.playerId === playerId);
    if (mp) {
      mp.score = score;
      mp.suspicious = suspicious;
    }
    this.persist();
  }

  async finishMatch(
    matchId: string,
    winnerSide: number | null,
    status: "done" | "aborted",
    suspicious: boolean,
    outcomes: Array<{ playerId: string; result: string; eloBefore: number; eloAfter: number }>,
    rated: boolean
  ) {
    const m = this.snap.matches[matchId];
    if (!m) return;
    m.status = status;
    m.winnerSide = winnerSide;
    m.suspicious = suspicious;
    m.finishedAt = new Date().toISOString();
    for (const o of outcomes) {
      const mp = m.players.find((p) => p.playerId === o.playerId);
      if (mp) {
        mp.result = o.result;
        mp.eloBefore = o.eloBefore;
        mp.eloAfter = o.eloAfter;
      }
      const player = this.snap.players[o.playerId];
      if (player && rated) {
        player.elo = o.eloAfter;
        player.peakElo = Math.max(player.peakElo, o.eloAfter);
        if (o.result === "win") {
          player.wins++;
          player.streak = Math.max(0, player.streak) + 1;
          player.bestStreak = Math.max(player.bestStreak, player.streak);
        } else if (o.result === "loss") {
          player.losses++;
          player.streak = Math.min(0, player.streak) - 1;
        }
        this.snap.ratings.push({ playerId: o.playerId, elo: o.eloAfter, delta: o.eloAfter - o.eloBefore, matchId, at: m.finishedAt });
      }
    }
    this.persist();
  }

  async ratingHistory(playerId: string, limit: number) {
    return this.snap.ratings
      .filter((r) => r.playerId === playerId)
      .slice(-limit)
      .reverse()
      .map((r) => ({ elo: r.elo, delta: r.delta, at: r.at, matchId: r.matchId }));
  }

  async matchHistory(playerId: string, limit: number) {
    const out: MatchRow[] = [];
    const all = Object.values(this.snap.matches).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const m of all) {
      if (m.players.some((p) => p.playerId === playerId)) {
        out.push({
          id: m.id,
          mode: m.mode,
          createdAt: m.createdAt,
          finishedAt: m.finishedAt,
          status: m.status,
          winnerSide: m.winnerSide,
          suspicious: m.suspicious,
          players: m.players.map((p) => ({
            playerId: p.playerId,
            handle: this.snap.players[p.playerId]?.handle ?? "???",
            side: p.side,
            score: p.score,
            eloBefore: p.eloBefore,
            eloAfter: p.eloAfter,
            result: p.result,
          })),
        });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async countMatchesBetween(a: string, b: string, sinceIso: string) {
    const t = Date.parse(sinceIso);
    return Object.values(this.snap.matches).filter(
      (m) =>
        Date.parse(m.createdAt) >= t &&
        m.players.some((p) => p.playerId === a) &&
        m.players.some((p) => p.playerId === b)
    ).length;
  }

  async leaderboard(kind: "global" | "region", region?: string, limit = 50) {
    const rows = Object.values(this.snap.players)
      .filter((p) => (kind === "region" && region ? p.region === region : true))
      .filter((p) => p.wins + p.losses > 0 || p.psl !== null)
      .sort((a, b) => b.elo - a.elo || b.peakElo - a.peakElo)
      .slice(0, limit)
      .map((p, i) => ({
        rank: i + 1,
        id: p.id,
        handle: p.handle,
        region: p.region,
        elo: p.elo,
        peakElo: p.peakElo,
        psl: p.psl,
        wins: p.wins,
        losses: p.losses,
        streak: p.streak,
      }));
    return rows;
  }

  async weeklyLeaderboard(sinceIso: string, limit = 50) {
    const t = Date.parse(sinceIso);
    const agg = new Map<string, { delta: number; matches: Set<string> }>();
    for (const r of this.snap.ratings) {
      if (Date.parse(r.at) < t) continue;
      const cur = agg.get(r.playerId) ?? { delta: 0, matches: new Set<string>() };
      cur.delta += r.delta;
      if (r.matchId) cur.matches.add(r.matchId);
      agg.set(r.playerId, cur);
    }
    return Array.from(agg.entries())
      .map(([id, v]) => {
        const p = this.snap.players[id];
        return p
          ? { id, handle: p.handle, region: p.region, delta: v.delta, matches: v.matches.size, elo: p.elo, psl: p.psl }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, limit)
      .map((r, i) => ({ rank: i + 1, ...r }));
  }

  async rankOf(elo: number) {
    return 1 + Object.values(this.snap.players).filter((p) => p.elo > elo).length;
  }

  async addReport(reporterId: string, targetId: string, matchId: string | null, reason: string) {
    this.snap.reports.push({ reporterId, targetId, matchId, reason, at: new Date().toISOString() });
    const t = this.snap.players[targetId];
    if (t) t.reportsReceived++;
    this.persist();
  }

  async countReportsAgainst(targetId: string) {
    return this.snap.reports.filter((r) => r.targetId === targetId).length;
  }

  async addBlock(playerId: string, blockedId: string) {
    const list = new Set(this.snap.blocks[playerId] ?? []);
    list.add(blockedId);
    this.snap.blocks[playerId] = Array.from(list);
    this.persist();
  }

  async blockedBy(playerId: string) {
    return this.snap.blocks[playerId] ?? [];
  }
}

/* ──────────────────────────────────────────────────────────────────────── */

/**
 * The singleton lives on globalThis: Next.js bundles API routes into separate
 * chunks (each with its own copy of this module), but they all share one
 * process and therefore one globalThis slot.
 */
const G = globalThis as unknown as { __mogbattle_store?: Store };

export async function initStore(): Promise<Store> {
  if (G.__mogbattle_store) return G.__mogbattle_store;
  if (process.env.DATABASE_URL) {
    G.__mogbattle_store = await PgStore.connect(process.env.DATABASE_URL);
    // eslint-disable-next-line no-console
    console.log("[mogbattle] storage: PostgreSQL");
  } else {
    G.__mogbattle_store = new MemStore(path.join(process.cwd(), ".data"));
    // eslint-disable-next-line no-console
    console.log("[mogbattle] storage: embedded memory store (set DATABASE_URL for PostgreSQL)");
  }
  return G.__mogbattle_store;
}

export function getStore(): Store {
  if (!G.__mogbattle_store) throw new Error("store not initialized");
  return G.__mogbattle_store;
}
