/**
 * End-to-end functional verification of the ork runtime.
 *
 * Boots the REAL HTTP server (@hono/node-server) on a real TCP port and drives
 * it over real HTTP + SSE with the global fetch. No LLM key is needed: a
 * scripted mock model is wired through the SessionManager's modelResolver, so
 * the entire wire path is exercised end to end:
 *
 *   fetch (HTTP) -> Hono -> SessionManager -> harness send() loop ->
 *   AI SDK tool loop -> @ork/tools -> @ork/shell -> @ork/kernel -> VFS ->
 *   snapshot/restore -> back out over the socket as SSE frames.
 *
 * Run: pnpm dlx tsx scripts/e2e.ts   (or: node_modules/.bin/tsx scripts/e2e.ts)
 * Exits 0 only if every assertion passes; 1 otherwise.
 */
import { serve } from "@hono/node-server";
import { createApp } from "@ork/server";
import { SessionManager } from "@ork/server";
import { MemorySnapshotStore } from "@ork/kernel";
import type { LanguageModel } from "ai";
import type {
  LanguageModelV2,
  LanguageModelV2StreamPart,
  LanguageModelV2FinishReason,
} from "@ai-sdk/provider";

// ---- scripted mock model ---------------------------------------------------
// Mirrors the pattern of packages/server/test/mock-model.ts (which wraps
// ai/test's MockLanguageModelV2). We re-implement the tiny LanguageModelV2
// surface here directly rather than importing ai/test, because ai/test eagerly
// pulls in @ai-sdk/provider-utils/test -> vitest, which cannot load outside the
// vitest runner. This still drives the exact same wire path through the server.

type ScriptStep =
  | { kind: "text"; text: string; finishReason?: LanguageModelV2FinishReason }
  | {
      kind: "tools";
      text?: string;
      calls: Array<{ toolName: string; input: unknown; toolCallId?: string }>;
      finishReason?: LanguageModelV2FinishReason;
    };

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function streamFromParts(
  parts: LanguageModelV2StreamPart[],
): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

function stepToParts(step: ScriptStep, idx: number): LanguageModelV2StreamPart[] {
  const parts: LanguageModelV2StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if (step.kind === "text") {
    const id = `t${idx}`;
    parts.push(
      { type: "text-start", id },
      { type: "text-delta", id, delta: step.text },
      { type: "text-end", id },
      { type: "finish", finishReason: step.finishReason ?? "stop", usage: USAGE },
    );
    return parts;
  }
  if (step.text) {
    const id = `t${idx}`;
    parts.push(
      { type: "text-start", id },
      { type: "text-delta", id, delta: step.text },
      { type: "text-end", id },
    );
  }
  step.calls.forEach((c, i) => {
    parts.push({
      type: "tool-call",
      toolCallId: c.toolCallId ?? `call-${idx}-${i}`,
      toolName: c.toolName,
      input: JSON.stringify(c.input),
    });
  });
  parts.push({ type: "finish", finishReason: step.finishReason ?? "tool-calls", usage: USAGE });
  return parts;
}

/**
 * Build a LanguageModelV2 that emits `script` steps in order across doStream
 * calls. `delayMs` (optional) holds the turn open for that long before emitting
 * — used to keep the per-session turn lock reliably held during the overlap test.
 */
function scriptedModel(script: ScriptStep[], delayMs = 0): LanguageModelV2 {
  let call = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "mock-provider",
    modelId: "mock-model-id",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("doGenerate not used by the streaming harness");
    },
    doStream: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const step = script[call] ?? { kind: "text", text: "" };
      const parts = stepToParts(step as ScriptStep, call);
      call += 1;
      return { stream: streamFromParts(parts) };
    },
  };
  return model;
}

// ---- assertion harness -----------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
function assert(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  const tail = detail ? `  -- ${detail}` : "";
  // eslint-disable-next-line no-console
  console.log(`[${mark}] ${name}${tail}`);
}

// ---- scripted agent turn ---------------------------------------------------

/**
 * A realistic multi-tool turn for prompt "set up the project":
 *  1. Bash: mkdir -p /work, write version.txt via echo, ls
 *  2. Write: create /work/README.md
 *  3. Bash: read README.md back (cat)
 *  4. final assistant text "Project initialized."
 */
function setupProjectScript(): ScriptStep[] {
  return [
    {
      kind: "tools",
      calls: [
        {
          toolName: "Bash",
          input: { command: 'mkdir -p /work && echo "v1" > /work/version.txt && ls /work' },
        },
      ],
    },
    {
      kind: "tools",
      calls: [
        {
          toolName: "Write",
          input: {
            file_path: "/work/README.md",
            content: "# Project\n\nInitialized by ork e2e.\n",
          },
        },
      ],
    },
    {
      kind: "tools",
      calls: [{ toolName: "Bash", input: { command: "cat /work/README.md" } }],
    },
    { kind: "text", text: "Project initialized." },
  ];
}

// ---- SSE parsing over a real HTTP response body ----------------------------

interface SseEvent {
  type: string;
  [k: string]: unknown;
}

/** Incrementally read the SSE stream from a fetch Response, parsing frames. */
async function readSse(res: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""));
      if (dataLines.length === 0) continue;
      try {
        events.push(JSON.parse(dataLines.join("\n")) as SseEvent);
      } catch {
        // ignore keepalives / non-JSON
      }
    }
  }
  return events;
}

// ---- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const store = new MemorySnapshotStore();
  const manager = new SessionManager({
    store,
    // The "slow/agent" model id holds each turn open ~300ms so the overlap test
    // can reliably observe the per-session turn lock in flight; everything else
    // gets the fast scripted multi-tool agent.
    modelResolver: (modelId: string): LanguageModel =>
      modelId === "slow/agent"
        ? scriptedModel([{ kind: "text", text: "slow done." }], 300)
        : scriptedModel(setupProjectScript()),
  });

  const auth = (key: string): string | null => {
    if (key === "tenant-a-key") return "alice";
    if (key === "tenant-b-key") return "bob";
    return null;
  };

  const app = createApp({ manager, auth });

  // Start the REAL node HTTP server on an OS-assigned free port.
  const server = serve({ fetch: app.fetch, port: 0 });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  // eslint-disable-next-line no-console
  console.log(`\nork server listening on ${base}\n`);

  const ALICE = { authorization: "Bearer tenant-a-key" };
  const BOB = { authorization: "Bearer tenant-b-key" };
  const JSON_CT = { "content-type": "application/json" };

  try {
    // (a) Alice creates a session with a seed file.
    const createRes = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { ...JSON_CT, ...ALICE },
      body: JSON.stringify({ model: "mock/agent", files: { "/data/seed.txt": "seeded" } }),
    });
    assert("a1 POST /v1/sessions (alice) -> 200", createRes.status === 200, `status=${createRes.status}`);
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    assert("a2 create returns sessionId", typeof sessionId === "string" && sessionId.length > 0);

    // (b) Drive a turn over SSE.
    const msgRes = await fetch(`${base}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { ...JSON_CT, ...ALICE },
      body: JSON.stringify({ prompt: "set up the project" }),
    });
    assert("b1 POST /messages -> 200", msgRes.status === 200, `status=${msgRes.status}`);
    assert(
      "b2 content-type is text/event-stream",
      (msgRes.headers.get("content-type") ?? "").includes("text/event-stream"),
      msgRes.headers.get("content-type") ?? "",
    );
    const events = await readSse(msgRes);
    const types = events.map((e) => e.type);
    const toolCalls = events.filter((e) => e.type === "tool_call");
    const toolResults = events.filter((e) => e.type === "tool_result");
    const bashCalls = toolCalls.filter((e) => e.tool === "Bash");
    const writeCalls = toolCalls.filter((e) => e.tool === "Write");
    assert("b3 >=1 tool_call", toolCalls.length >= 1, `count=${toolCalls.length}`);
    assert("b4 >=1 Bash tool_call", bashCalls.length >= 1, `count=${bashCalls.length}`);
    assert("b5 >=1 Write tool_call", writeCalls.length >= 1, `count=${writeCalls.length}`);
    assert("b6 >=1 tool_result", toolResults.length >= 1, `count=${toolResults.length}`);
    const turnDone = events.find((e) => e.type === "turn_done") as
      | { type: string; text?: string }
      | undefined;
    assert("b7 turn_done present", !!turnDone, `types=${types.join(",")}`);
    assert(
      "b8 turn_done text == 'Project initialized.'",
      turnDone?.text === "Project initialized.",
      JSON.stringify(turnDone?.text),
    );
    // The first Bash result should contain the ls output listing version.txt.
    const firstBashResult = toolResults.find((e) => e.tool === "Bash") as
      | { output?: string }
      | undefined;
    assert(
      "b9 Bash result contains 'version.txt' (ls ran in real shell)",
      !!firstBashResult?.output?.includes("version.txt"),
      JSON.stringify(firstBashResult?.output?.slice(0, 80)),
    );

    // (c) Inspect the resulting FS over HTTP.
    const listRes = await fetch(`${base}/v1/sessions/${sessionId}/fs`, { headers: ALICE });
    assert("c1 GET /fs -> 200", listRes.status === 200, `status=${listRes.status}`);
    const { files } = (await listRes.json()) as { files: string[] };
    assert("c2 /work/version.txt listed", files.includes("/work/version.txt"), files.join(","));
    assert("c3 /work/README.md listed", files.includes("/work/README.md"));
    assert("c4 /data/seed.txt listed (seed survived)", files.includes("/data/seed.txt"));

    const verRes = await fetch(`${base}/v1/sessions/${sessionId}/fs/work/version.txt`, {
      headers: ALICE,
    });
    const verBody = await verRes.text();
    assert("c5 GET version.txt -> 200", verRes.status === 200, `status=${verRes.status}`);
    assert("c6 version.txt body == 'v1\\n'", verBody === "v1\n", JSON.stringify(verBody));

    const readmeRes = await fetch(`${base}/v1/sessions/${sessionId}/fs/work/README.md`, {
      headers: ALICE,
    });
    const readmeBody = await readmeRes.text();
    assert(
      "c7 GET README.md content matches written content",
      readmeRes.status === 200 && readmeBody.includes("Initialized by ork e2e."),
      JSON.stringify(readmeBody.slice(0, 40)),
    );

    // (d) Tenant isolation.
    const bobRes = await fetch(`${base}/v1/sessions/${sessionId}/fs`, { headers: BOB });
    assert("d1 bob GET alice's /fs -> 403", bobRes.status === 403, `status=${bobRes.status}`);
    const noKeyRes = await fetch(`${base}/v1/sessions/${sessionId}/fs`);
    assert("d2 no-key GET /fs -> 401", noKeyRes.status === 401, `status=${noKeyRes.status}`);

    // (e) Concurrency lock. Use a dedicated session backed by the "slow/agent"
    //     model (~300ms per turn) so the first turn reliably holds the
    //     per-session turn lock while a second, genuinely overlapping request
    //     arrives. The lock must reject the second with 409 turn_in_flight.
    const lockCreate = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { ...JSON_CT, ...ALICE },
      body: JSON.stringify({ model: "slow/agent" }),
    });
    const { sessionId: lockId } = (await lockCreate.json()) as { sessionId: string };

    // Start the first turn but do NOT await/consume its stream — keep it open so
    // the server's streamSSE generator (and thus the lock) is still in flight.
    const firstStreamPromise = fetch(`${base}/v1/sessions/${lockId}/messages`, {
      method: "POST",
      headers: { ...JSON_CT, ...ALICE },
      body: JSON.stringify({ prompt: "slow overlapping turn" }),
    });
    // Give the first request time to acquire the lock (model delay is ~300ms).
    await new Promise((r) => setTimeout(r, 100));
    const secondRes = await fetch(`${base}/v1/sessions/${lockId}/messages`, {
      method: "POST",
      headers: { ...JSON_CT, ...ALICE },
      body: JSON.stringify({ prompt: "second overlapping turn" }),
    });
    assert(
      "e1 overlapping 2nd POST /messages -> 409 turn_in_flight",
      secondRes.status === 409,
      `status=${secondRes.status}`,
    );
    if (secondRes.status === 409) {
      const j = (await secondRes.json()) as { error?: { code?: string } };
      assert("e2 409 body code == turn_in_flight", j.error?.code === "turn_in_flight", JSON.stringify(j));
    } else {
      await secondRes.body?.cancel();
      assert("e2 409 body code == turn_in_flight", false, "skipped: 2nd did not 409");
    }
    // Drain the first stream so the lock releases.
    const firstStream = await firstStreamPromise;
    await readSse(firstStream);
    // A subsequent (non-overlapping) turn should now succeed.
    const thirdRes = await fetch(`${base}/v1/sessions/${lockId}/messages`, {
      method: "POST",
      headers: { ...JSON_CT, ...ALICE },
      body: JSON.stringify({ prompt: "after lock released" }),
    });
    assert("e3 turn after lock released -> 200", thirdRes.status === 200, `status=${thirdRes.status}`);
    await readSse(thirdRes);

    // (f) Snapshot + restore (and cross-tenant restore denial).
    const snapRes = await fetch(`${base}/v1/sessions/${sessionId}/snapshot`, {
      method: "POST",
      headers: ALICE,
    });
    assert("f1 POST /snapshot -> 200", snapRes.status === 200, `status=${snapRes.status}`);
    const { snapshotId } = (await snapRes.json()) as { snapshotId: string };
    assert("f2 snapshotId returned", typeof snapshotId === "string" && snapshotId.length > 0);

    const restoreRes = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { ...JSON_CT, ...ALICE },
      body: JSON.stringify({ model: "mock/agent", snapshotId }),
    });
    assert("f3 alice restore from snapshot -> 200", restoreRes.status === 200, `status=${restoreRes.status}`);
    const { sessionId: sessionId2 } = (await restoreRes.json()) as { sessionId: string };
    assert("f4 restored session has a new id", sessionId2 !== sessionId);

    const restoredList = await fetch(`${base}/v1/sessions/${sessionId2}/fs/work/README.md`, {
      headers: ALICE,
    });
    const restoredBody = await restoredList.text();
    assert(
      "f5 README.md survived snapshot/restore",
      restoredList.status === 200 && restoredBody.includes("Initialized by ork e2e."),
      `status=${restoredList.status}`,
    );

    const bobRestore = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { ...JSON_CT, ...BOB },
      body: JSON.stringify({ model: "mock/agent", snapshotId }),
    });
    assert("f6 bob restore alice's snapshot -> 403", bobRestore.status === 403, `status=${bobRestore.status}`);

    // (g) Delete + 404 afterwards.
    const delRes = await fetch(`${base}/v1/sessions/${sessionId}`, {
      method: "DELETE",
      headers: ALICE,
    });
    assert("g1 DELETE session -> 200", delRes.status === 200, `status=${delRes.status}`);
    const delJson = (await delRes.json()) as { ok?: boolean };
    assert("g2 delete body { ok: true }", delJson.ok === true, JSON.stringify(delJson));
    const afterDel = await fetch(`${base}/v1/sessions/${sessionId}/fs`, { headers: ALICE });
    assert("g3 GET deleted session -> 404", afterDel.status === 404, `status=${afterDel.status}`);
  } finally {
    server.close();
  }
}

main()
  .then(() => {
    const failed = checks.filter((c) => !c.ok);
    // eslint-disable-next-line no-console
    console.log(
      `\n==== E2E SUMMARY: ${checks.length - failed.length}/${checks.length} passed ====`,
    );
    if (failed.length > 0) {
      // eslint-disable-next-line no-console
      console.log("FAILED:");
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  (${f.detail})` : ""}`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log("ALL ASSERTIONS PASSED — ork runs end to end over real HTTP/SSE.");
    process.exit(0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("\nE2E CRASHED:", err);
    process.exit(1);
  });
