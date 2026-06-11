import { serve } from "@hono/node-server";
import type { Hono } from "hono";

/**
 * Start a real Node HTTP server for the given app. Kept out of the test path
 * (tests drive the app via `app.request(...)`). For local dev run with e.g.
 * `node --import tsx packages/server/src/serve.ts`.
 *
 * Idle eviction is NOT automatic. If you want the manager to reclaim idle
 * sessions, the host opts in explicitly, e.g.:
 *
 *   const sweeper = manager.startSweeper(60_000); // sweep every minute
 *   // sessions idle longer than `evictAfterMs` (default 30m) and not busy are
 *   // snapshotted best-effort, then removed. The timer is unref'd. On shutdown:
 *   process.on("SIGINT", () => { sweeper.stop(); server.close(); });
 *
 * sweep() returns { evicted, snapshots } so you can persist sessionId ->
 * snapshotId pointers and let tenants restore evicted sessions later.
 */
export function startServer(app: Hono, port = 3000): { close: () => void } {
  const server = serve({ fetch: app.fetch, port });
  return { close: () => server.close() };
}
