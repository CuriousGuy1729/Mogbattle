/**
 * PostgreSQL implementation of the Store interface.
 * Schema lives in db/schema.sql (applied by docker-compose automatically).
 */
import { Pool } from "pg";
import crypto from "node:crypto";
import type { LeaderboardRow, MatchRow, Player, ScanRow, Store, WeeklyRow } from "./store";

const mapPlayer = (r: Record<string, unknown>): Player => ({
  id: r.id as string,
  handle: r.handle as string,
  region: r.region as string,
  createdAt: (r.created_at as Date).toISOString?.() ?? String(r.created_at),
  psl: r.psl == null ? null : Number(r.psl),
  pslConfidence: r.psl_confidence == null ? null : Number(r.psl_confidence),
  scanVersion: (r.scan_version as string | null) ?? null,
  elo: Number(r.elo),
  peakElo: Number(r.peak_elo),
  wins: Number(r.wins),
  losses: Number(r.losses),
  streak: Number(r.streak),
  bestStreak: Number(r.best_streak),
  casualWins: Number(r.casual_wins),
  casualLosses: Number(r.casual_losses),
  reportsReceived: Number(r.reports_received),
  flagged: Boolean(r.flagged),
});

export class PgStore implements Store {
  kind = "postgres" as const;

  private constructor(private pool: Pool) {}

  static async connect(url: string): Promise<PgStore> {
    const pool = new Pool({ connectionString: url, max: 10 });
    const store = new PgStore(pool);
    await store.ensureSchema();
    return store;
  }

  private async ensureSchema() {
    // Idempotent bootstrap so the app also works against an empty database.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, handle TEXT NOT NULL, region TEXT NOT NULL DEFAULT 'global',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        psl NUMERIC(4,2), psl_confidence NUMERIC(4,3), scan_version TEXT,
        elo INTEGER NOT NULL DEFAULT 1000, peak_elo INTEGER NOT NULL DEFAULT 1000,
        wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
        streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0,
        casual_wins INTEGER NOT NULL DEFAULT 0, casual_losses INTEGER NOT NULL DEFAULT 0,
        reports_received INTEGER NOT NULL DEFAULT 0, flagged BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        ip TEXT, user_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        version TEXT NOT NULL, psl NUMERIC(4,2) NOT NULL, confidence NUMERIC(4,3) NOT NULL,
        quality JSONB NOT NULL, components JSONB NOT NULL, digest TEXT NOT NULL,
        challenge_log JSONB NOT NULL, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'live',
        winner_side INTEGER, suspicious BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS match_players (
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        side INTEGER NOT NULL, score NUMERIC(4,2), elo_before INTEGER, elo_after INTEGER,
        result TEXT NOT NULL DEFAULT 'pending', suspicious BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (match_id, player_id)
      );
      CREATE TABLE IF NOT EXISTS ratings_history (
        id BIGSERIAL PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        elo INTEGER NOT NULL, delta INTEGER NOT NULL, match_id TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS reports (
        id BIGSERIAL PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        match_id TEXT, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS blocks (
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        blocked_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (player_id, blocked_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id);
      CREATE INDEX IF NOT EXISTS idx_scans_player ON scans(player_id);
      CREATE INDEX IF NOT EXISTS idx_scans_digest ON scans(digest);
      CREATE INDEX IF NOT EXISTS idx_mp_player ON match_players(player_id);
      CREATE INDEX IF NOT EXISTS idx_ratings_player ON ratings_history(player_id, at DESC);
    `);
  }

  async createPlayer(handle: string, region: string): Promise<Player> {
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO players (id, handle, region) VALUES ($1,$2,$3) RETURNING *`,
      [id, handle, region]
    );
    return mapPlayer(res.rows[0]);
  }

  async getPlayer(id: string): Promise<Player | null> {
    const res = await this.pool.query(`SELECT * FROM players WHERE id=$1`, [id]);
    return res.rows[0] ? mapPlayer(res.rows[0]) : null;
  }

  async updatePlayer(id: string, patch: Partial<Player>): Promise<Player | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const col: Record<string, string> = {
      handle: "handle", region: "region", psl: "psl", pslConfidence: "psl_confidence",
      scanVersion: "scan_version", elo: "elo", peakElo: "peak_elo", wins: "wins", losses: "losses",
      streak: "streak", bestStreak: "best_streak", casualWins: "casual_wins", casualLosses: "casual_losses",
      reportsReceived: "reports_received", flagged: "flagged",
    };
    for (const [k, v] of Object.entries(patch)) {
      const c = col[k];
      if (!c) continue;
      values.push(v);
      fields.push(`${c}=$${values.length}`);
    }
    if (!fields.length) return this.getPlayer(id);
    const res = await this.pool.query(
      `UPDATE players SET ${fields.join(", ")} WHERE id=$${values.length + 1} RETURNING *`,
      [...values, id]
    );
    return res.rows[0] ? mapPlayer(res.rows[0]) : null;
  }

  async createSession(token: string, playerId: string, ip: string | null, ua: string | null) {
    await this.pool.query(
      `INSERT INTO sessions (token, player_id, ip, user_agent) VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO NOTHING`,
      [token, playerId, ip, ua]
    );
  }

  async getSession(token: string) {
    const res = await this.pool.query(`SELECT token, player_id FROM sessions WHERE token=$1`, [token]);
    return res.rows[0] ? { token: res.rows[0].token, playerId: res.rows[0].player_id } : null;
  }

  async touchSession(token: string) {
    await this.pool.query(`UPDATE sessions SET last_seen=now() WHERE token=$1`, [token]);
  }

  async createScan(row: ScanRow) {
    await this.pool.query(
      `INSERT INTO scans (id, player_id, version, psl, confidence, quality, components, digest, challenge_log, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.id, row.playerId, row.version, row.psl, row.confidence, JSON.stringify(row.quality), JSON.stringify(row.components), row.digest, JSON.stringify(row.challengeLog), row.ip]
    );
  }

  async latestScan(playerId: string): Promise<ScanRow | null> {
    const res = await this.pool.query(
      `SELECT * FROM scans WHERE player_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [playerId]
    );
    return res.rows[0] ? this.mapScan(res.rows[0]) : null;
  }

  private mapScan(r: Record<string, unknown>): ScanRow {
    return {
      id: r.id as string,
      playerId: r.player_id as string,
      version: r.version as string,
      psl: Number(r.psl),
      confidence: Number(r.confidence),
      quality: (typeof r.quality === "string" ? JSON.parse(r.quality) : r.quality) as Record<string, number>,
      components: (typeof r.components === "string" ? JSON.parse(r.components) : r.components) as Record<string, number>,
      digest: r.digest as string,
      challengeLog: typeof r.challenge_log === "string" ? JSON.parse(r.challenge_log) : r.challenge_log,
      ip: (r.ip as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString?.() ?? String(r.created_at),
    };
  }

  async countScansSince(playerId: string, sinceIso: string) {
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM scans WHERE player_id=$1 AND created_at >= $2`,
      [playerId, sinceIso]
    );
    return res.rows[0].n as number;
  }

  async countScansByDigest(digest: string, excludePlayerId?: string) {
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM scans WHERE digest=$1 AND ($2::text IS NULL OR player_id <> $2)`,
      [digest, excludePlayerId ?? null]
    );
    return res.rows[0].n as number;
  }

  async createMatch(id: string, mode: string) {
    await this.pool.query(`INSERT INTO matches (id, mode) VALUES ($1,$2)`, [id, mode]);
  }

  async addMatchPlayer(matchId: string, playerId: string, side: number) {
    await this.pool.query(
      `INSERT INTO match_players (match_id, player_id, side) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [matchId, playerId, side]
    );
  }

  async setMatchScore(matchId: string, playerId: string, score: number, suspicious: boolean) {
    await this.pool.query(
      `UPDATE match_players SET score=$3, suspicious=$4 WHERE match_id=$1 AND player_id=$2`,
      [matchId, playerId, score, suspicious]
    );
  }

  async finishMatch(
    matchId: string,
    winnerSide: number | null,
    status: "done" | "aborted",
    suspicious: boolean,
    outcomes: Array<{ playerId: string; result: string; eloBefore: number; eloAfter: number }>,
    rated: boolean
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE matches SET status=$2, winner_side=$3, suspicious=$4, finished_at=now() WHERE id=$1`,
        [matchId, status, winnerSide, suspicious]
      );
      for (const o of outcomes) {
        await client.query(
          `UPDATE match_players SET result=$3, elo_before=$4, elo_after=$5 WHERE match_id=$1 AND player_id=$2`,
          [matchId, o.playerId, o.result, o.eloBefore, o.eloAfter]
        );
        if (rated) {
          await client.query(
            `UPDATE players SET
               elo=$2,
               peak_elo=GREATEST(peak_elo,$2),
               wins = wins + CASE WHEN $3='win' THEN 1 ELSE 0 END,
               losses = losses + CASE WHEN $3='loss' THEN 1 ELSE 0 END,
               streak = CASE WHEN $3='win' THEN GREATEST(streak,0)+1 WHEN $3='loss' THEN LEAST(streak,0)-1 ELSE streak END,
               best_streak = GREATEST(best_streak, CASE WHEN $3='win' THEN GREATEST(streak,0)+1 ELSE 0 END)
             WHERE id=$1`,
            [o.playerId, o.eloAfter, o.result]
          );
          await client.query(
            `INSERT INTO ratings_history (player_id, elo, delta, match_id) VALUES ($1,$2,$3,$4)`,
            [o.playerId, o.eloAfter, o.eloAfter - o.eloBefore, matchId]
          );
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async ratingHistory(playerId: string, limit: number) {
    const res = await this.pool.query(
      `SELECT elo, delta, at, match_id FROM ratings_history WHERE player_id=$1 ORDER BY at DESC, id DESC LIMIT $2`,
      [playerId, limit]
    );
    return res.rows.map((r) => ({
      elo: Number(r.elo),
      delta: Number(r.delta),
      at: r.at.toISOString?.() ?? String(r.at),
      matchId: r.match_id,
    }));
  }

  async matchHistory(playerId: string, limit: number): Promise<MatchRow[]> {
    const res = await this.pool.query(
      `SELECT m.id, m.mode, m.created_at, m.finished_at, m.status, m.winner_side, m.suspicious,
              mp.player_id, mp.side, mp.score, mp.elo_before, mp.elo_after, mp.result, p.handle
       FROM matches m
       JOIN match_players mp ON mp.match_id = m.id
       JOIN players p ON p.id = mp.player_id
       WHERE m.id IN (SELECT match_id FROM match_players WHERE player_id=$1)
       ORDER BY m.created_at DESC
       LIMIT $2`,
      [playerId, limit * 8]
    );
    const byMatch = new Map<string, MatchRow>();
    for (const r of res.rows) {
      let row = byMatch.get(r.id);
      if (!row) {
        row = {
          id: r.id,
          mode: r.mode,
          createdAt: r.created_at.toISOString?.() ?? String(r.created_at),
          finishedAt: r.finished_at ? r.finished_at.toISOString?.() ?? String(r.finished_at) : null,
          status: r.status,
          winnerSide: r.winner_side,
          suspicious: r.suspicious,
          players: [],
        };
        byMatch.set(r.id, row);
      }
      row.players.push({
        playerId: r.player_id,
        handle: r.handle,
        side: r.side,
        score: r.score == null ? null : Number(r.score),
        eloBefore: r.elo_before == null ? null : Number(r.elo_before),
        eloAfter: r.elo_after == null ? null : Number(r.elo_after),
        result: r.result,
      });
    }
    return Array.from(byMatch.values()).slice(0, limit);
  }

  async countMatchesBetween(a: string, b: string, sinceIso: string) {
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM matches m
       WHERE m.created_at >= $3
         AND EXISTS (SELECT 1 FROM match_players x WHERE x.match_id=m.id AND x.player_id=$1)
         AND EXISTS (SELECT 1 FROM match_players y WHERE y.match_id=m.id AND y.player_id=$2)`,
      [a, b, sinceIso]
    );
    return res.rows[0].n as number;
  }

  async leaderboard(kind: "global" | "region", region?: string, limit = 50): Promise<LeaderboardRow[]> {
    const where = kind === "region" && region ? `WHERE region=$2 AND (wins+losses>0 OR psl IS NOT NULL)` : `WHERE (wins+losses>0 OR psl IS NOT NULL)`;
    const params = kind === "region" && region ? [limit, region] : [limit];
    const res = await this.pool.query(
      `SELECT id, handle, region, elo, peak_elo, psl, wins, losses, streak FROM players ${where}
       ORDER BY elo DESC, peak_elo DESC LIMIT $1`,
      params
    );
    return res.rows.map((r, i) => ({
      rank: i + 1,
      id: r.id,
      handle: r.handle,
      region: r.region,
      elo: Number(r.elo),
      peakElo: Number(r.peak_elo),
      psl: r.psl == null ? null : Number(r.psl),
      wins: Number(r.wins),
      losses: Number(r.losses),
      streak: Number(r.streak),
    }));
  }

  async weeklyLeaderboard(sinceIso: string, limit = 50): Promise<WeeklyRow[]> {
    const res = await this.pool.query(
      `SELECT p.id, p.handle, p.region, p.elo, p.psl,
              SUM(r.delta)::int AS delta, COUNT(DISTINCT r.match_id)::int AS matches
       FROM ratings_history r JOIN players p ON p.id = r.player_id
       WHERE r.at >= $1
       GROUP BY p.id, p.handle, p.region, p.elo, p.psl
       ORDER BY delta DESC LIMIT $2`,
      [sinceIso, limit]
    );
    return res.rows.map((r, i) => ({
      rank: i + 1,
      id: r.id,
      handle: r.handle,
      region: r.region,
      delta: Number(r.delta),
      matches: Number(r.matches),
      elo: Number(r.elo),
      psl: r.psl == null ? null : Number(r.psl),
    }));
  }

  async rankOf(elo: number) {
    const res = await this.pool.query(`SELECT COUNT(*)::int AS n FROM players WHERE elo > $1`, [elo]);
    return 1 + (res.rows[0].n as number);
  }

  async addReport(reporterId: string, targetId: string, matchId: string | null, reason: string) {
    await this.pool.query(
      `INSERT INTO reports (reporter_id, target_id, match_id, reason) VALUES ($1,$2,$3,$4)`,
      [reporterId, targetId, matchId, reason]
    );
    await this.pool.query(`UPDATE players SET reports_received = reports_received + 1 WHERE id=$1`, [targetId]);
  }

  async countReportsAgainst(targetId: string) {
    const res = await this.pool.query(`SELECT COUNT(*)::int AS n FROM reports WHERE target_id=$1`, [targetId]);
    return res.rows[0].n as number;
  }

  async addBlock(playerId: string, blockedId: string) {
    await this.pool.query(
      `INSERT INTO blocks (player_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [playerId, blockedId]
    );
  }

  async blockedBy(playerId: string) {
    const res = await this.pool.query(`SELECT blocked_id FROM blocks WHERE player_id=$1`, [playerId]);
    return res.rows.map((r) => r.blocked_id as string);
  }
}
