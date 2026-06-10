/**
 * Example 4 — Run ork as an HTTP service (multi-tenant, SSE streaming).
 *
 * This boots the real server: agents embedded behind an HTTP API. Each tenant
 * creates sessions, sends messages (streamed back as SSE), reads the resulting
 * files, and snapshots/restores. This is the shape you'd deploy in a SaaS.
 *
 * REQUIRES AN LLM KEY (AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY) because real
 * messages drive a model. The default modelResolver passes the model id string
 * straight to the AI SDK (gateway routing).
 *
 * Run:  pnpm -F @ork/example server      (or: tsx example/04-server.ts)
 * Then, in another terminal, the curl commands printed below.
 */
import { createApp, SessionManager, startServer } from "@ork/server";
import { MemorySnapshotStore } from "@ork/kernel";

const PORT = 3000;

function main() {
  // The SessionManager owns sessions + the snapshot store. modelResolver maps
  // the model id from the HTTP body to a LanguageModel — default identity sends
  // "provider/model" to the AI Gateway. Swap in DiskSnapshotStore / an R2
  // adapter for durable, cross-instance sessions.
  const manager = new SessionManager({
    store: new MemorySnapshotStore(),
    // modelResolver: (id) => id,   // default; or map ids to pinned providers
  });

  // A trivial tenant auth: API key -> tenant id. Replace with your own.
  const tenants: Record<string, string> = {
    "key-alice": "alice",
    "key-bob": "bob",
  };
  const app = createApp({
    manager,
    auth: (apiKey) => tenants[apiKey] ?? null, // unknown key -> 401
  });

  const server = startServer(app, PORT);
  const base = `http://localhost:${PORT}`;

  console.log(`=== ork server listening on ${base} ===\n`);
  console.log("Try it (needs AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY set in this process):\n");
  console.log(`# 1. create a session (seeded with a file)`);
  console.log(`curl -s ${base}/v1/sessions -H 'Authorization: Bearer key-alice' \\`);
  console.log(`  -H 'content-type: application/json' \\`);
  console.log(`  -d '{"model":"anthropic/claude-sonnet-4-5","files":{"/notes.txt":"todo: ship ork"}}'`);
  console.log(`# -> {"sessionId":"..."}\n`);
  console.log(`# 2. send a message, stream the agent's work as SSE`);
  console.log(`curl -N ${base}/v1/sessions/<ID>/messages -H 'Authorization: Bearer key-alice' \\`);
  console.log(`  -H 'content-type: application/json' \\`);
  console.log(`  -d '{"prompt":"append a line to /notes.txt and list the file"}'\n`);
  console.log(`# 3. read a file the agent produced`);
  console.log(`curl -s ${base}/v1/sessions/<ID>/fs/notes.txt -H 'Authorization: Bearer key-alice'\n`);
  console.log(`# 4. snapshot, then restore into a fresh session`);
  console.log(`curl -s -XPOST ${base}/v1/sessions/<ID>/snapshot -H 'Authorization: Bearer key-alice'`);
  console.log(`curl -s ${base}/v1/sessions -H 'Authorization: Bearer key-alice' \\`);
  console.log(`  -H 'content-type: application/json' -d '{"model":"anthropic/claude-sonnet-4-5","snapshotId":"<SNAP>"}'\n`);
  console.log("Tenant isolation: key-bob gets 403 on alice's sessions; no key -> 401.");
  console.log("Press Ctrl+C to stop.\n");

  process.on("SIGINT", () => {
    server.close();
    console.log("\nserver stopped.");
    process.exit(0);
  });
}

main();
