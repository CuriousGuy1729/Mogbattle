"use client";
import type { ClientMsg, ServerMsg } from "@/server/protocol";

type Handler = (msg: never) => void;

/**
 * Game socket with smoothed server-clock sync.
 * All battle timing uses `now()` (server time), never the local clock.
 */
export class GameSocket {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<(msg: never) => void>>();
  private offsetMs = 0;
  private pingTimer: number | null = null;
  private closedByUser = false;
  onStatus: (s: "connecting" | "open" | "closed") => void = () => {};

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  now(): number {
    return Date.now() + this.offsetMs;
  }

  connect(token: string): Promise<void> {
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      // Same-origin by default. For split deployments (e.g. frontend on Vercel)
      // set NEXT_PUBLIC_WS_URL to the realtime hub's origin.
      const external = process.env.NEXT_PUBLIC_WS_URL;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const url = external ? `${external.replace(/\/$/, "")}/ws` : `${proto}://${location.host}/ws`;
      const ws = new WebSocket(url);
      this.ws = ws;
      this.onStatus("connecting");
      let settled = false;

      ws.onopen = () => {
        this.send({ t: "hello", token });
        this.startPing();
      };
      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === "pong") {
          const rtt = Date.now() - msg.c;
          const est = msg.serverTime + rtt / 2 - Date.now();
          this.offsetMs = this.offsetMs === 0 ? est : this.offsetMs * 0.7 + est * 0.3;
          return;
        }
        if (msg.t === "hello_ok" && !settled) {
          settled = true;
          this.onStatus("open");
          resolve();
        }
        if (msg.t === "error" && msg.code === "bad_token" && !settled) {
          settled = true;
          reject(new Error(msg.message));
          return;
        }
        const set = this.handlers.get(msg.t);
        if (set) for (const h of set) (h as (m: ServerMsg) => void)(msg);
      };
      ws.onclose = () => {
        this.onStatus("closed");
        this.stopPing();
        if (!settled) {
          settled = true;
          reject(new Error("connection closed"));
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("connection failed"));
        }
      };
    });
  }

  on<T extends ServerMsg["t"]>(type: T, fn: (msg: Extract<ServerMsg, { t: T }>) => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn as Handler);
    return () => this.handlers.get(type)?.delete(fn as Handler);
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private startPing() {
    this.stopPing();
    this.send({ t: "ping", c: Date.now() });
    this.pingTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.send({ t: "ping", c: Date.now() });
    }, 2500);
  }

  private stopPing() {
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  close() {
    this.closedByUser = true;
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }
}
