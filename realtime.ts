/**
 * Standalone realtime hub — for SPLIT deployments.
 *
 * Default deployment runs Next.js + this hub in one process (server.ts).
 * On platforms that cannot run custom servers/WebSockets (e.g. Vercel),
 * deploy the Next.js app there and run THIS file as a small always-on
 * Node service (Railway / Render / Fly.io / any VPS):
 *
 *   DATABASE_URL=postgres://... npm run realtime
 *
 * The hub and the HTTP API must share the same DATABASE_URL so sessions,
 * scans and matches are visible to both.
 */
import { createServer } from "node:http";
import { initStore } from "./src/server/store";
import { setupWebSocketServer } from "./src/server/ws";
import { PSL_MODEL_VERSION } from "./src/lib/psl/version";
import { expectedModelHash } from "./src/server/attest";

const port = parseInt(process.env.REALTIME_PORT || process.env.PORT || "8081", 10);
const host = process.env.HOST || "0.0.0.0";

async function main() {
  await initStore();
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "mogbattle-realtime", model: PSL_MODEL_VERSION, modelHash: expectedModelHash() }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found — realtime hub serves WebSocket connections on /ws" }));
  });
  setupWebSocketServer(server);
  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`[mogbattle-realtime] listening on ${host}:${port} (ws path: /ws)`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[mogbattle-realtime] fatal", err);
  process.exit(1);
});
