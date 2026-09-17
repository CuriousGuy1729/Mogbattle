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

## Running on GitHub Codespaces

The repo ships a devcontainer — zero setup:

1. GitHub → this repo → **Code ▸ Codespaces ▸ Create codespace** (on any branch).
2. Wait for `npm install && npm run build` to finish; the server then starts
   automatically and port 3000 opens as a preview (`*.app.github.dev`, HTTPS).
3. The preview is a secure context, so **camera + mic work** — open the
   forwarded URL in **two browser tabs** to test a real match against yourself.
4. Editing code? Run `npm run dev` instead of `npm run start` for hot reload.

If a codespace was stopped and restarted, run `npm run start` again (or let
the devcontainer's post-attach hook do it).

## Deployment

### One process (recommended to start)

Everything — pages, API, matchmaking, signaling — runs in one Node process,
so any host that runs a long-lived Node server works out of the box:

| Host | How |
|---|---|
| **Railway / Render / Fly.io** | Detects the repo automatically (or use the included `Dockerfile`). Set `PORT`/`HOST` if needed. |
| **VPS** | `npm ci && npm run build && npm run start` behind nginx/caddy with TLS. |
| **Docker** | `docker build -t mogbattle . && docker run -p 3000:3000 mogbattle` |

Add `DATABASE_URL` (PostgreSQL) and `REDIS_URL` when you want durable,
multi-instance storage — see `docker-compose.yml` and `.env.example`.

### Deploying on Vercel — read this first

Vercel's Next.js hosting runs your code as **serverless functions**: no custom
servers, no long-lived processes, and (historically) no WebSockets. Mogbattle's
matchmaking + signaling hub is a stateful WebSocket server, so the single-process
mode **does not run on Vercel as-is**. The supported split:

```
┌────────────── Vercel ──────────────┐   ┌── Railway/Render/Fly (always-on) ──┐
│ Next.js UI + /api/* HTTP routes    │   │ npm run realtime                    │
│ (pages, scans verify, leaderboards)│◄──┤ WebSocket hub: matchmaking, rooms,  │
│                                    │   │ signaling (/ws), clock sync         │
└──────────────┬─────────────────────┘   └──────────────┬─────────────────────┘
               │            same DATABASE_URL           │
               └────────────► Neon Postgres ◄───────────┘
                        (Upstash Redis optional)
```

Steps:

1. **Database**: create a Postgres DB (Vercel ⇄ Neon integration, or any
   provider). Note: Vercel's filesystem is ephemeral, so the embedded store
   will not persist there — `DATABASE_URL` is required for Vercel.
2. **Realtime hub**: deploy this repo to Railway/Render/Fly with start
   command `npm run realtime` and the same `DATABASE_URL`. Give it a public
   HTTPS URL, e.g. `wss://mogbattle-realtime.up.railway.app`.
3. **Vercel**: import the repo (Next.js preset). Set environment variables:
   - `DATABASE_URL` → the shared Postgres
   - `REDIS_URL` → Upstash (optional; the limiter falls back to memory)
   - `NEXT_PUBLIC_WS_URL` → your realtime hub origin (client appends `/ws`)
4. Deploy. The UI/API run serverless on Vercel; matchmaking, the VS screen,
   countdown sync and WebRTC signaling flow through the hub. The video itself
   is peer-to-peer between browsers and never touches either server.

Notes: WebRTC works from any hosting (it's browser-to-browser). If you'd
rather keep one process, choose any host from the table above instead of
Vercel — that's the simplest production path.

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
