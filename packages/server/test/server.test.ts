import { describe, it, expect } from "vitest";
import type { LanguageModel } from "ai";
import { createApp } from "../src/app.js";
import { SessionManager, type ModelResolver } from "../src/session-manager.js";
import { scriptedModel, errorPartModel, type ScriptStep } from "./mock-model.js";

// ---- helpers ---------------------------------------------------------------

/** A model resolver returning a fixed scripted model regardless of id. */
function resolverFor(model: LanguageModel): ModelResolver {
  return () => model;
}

/** A scripted model that, given a turn, writes out.txt then answers. */
function writeAndAnswer(): ScriptStep[] {
  return [
    {
      kind: "tools",
      calls: [{ toolName: "Write", input: { file_path: "/out.txt", content: "hello world" } }],
    },
    { kind: "text", text: "done" },
  ];
}

interface SseEvent {
  type: string;
  [k: string]: unknown;
}

/** Parse an SSE response body into the list of JSON `data:` payloads. */
async function parseSse(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    try {
      events.push(JSON.parse(dataLines.join("\n")) as SseEvent);
    } catch {
      // ignore non-JSON keepalives
    }
  }
  return events;
}

function app(opts: { resolver?: ModelResolver; auth?: (k: string) => string | null } = {}) {
  const manager = new SessionManager({ modelResolver: opts.resolver });
  return createApp({ manager, auth: opts.auth });
}

async function createSession(
  a: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; sessionId?: string }> {
  const res = await a.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const status = res.status;
  if (status !== 200) return { status };
  const json = (await res.json()) as { sessionId: string };
  return { status, sessionId: json.sessionId };
}

// ---- tests -----------------------------------------------------------------

describe("POST /v1/sessions", () => {
  it("returns a sessionId", async () => {
    const a = app();
    const { status, sessionId } = await createSession(a, { model: "mock/x" });
    expect(status).toBe(200);
    expect(typeof sessionId).toBe("string");
    expect(sessionId).toBeTruthy();
  });

  it("seeds the FS with provided files", async () => {
    const a = app();
    const { sessionId } = await createSession(a, {
      model: "mock/x",
      files: { "/seed.txt": "abc" },
    });
    const res = await a.request(`/v1/sessions/${sessionId}/fs/seed.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc");
  });

  it("rejects a body without model (400)", async () => {
    const a = app();
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: {} }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("bad_request");
  });

  it("rejects invalid JSON (400)", async () => {
    const a = app();
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/sessions/:id/messages (SSE)", () => {
  it("streams tool_call + tool_result + turn_done and writes the file", async () => {
    const a = app({ resolver: resolverFor(scriptedModel(writeAndAnswer())) });
    const { sessionId } = await createSession(a, { model: "mock/x" });

    const res = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "write the file" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await parseSse(res);
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("turn_done");

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall?.tool).toBe("Write");

    // File now exists.
    const fileRes = await a.request(`/v1/sessions/${sessionId}/fs/out.txt`);
    expect(fileRes.status).toBe(200);
    expect(await fileRes.text()).toBe("hello world");
  });

  it("emits text_delta events", async () => {
    const a = app({ resolver: resolverFor(scriptedModel([{ kind: "text", text: "hi there" }])) });
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const res = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "say hi" }),
    });
    const events = await parseSse(res);
    expect(events.some((e) => e.type === "text_delta" && e.text === "hi there")).toBe(true);
    expect(events.some((e) => e.type === "turn_done")).toBe(true);
  });

  it("surfaces a mid-stream error as an {type:error} event (no crash)", async () => {
    const a = app({ resolver: resolverFor(errorPartModel("kaboom")) });
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const res = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "fail please" }),
    });
    expect(res.status).toBe(200);
    const events = await parseSse(res);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("rejects a body without prompt (400)", async () => {
    const a = app({ resolver: resolverFor(scriptedModel([{ kind: "text", text: "x" }])) });
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const res = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown session", async () => {
    const a = app();
    const res = await a.request("/v1/sessions/nope/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/sessions/:id/fs", () => {
  it("lists written files", async () => {
    const a = app({ resolver: resolverFor(scriptedModel(writeAndAnswer())) });
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const msg = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "write" }),
    });
    // Drain the SSE stream so the tool actually runs before we list.
    await parseSse(msg);
    const res = await a.request(`/v1/sessions/${sessionId}/fs`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { files: string[] };
    expect(json.files).toContain("/out.txt");
  });

  it("returns file content for an existing path", async () => {
    const a = app();
    const { sessionId } = await createSession(a, {
      model: "mock/x",
      files: { "/dir/a.txt": "content-a" },
    });
    const res = await a.request(`/v1/sessions/${sessionId}/fs/dir/a.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("content-a");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("returns 404 for a missing file", async () => {
    const a = app();
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const res = await a.request(`/v1/sessions/${sessionId}/fs/missing.txt`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("not_found");
  });
});

describe("snapshot + restore", () => {
  it("POST /snapshot returns a snapshotId, restore sees the file", async () => {
    // Single manager => single shared in-memory store across create + restore.
    const manager = new SessionManager({
      modelResolver: resolverFor(scriptedModel([{ kind: "text", text: "x" }])),
    });
    const a = createApp({ manager });

    // Create a session with a seeded file.
    const c1 = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/x", files: { "/keep.txt": "persisted" } }),
    });
    const { sessionId } = (await c1.json()) as { sessionId: string };

    // Snapshot it.
    const snapRes = await a.request(`/v1/sessions/${sessionId}/snapshot`, { method: "POST" });
    expect(snapRes.status).toBe(200);
    const { snapshotId } = (await snapRes.json()) as { snapshotId: string };
    expect(snapshotId).toBeTruthy();

    // Restore into a brand-new session.
    const c2 = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/x", snapshotId }),
    });
    expect(c2.status).toBe(200);
    const { sessionId: restoredId } = (await c2.json()) as { sessionId: string };
    expect(restoredId).not.toBe(sessionId);

    const fileRes = await a.request(`/v1/sessions/${restoredId}/fs/keep.txt`);
    expect(fileRes.status).toBe(200);
    expect(await fileRes.text()).toBe("persisted");
  });
});

describe("DELETE /v1/sessions/:id", () => {
  it("removes the session (subsequent GET -> 404)", async () => {
    const a = app();
    const { sessionId } = await createSession(a, {
      model: "mock/x",
      files: { "/x.txt": "y" },
    });
    const del = await a.request(`/v1/sessions/${sessionId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const json = (await del.json()) as { ok: boolean; snapshotId?: string };
    expect(json.ok).toBe(true);

    const after = await a.request(`/v1/sessions/${sessionId}/fs`);
    expect(after.status).toBe(404);
  });
});

describe("auth + tenant isolation", () => {
  const auth = (key: string): string | null => {
    if (key === "key-alice") return "alice";
    if (key === "key-bob") return "bob";
    return null;
  };

  it("missing key -> 401 when auth is configured", async () => {
    const a = app({ auth });
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/x" }),
    });
    expect(res.status).toBe(401);
  });

  it("invalid key -> 401", async () => {
    const a = app({ auth });
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bogus" },
      body: JSON.stringify({ model: "mock/x" }),
    });
    expect(res.status).toBe(401);
  });

  it("a tenant cannot access another tenant's session -> 403", async () => {
    const a = app({ auth });
    const { sessionId } = await createSession(
      a,
      { model: "mock/x", files: { "/secret.txt": "s" } },
      { authorization: "Bearer key-alice" },
    );
    // Alice can read it.
    const ok = await a.request(`/v1/sessions/${sessionId}/fs`, {
      headers: { authorization: "Bearer key-alice" },
    });
    expect(ok.status).toBe(200);
    // Bob cannot.
    const forbidden = await a.request(`/v1/sessions/${sessionId}/fs`, {
      headers: { authorization: "Bearer key-bob" },
    });
    expect(forbidden.status).toBe(403);
  });

  it("accepts the key via x-api-key header too", async () => {
    const a = app({ auth });
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "key-alice" },
      body: JSON.stringify({ model: "mock/x" }),
    });
    expect(res.status).toBe(200);
  });

  it("open mode (no auth) treats key as tenant, defaults to 'default'", async () => {
    const a = app();
    // No key -> "default" tenant; create then access without a key.
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const res = await a.request(`/v1/sessions/${sessionId}/fs`);
    expect(res.status).toBe(200);
  });
});
