/**
 * WebSocket hub: authentication, clock-sync pings, signaling relay,
 * queue commands and battle score submission.
 */
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getStore } from "./store";
import { getLimiter } from "./limiter";
import { matchmaker, Conn } from "./matchmaker";
import type { ClientMsg } from "./protocol";
import type { BattleAttestation } from "@/lib/psl/types";

const byPlayer = new Map<string, Conn>();

export function setupWebSocketServer(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  matchmaker.start();

  wss.on("connection", (ws) => {
    const conn = new Conn(ws);

    ws.on("message", (raw) => {
      void handleMessage(conn, raw.toString());
    });

    ws.on("close", () => {
      void matchmaker.onDisconnect(conn);
      if (conn.playerId && byPlayer.get(conn.playerId) === conn) byPlayer.delete(conn.playerId);
    });

    ws.on("error", () => {
      /* noop */
    });
  });
}

async function handleMessage(conn: Conn, raw: string) {
  let msg: ClientMsg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  try {
    switch (msg.t) {
      case "hello": {
        const rl = await getLimiter().hit(`ws-hello:${conn.id}`, 60_000, 30);
        if (!rl.allowed) return;
        await hello(conn, msg.token);
        return;
      }
      case "ping": {
        conn.send({ t: "pong", c: msg.c, serverTime: Date.now() });
        return;
      }
      case "queue_join": {
        if (!conn.playerId) return conn.send({ t: "error", code: "unauthenticated", message: "hello first" });
        if (msg.mode === "friend" && msg.friendCode) return void (await matchmaker.joinFriend(conn, msg.friendCode));
        if (["ranked", "casual", "duo"].includes(msg.mode)) return void (await matchmaker.joinQueue(conn, msg.mode));
        return;
      }
      case "queue_leave": {
        matchmaker.dequeue(conn);
        return;
      }
      case "friend_create": {
        if (!conn.playerId) return conn.send({ t: "error", code: "unauthenticated", message: "hello first" });
        matchmaker.createFriendCode(conn);
        return;
      }
      case "rtc_signal": {
        const room = conn.room;
        if (!room) return;
        const target = room.conns.find((c) => c.playerId === msg.to);
        if (target) target.send({ t: "rtc_signal", from: conn.playerId ?? "", data: msg.data });
        return;
      }
      case "battle_ready": {
        return;
      }
      case "battle_score": {
        if (!conn.playerId || !conn.room) return;
        const rl = await getLimiter().hit(`score:${conn.playerId}`, 60_000, 4);
        if (!rl.allowed) return;
        await matchmaker.submitScore(conn, msg.attestation as BattleAttestation);
        return;
      }
      case "bye": {
        conn.ws.close();
        return;
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[ws] handler error", err);
  }
}

async function hello(conn: Conn, token: string) {
  const store = getStore();
  const session = await store.getSession(token);
  if (!session) {
    conn.send({ t: "error", code: "bad_token", message: "Session expired — refresh to continue." });
    return;
  }
  const player = await store.getPlayer(session.playerId);
  if (!player) return;

  // One live connection per player: takeover semantics.
  const prev = byPlayer.get(player.id);
  if (prev && prev !== conn) {
    try {
      prev.ws.close(4000, "replaced by new connection");
    } catch {
      /* noop */
    }
  }
  byPlayer.set(player.id, conn);
  conn.playerId = player.id;
  conn.player = player;
  conn.blockedSet = new Set(await store.blockedBy(player.id));
  void store.touchSession(token);

  // Try to resume an in-progress battle (socket dropped, player back).
  const resumed = await matchmaker.rejoin(player.id, conn);

  const scan = await store.latestScan(player.id);
  const ttlMs = parseInt(process.env.SCAN_TTL_MINUTES || "60", 10) * 60_000;
  conn.send({
    t: "hello_ok",
    playerId: player.id,
    handle: player.handle,
    region: player.region,
    elo: player.elo,
    wins: player.wins,
    losses: player.losses,
    streak: player.streak,
    serverTime: Date.now(),
    scan: scan
      ? {
          psl: scan.psl,
          confidence: scan.confidence,
          version: scan.version,
          ageMs: Date.now() - Date.parse(scan.createdAt),
          validForRankedMs: Math.max(0, ttlMs - (Date.now() - Date.parse(scan.createdAt))),
        }
      : null,
  });
  void resumed;
}
