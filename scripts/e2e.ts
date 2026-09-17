/**
 * End-to-end test: session → scan certification → ranked matchmaking →
 * synchronized battle scoring → Elo → leaderboards → anti-farm cooldown.
 *
 * The synthetic "faces" are generated as landmark constellations and pushed
 * through the REAL scoring pipeline (no mocks), proving the deterministic
 * model, attestation validation, liveness evidence checks and Elo all work.
 *
 * Usage: BASE=http://localhost:3000 npx tsx scripts/e2e.ts
 */
import { WebSocket } from "ws";
import { computePsl } from "../src/lib/psl/score";
import { captureDigest, componentsFromResult } from "../src/lib/psl/score";
import { stabilizeFrames, alignFace } from "../src/lib/psl/geometry";
import type { BattleAttestation, CaptureQuality, Landmarks } from "../src/lib/psl/types";

const BASE = process.env.BASE || "http://localhost:3000";
const results: string[] = [];
const ok = (name: string) => results.push(`  ✔ ${name}`);
const fail = (name: string, extra?: unknown) => {
  results.push(`  ✘ ${name}`);
  // eslint-disable-next-line no-console
  console.error(extra);
  process.exitCode = 1;
};

async function jpost(path: string, body: unknown, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function jget(path: string, token?: string) {
  const res = await fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/* ── synthetic face ───────────────────────────────────────────────────── */
function hash01(seed: number, salt: number): number {
  let h = (seed * 374761393 + salt * 668265263) >>> 0;
  h = (h ^ (h >> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295; // [0,1)
}

function synthFace(seed: number): Landmarks {
  const lm: Landmarks = Array.from({ length: 478 }, (_, i) => ({
    x: 0.5 + 0.001 * Math.sin(i + seed),
    y: 0.5 + 0.001 * Math.cos(i + seed),
    z: 0,
  }));
  const set = (i: number, x: number, y: number) => {
    lm[i] = { x, y, z: 0 };
  };
  // per-seed deterministic micro-perturbation of key landmarks (±1.5mm-class),
  // wide seed space → unique capture digest per synthetic identity
  const off = (salt: number) => (hash01(seed, salt) - 0.5) * 0.006;

  set(468, 0.4, 0.44); set(473, 0.6, 0.44); // iris centers (IPD = 0.2)
  for (let k = 0; k < 4; k++) { set(469 + k, 0.4 + 0.004 * Math.cos(k), 0.44 + 0.004 * Math.sin(k)); set(474 + k, 0.6 + 0.004 * Math.cos(k), 0.44 + 0.004 * Math.sin(k)); }
  set(33, 0.325 + off(1), 0.44 + off(2)); set(133, 0.425 + off(3), 0.437); set(159, 0.375, 0.42); set(145, 0.375, 0.462);
  set(262, 0.675 - off(1), 0.44 + off(4)); set(362, 0.575 - off(3), 0.437); set(386, 0.625, 0.42); set(374, 0.625, 0.462);
  set(70, 0.35, 0.405); set(300, 0.65, 0.405); set(105, 0.37, 0.396); set(334, 0.63, 0.396);
  set(6, 0.5, 0.47); set(1, 0.5, 0.545); set(2, 0.5 + off(5), 0.58); set(48, 0.452, 0.556); set(275, 0.548, 0.556);
  set(168, 0.5, 0.362); set(10, 0.5, 0.262); set(13, 0.5, 0.655 + off(6)); set(0, 0.5, 0.635); set(17, 0.5, 0.676); set(152, 0.5, 0.8 + off(7)); set(199, 0.5, 0.77);
  set(61, 0.425 + off(8), 0.642 + off(9)); set(291, 0.575 - off(8), 0.642 + off(10));
  set(234, 0.279, 0.5); set(454, 0.721, 0.5);
  set(58, 0.313, 0.66); set(288, 0.687, 0.66);
  set(93, 0.3, 0.55); set(323, 0.7, 0.55);
  set(172, 0.37, 0.74); set(397, 0.63, 0.74);
  return lm;
}

function quality(): CaptureQuality {
  return { brightness: 126, contrast: 42, sharpness: 310, facePresence: 0.97, stability: 0.0031, yawDeg: 1.2, rollDeg: -0.8, badFrameRate: 0.05, framesUsed: 18 };
}

async function makeAttestation(seed: number): Promise<BattleAttestation | null> {
  const frames = Array.from({ length: 16 }, (_, i) => synthFace(seed + i * 0)); // identical frames = stable capture
  const result = await computePsl(frames, quality());
  if (!result) return null;
  const median = stabilizeFrames(frames);
  const { pts } = alignFace(median);
  const digest = await captureDigest(pts);
  return {
    version: result.version,
    score: result.score,
    confidence: result.confidence,
    quality: quality(),
    components: componentsFromResult(result),
    digest,
    modelHash: result.modelHash,
  };
}

/* ── WS helper ────────────────────────────────────────────────────────── */
class Client {
  ws!: WebSocket;
  handlers = new Map<string, Array<(m: never) => void>>();
  inbox: Array<{ t: string; [k: string]: unknown }> = [];

  constructor(public name: string, public token: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws");
      this.ws.on("open", () => this.send({ t: "hello", token: this.token }));
      this.ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        this.inbox.push(m);
        if (m.t === "hello_ok") resolve();
        if (m.t === "error" && m.code === "bad_token") reject(new Error("bad token"));
        for (const h of this.handlers.get(m.t) ?? []) h(m);
      });
      this.ws.on("error", reject);
    });
  }
  on(type: string, fn: (m: never) => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(fn);
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  waitFor(type: string, timeoutMs = 20000): Promise<{ t: string; [k: string]: unknown }> {
    const idx = this.inbox.findIndex((m) => m.t === type);
    if (idx >= 0) {
      const [seen] = this.inbox.splice(idx, 1); // consume so later waits don't see stale messages
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.on(type, (m) => {
        // consume from inbox too, so later waits can't see it as a new event
        const i = this.inbox.indexOf(m as never);
        if (i >= 0) this.inbox.splice(i, 1);
        clearTimeout(timer);
        resolve(m as { t: string });
      });
    });
  }
  close() {
    this.ws?.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── the test run ─────────────────────────────────────────────────────── */
async function main() {
  // 1. health
  const health = await jget("/api/health");
  if (health.status === 200 && health.data.ok) ok(`health: model ${health.data.model} · storage ${health.data.storage} · limiter ${health.data.limiter}`);
  else fail("health", health);

  // 2. two players
  const s1 = await jpost("/api/session", {});
  const s2 = await jpost("/api/session", {});
  if (s1.status === 200 && s2.status === 200) ok(`sessions created (${s1.data.player.handle}, ${s2.data.player.handle})`);
  else { fail("session create", { s1, s2 }); return; }
  const t1 = s1.data.token as string;
  const t2 = s2.data.token as string;

  // 3. scan sessions + certification
  const R = Math.floor(Math.random() * 1_000_000); // fresh identities per run
  const attest1 = await makeAttestation(R + 1);
  const attest2 = await makeAttestation(R + 2);
  if (!attest1 || !attest2) { fail("attestation build"); return; }
  ok(`pipeline scores: A=${attest1.score} B=${attest2.score} (confidence ${attest1.confidence}/${attest2.confidence})`);

  const scanSession1 = await jpost("/api/scan/session", {}, t1);
  const scanSession2 = await jpost("/api/scan/session", {}, t2);
  if (scanSession1.status !== 200 || scanSession2.status !== 200) { fail("scan session", { scanSession1 }); return; }

  const evidenceFor = (challenges: string[], seed: number) =>
    challenges.map((id) => {
      const base = { id, durationMs: 2100 + seed * 10, facePresence: 0.97 };
      if (id === "neutral_start" || id === "neutral_end") return { ...base, medianYawDeg: 1.1, medianRollDeg: -0.6 };
      if (id === "turn_left") return { ...base, maxYawDeg: 31.4 };
      if (id === "turn_right") return { ...base, minYawDeg: -29.8 };
      return { ...base, minEar: 0.121, blinkCount: 1 };
    });

  const v1 = await jpost("/api/scan/verify", { sessionId: scanSession1.data.sessionId, evidence: evidenceFor(scanSession1.data.challenges, 1), attestation: attest1 }, t1);
  const v2 = await jpost("/api/scan/verify", { sessionId: scanSession2.data.sessionId, evidence: evidenceFor(scanSession2.data.challenges, 2), attestation: attest2 }, t2);
  if (v1.status === 200 && v2.status === 200) ok(`scan certification: A=${v1.data.psl} B=${v2.data.psl}`);
  else { fail("scan verify", { v1, v2 }); return; }

  // 3b. liveness evidence with wrong order must be rejected
  const ss3 = await jpost("/api/scan/session", {}, t1);
  const badEvidence = evidenceFor(scanSession1.data.challenges, 1).reverse();
  const v3 = await jpost("/api/scan/verify", { sessionId: ss3.data.sessionId, evidence: badEvidence, attestation: attest1 }, t1);
  if (v3.status === 422) ok("shuffled evidence order rejected (anti-replay)");
  else fail("evidence order check", v3);

  // 3c. duplicate digest across accounts must be rejected
  const s3 = await jpost("/api/session", {});
  const ss4 = await jpost("/api/scan/session", {}, s3.data.token);
  const v4 = await jpost("/api/scan/verify", { sessionId: ss4.data.sessionId, evidence: evidenceFor(ss4.data.challenges, 3), attestation: attest1 }, s3.data.token);
  if (v4.status === 403 && v4.data.error === "duplicate_capture") ok("duplicate capture digest rejected + account flagged");
  else fail("duplicate digest check", v4);

  // 3d. verification gate behaviour (currently OPTIONAL via REQUIRE_VERIFIED_SCAN=false)
  const c3 = new Client("C", s3.data.token);
  await c3.connect();
  c3.send({ t: "queue_join", mode: "ranked" });
  const blocked = await c3.waitFor("scan_required", 2500).catch(() => null);
  if (blocked) {
    ok("verification gate enforced (scan_required)");
  } else {
    const joined = await c3.waitFor("queue_joined", 4000).catch(() => null);
    if (joined) ok("verification gate is OFF (optional mode) — unverified player may queue");
    else fail("queue gate check");
  }
  c3.send({ t: "queue_leave" });
  c3.close();

  // 4. ranked matchmaking over WS
  const c1 = new Client("A", t1);
  const c2 = new Client("B", t2);
  await c1.connect();
  await c2.connect();
  c1.send({ t: "queue_join", mode: "ranked" });
  await sleep(300);
  c2.send({ t: "queue_join", mode: "ranked" });

  const mf1 = (await c1.waitFor("match_found", 15000)) as { players: Array<{ id: string; elo: number }> };
  const mf2 = (await c2.waitFor("match_found", 15000)) as { players: Array<{ id: string; elo: number }> };
  if (mf1 && mf2 && mf1.players.length === 2) ok(`match found (${mf1.players.map((p) => `${p.id.slice(0, 6)}@${p.elo}`).join(" vs ")})`);
  else { fail("matchmaking"); return; }

  const bs1 = await c1.waitFor("battle_start", 15000);
  if (bs1) ok("synchronized battle_start broadcast");
  else fail("battle_start");

  // 5. battle scores (slight capture jitter on the battle capture)
  const battle1 = await makeAttestation(R + 11);
  const battle2 = await makeAttestation(R + 12);
  c1.send({ t: "battle_score", attestation: battle1 });
  c2.send({ t: "battle_score", attestation: battle2 });
  const ack1 = await c1.waitFor("score_ack", 8000);
  if ((ack1 as { accepted: boolean }).accepted) ok("battle attestation accepted");
  else fail("battle score ack", ack1);

  const r1 = (await c1.waitFor("match_result", 20000)) as {
    winnerSide: number | null; status: string; elo: { before: number; after: number; delta: number } | null; win: boolean;
    sides: Array<{ side: number; score: number | null; players: Array<{ handle: string }> }>;
  };
  const r2 = (await c2.waitFor("match_result", 20000)) as typeof r1;
  if (r1 && r1.status === "done" && r1.elo && r2?.elo) {
    const w = r1.sides[r1.winnerSide ?? 0];
    ok(`battle decided: winner side ${r1.winnerSide} (${w?.players.map((p) => p.handle).join(",")}) · scores ${r1.sides.map((s) => s.score).join(" vs ")}`);
    ok(`elo: A ${r1.elo.before}→${r1.elo.after} (${r1.elo.delta >= 0 ? "+" : ""}${r1.elo.delta}) · B ${r2.elo!.before}→${r2.elo!.after} (${r2.elo!.delta >= 0 ? "+" : ""}${r2.elo!.delta})`);
    if (r1.elo.delta + r2.elo!.delta === 0) ok("elo is zero-sum");
    else fail("elo zero-sum", { a: r1.elo.delta, b: r2.elo!.delta });
  } else fail("match result", { r1, r2 });

  // 6. anti-farm: immediate requeue must NOT rematch the same pair
  c1.send({ t: "queue_join", mode: "ranked" });
  c2.send({ t: "queue_join", mode: "ranked" });
  const rematch = await c1.waitFor("match_found", 4000).catch(() => null);
  if (!rematch) ok("rematch cooldown enforced (same pair cannot immediately re-match)");
  else fail("rematch cooldown", rematch);
  c1.send({ t: "queue_leave" });
  c2.send({ t: "queue_leave" });

  // 6b. batch matchmaking — every waiting player pairs within one tick window
  {
    const toks = await Promise.all([...Array(4)].map(() => jpost("/api/session", {})));
    if (toks.some((s) => s.status !== 200)) { fail("batch sessions", toks); return; }
    const batch = toks.map((s, i) => new Client(`D${i}`, s.data.token as string));
    await Promise.all(batch.map((c) => c.connect()));
    for (const c of batch) c.send({ t: "queue_join", mode: "ranked" });
    const found = await Promise.all(batch.map((c) => c.waitFor("match_found", 12000).catch(() => null)));
    const roomIds = new Set(found.map((m) => m && (m as { matchId?: string }).matchId).filter(Boolean));
    if (found.every(Boolean) && roomIds.size === 2 && (found[0] as { players: unknown[] }).players.length === 2)
      ok("batch matchmaking: 4 queued ranked players → 2 simultaneous matches");
    else fail("batch matchmaking", found);
    for (const c of batch) c.close();
  }

  // 6c. random duo — 4 solo joiners auto-team into one 2v2 battle
  {
    const toks = await Promise.all([...Array(4)].map(() => jpost("/api/session", {})));
    if (toks.some((s) => s.status !== 200)) { fail("duo sessions", toks); return; }
    const duo = toks.map((s, i) => new Client(`U${i}`, s.data.token as string));
    await Promise.all(duo.map((c) => c.connect()));
    for (const c of duo) c.send({ t: "queue_join", mode: "duo" });
    const found = await Promise.all(duo.map((c) => c.waitFor("match_found", 12000).catch(() => null)));
    if (found.every(Boolean) && (found[0] as { players: unknown[] }).players.length === 4)
      ok("random duo: 4 queued players auto-teamed into one 2v2 battle");
    else fail("duo matchmaking", found);
    for (const c of duo) c.close();
  }

  // 6d. stress: 10 players queue duo → multiple simultaneous 2v2 battles
  {
    const toks = await Promise.all([...Array(10)].map(() => jpost("/api/session", {})));
    if (toks.some((s) => s.status !== 200)) { fail("duo stress sessions", toks); return; }
    const many = toks.map((s, i) => new Client(`S${i}`, s.data.token as string));
    await Promise.all(many.map((c) => c.connect()));
    for (const c of many) c.send({ t: "queue_join", mode: "duo" });
    const found = await Promise.all(many.map((c) => c.waitFor("match_found", 12000).catch(() => null)));
    const matched = found.filter(Boolean);
    const rooms = new Set(matched.map((m) => (m as { matchId?: string }).matchId));
    if (matched.length === 8 && rooms.size === 2 && matched.every((m) => (m as { players: unknown[] }).players.length === 4))
      ok("duo stress: 10 queued → two simultaneous 2v2 battles (2 keep waiting)");
    else fail("duo stress", { matched: matched.length, rooms: rooms.size });
    for (const c of many) c.close();
  }

  // 7. leaderboards + profile reflect the match
  const lb = await jget("/api/leaderboard?board=global");
  const weekly = await jget("/api/leaderboard?board=weekly");
  if (lb.status === 200 && lb.data.rows.length >= 2) ok(`global leaderboard rows: ${lb.data.rows.length} (top: ${lb.data.rows[0].handle} @ ${lb.data.rows[0].elo})`);
  else fail("global leaderboard", lb);
  if (weekly.status === 200 && weekly.data.rows.length >= 2) ok(`weekly leaderboard rows: ${weekly.data.rows.length}`);
  else fail("weekly leaderboard", weekly);

  const prof = await jget("/api/profile", t1);
  if (prof.status === 200 && (prof.data.player.wins === 1 || prof.data.player.losses === 1))
    ok(`profile updated: ${prof.data.player.handle} ${prof.data.player.wins}W-${prof.data.player.losses}L elo=${prof.data.player.elo} ratings=${prof.data.ratings.length} matches=${prof.data.matches.length}`);
  else fail("profile", prof);

  // 8. report + block
  const rep = await jpost("/api/report", { targetId: s2.data.player.id, reason: "cheating", matchId: mf1 && (mf1 as unknown as { matchId?: string }).matchId }, t1);
  const blk = await jpost("/api/block", { targetId: s2.data.player.id }, t1);
  if (rep.status === 200 && blk.status === 200) ok("report + block endpoints OK");
  else fail("report/block", { rep, blk });

  // 9. rate limiting on scan sessions
  let limited = false;
  for (let i = 0; i < 10; i++) {
    const r = await jpost("/api/scan/session", {}, t2);
    if (r.status === 429) { limited = true; break; }
  }
  if (limited) ok("scan-session rate limit kicks in");
  else fail("rate limit");

  c1.close();
  c2.close();

  // eslint-disable-next-line no-console
  console.log("\nE2E RESULTS\n" + results.join("\n"));
  if (process.exitCode !== 1) // eslint-disable-next-line no-console
    console.log("\nALL GREEN ✅");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("E2E crashed:", e);
  process.exit(1);
});
