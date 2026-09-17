# MOGBATTLE — PSL /10 Ranked Face-Battle Arena

A real-time, trust-first mog-battle platform. Every competitor passes a
liveness-verified face scan scored by a **deterministic, documented geometric
pipeline (PSL-2026.1.0)**, then battles verified players over peer-to-peer
WebRTC with honest Elo.

> The central goal: consistent, reproducible and transparent facial analysis —
> never an arbitrary AI attractiveness guess, and never a fabricated number.

---

## How it works

1. **Consent + camera** — clear privacy notice; capture instructions.
2. **Face Verification Scan** — server-issued challenge sequence with
   *randomized order*: look straight → turn left / turn right / blink
   (shuffled) → neutral. Per-challenge evidence (yaw traces, EAR blink dip,
   face presence, timing) is validated server-side. Screenshots, static
   photos and replayed clips fail these checks.
3. **On-device scoring** — MediaPipe FaceLandmarker runs fully in the
   browser. Stabilized landmarks are normalized (distance / roll /
   translation), 13 dimensionless metrics + a symmetry index are measured,
   standardized against pinned references, weighted into a **PSL /10** with
   an explicit confidence. Below the confidence threshold → rescan, no guess.
4. **Randomized matchmaking** — Ranked 1v1, Casual 1v1, Random Duo 2v2 and
   Friend Challenge. Every queue requires a certified scan.
5. **Synchronized battle** — server-clock countdown, 6-second capture window,
   both faces scored on-device, attested to the server, revealed together.
6. **Fair Elo** — standard Elo vs opponent (or opposing team average).
   Rematch cooldowns, per-pair daily caps, mutual blocks, suspicion flags
   that halve gains. Global / Weekly / Seasonal / Regional leaderboards.

## Trust & anti-cheat

- Liveness via randomized challenge-response + timing windows
- Single-face gate, pose gates, lighting gates, sharpness gates
- Duplicate/replay detection via one-way capture digests (cross-account)
- Pinned model: version + SHA-256 over every scoring constant
- Server-side attestation validation (components, ranges, quality)
- Battle-vs-verified divergence flags matches and halves Elo gains
- Rate limiting everywhere; report + block; auto-flag on repeated reports
- Privacy: no face images are transmitted or stored — ever. Only score
  components, quality metrics and digests are retained.
- If a capture can't be measured honestly, the platform demands a rescan.

PSL is a platform-generated facial-analysis score — reproducible and
auditable, but **not** a scientific universal or a measure of human worth.
See `/methodology` in-app for the full component table and honesty statement.

## Stack

| Layer | Tech |
|---|---|
| App | Next.js 14 (custom Node server) + TypeScript |
| UI | Tailwind CSS, custom animation system |
| Realtime | WebSockets (signaling, matchmaking, clock sync) |
| Video | Peer-to-peer WebRTC (full mesh for Duo) |
| Face analysis | MediaPipe FaceLandmarker (on-device) |
| Storage | PostgreSQL (`pg`) — embedded JSON store fallback |
| Cache/limits | Redis (`ioredis`) — in-memory fallback |

## Running

```bash
npm install
npm run build
npm run start          # http://localhost:3000  (ws on /ws)
```

Development: `npm run dev`.

**Backing services (optional).** The app runs standalone with embedded
stores. For production:

```bash
docker compose up -d    # PostgreSQL + Redis (schema auto-applied)
export DATABASE_URL=postgres://mogbattle:mogbattle@localhost:5432/mogbattle
export REDIS_URL=redis://localhost:6379
npm run start
```

See `.env.example` for all tuning knobs (confidence threshold, scan TTL,
rematch cooldown, daily pair cap, K-factor).

## Testing

`scripts/e2e.ts` drives the full pipeline headlessly — sessions, scan
certification, replay rejection, duplicate-digest detection, queue gating,
matchmaking, synchronized battle scoring, zero-sum Elo, rematch cooldowns,
leaderboards, reports/blocks and rate limits:

```bash
npm run start &
npx tsx scripts/e2e.ts
```

## Repository map

```
server.ts                 custom server: Next + WebSocket hub on one port
src/server/               matchmaking, rooms, Elo, store (pg/memory), limiter
src/lib/psl/              the deterministic scoring model (pinned constants)
src/lib/client/           camera sampler, liveness runner, attestations, mesh RTC
src/app/api/              session, scan session/verify, leaderboards, profile,
                          report, block, health
src/app/play              the arena: consent → scan → queue → battle → reveal
src/app/lab               calibration lab (live diagnostics + unsaved test score)
src/app/methodology       full transparency documentation
db/schema.sql             PostgreSQL schema
scripts/e2e.ts            end-to-end test suite
```
