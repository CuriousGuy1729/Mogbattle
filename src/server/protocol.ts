/**
 * Wire protocol shared by the server and the browser client.
 * All timestamps are epoch milliseconds on the SERVER clock; the client
 * maintains a smoothed offset via ping/pong.
 */
import type { BattleAttestation } from "@/lib/psl/types";

export type BattleMode = "ranked" | "casual" | "duo" | "friend";

export interface PublicPlayer {
  id: string;
  handle: string;
  elo: number;
  psl: number | null;
  region: string;
  side: number;
  you?: boolean;
}

/* ── client → server ─────────────────────────────────────────────────── */
export type ClientMsg =
  | { t: "hello"; token: string }
  | { t: "ping"; c: number }
  | { t: "queue_join"; mode: BattleMode; friendCode?: string }
  | { t: "queue_leave" }
  | { t: "friend_create" }
  | { t: "rtc_signal"; to: string; data: unknown }
  | { t: "battle_ready" }
  | { t: "battle_score"; attestation: BattleAttestation }
  | { t: "bye" };

/* ── server → client ─────────────────────────────────────────────────── */
export type ServerMsg =
  | {
      t: "hello_ok";
      playerId: string;
      handle: string;
      region: string;
      elo: number;
      wins: number;
      losses: number;
      streak: number;
      serverTime: number;
      scan: { psl: number; confidence: number; version: string; ageMs: number; validForRankedMs: number } | null;
    }
  | { t: "pong"; c: number; serverTime: number }
  | { t: "error"; code: string; message: string }
  | { t: "queue_joined"; mode: BattleMode; size: number }
  | {
      t: "queue_state";
      mode: BattleMode;
      position: number;
      size: number;
      sizes?: Partial<Record<BattleMode, number>>;
      queuedAt?: number;
    }
  | { t: "queue_left" }
  | { t: "friend_code"; code: string }
  | { t: "friend_waiting" }
  | {
      t: "match_found";
      matchId: string;
      mode: BattleMode;
      players: PublicPlayer[];
      vsUntil: number;
      captureMs: number;
      countdownMs: number;
    }
  | { t: "rtc_signal"; from: string; data: unknown }
  | { t: "peer_state"; id: string; connected: boolean }
  | {
      t: "battle_start";
      matchId: string;
      countdownAt: number;
      captureStart: number;
      captureEnd: number;
      submitDeadline: number;
    }
  | { t: "score_ack"; accepted: boolean; reason?: string }
  | { t: "battle_scores"; scores: Array<{ playerId: string; score: number | null; submitted: boolean }> }
  | {
      t: "match_result";
      matchId: string;
      mode: BattleMode;
      status: "done" | "aborted" | "forfeit";
      winnerSide: number | null;
      yourSide: number;
      suspicious: boolean;
      sides: Array<{
        side: number;
        score: number | null;
        players: Array<{ id: string; handle: string; score: number | null }>;
      }>;
      elo: { before: number; after: number; delta: number; applied: boolean } | null;
      rank: { before: number; after: number } | null;
      win: boolean | null;
    }
  | { t: "scan_required"; message: string };

/** Match pacing (ms, server clock). */
export const TIMING = {
  VS_MS: 5200,
  COUNTDOWN_MS: 4000,
  CAPTURE_MS: 6000,
  SUBMIT_GRACE_MS: 6000,
  FORFEIT_GRACE_MS: 20000,
};
