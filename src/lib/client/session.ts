"use client";

const TOKEN_KEY = "mb.token.v1";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string | null) {
  if (typeof window === "undefined") return;
  if (t) window.localStorage.setItem(TOKEN_KEY, t);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as Record<string, string>) };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data as { message?: string; error?: string })?.message || (data as { error?: string })?.error || `HTTP ${res.status}`);
    (err as Error & { status?: number; payload?: unknown }).status = res.status;
    (err as Error & { payload?: unknown }).payload = data;
    throw err;
  }
  return data as T;
}

export interface MyPlayer {
  id: string;
  handle: string;
  region: string;
  psl: number | null;
  pslConfidence: number | null;
  scanVersion: string | null;
  elo: number;
  peakElo: number;
  wins: number;
  losses: number;
  winRate: number | null;
  streak: number;
  bestStreak: number;
  casualWins: number;
  casualLosses: number;
  createdAt: string;
}

export async function ensureSession(): Promise<{ token: string; player: MyPlayer }> {
  const token = getToken();
  if (token) {
    try {
      const me = await api<{ player: MyPlayer }>("/api/session");
      return { token, player: me.player };
    } catch {
      setToken(null);
    }
  }
  const created = await api<{ token: string; player: MyPlayer }>("/api/session", {
    method: "POST",
    body: JSON.stringify({}),
  });
  setToken(created.token);
  return created;
}
