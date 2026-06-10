import { serve } from "@hono/node-server";
import type { Hono } from "hono";

/**
 * Start a real Node HTTP server for the given app. Kept out of the test path
 * (tests drive the app via `app.request(...)`). For local dev run with e.g.
 * `node --import tsx packages/server/src/serve.ts`.
 */
export function startServer(app: Hono, port = 3000): { close: () => void } {
  const server = serve({ fetch: app.fetch, port });
  return { close: () => server.close() };
}
