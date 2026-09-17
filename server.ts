/**
 * Mogbattle — custom Node server.
 *
 * Serves the Next.js application and attaches the WebSocket signaling /
 * matchmaking server on the same HTTP listener at path `/ws`, so the whole
 * platform (HTTPS + WSS) runs behind a single origin.
 */
import { createServer } from "node:http";
import next from "next";
import { parse } from "node:url";
import { setupWebSocketServer } from "./src/server/ws";
import { initStore } from "./src/server/store";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

async function main() {
  await initStore();

  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = createServer((req, res) => {
    handle(req, res, parse(req.url || "/", true));
  });

  setupWebSocketServer(server);

  server.listen(port, hostname, () => {
    // eslint-disable-next-line no-console
    console.log(`[mogbattle] ready on http://${hostname}:${port} (ws on /ws) — env: ${dev ? "dev" : "production"}`);
  });

  const shutdown = () => {
    // eslint-disable-next-line no-console
    console.log("[mogbattle] shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[mogbattle] fatal startup error", err);
  process.exit(1);
});
