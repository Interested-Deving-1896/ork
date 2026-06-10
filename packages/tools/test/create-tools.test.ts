import { describe, expect, it } from "vitest";
import { createTools } from "../src/index.js";
import { makeCtx, readBack } from "./helpers.js";

// A minimal ToolCallOptions-shaped object to satisfy execute()'s signature.
const callOpts = { toolCallId: "test-call", messages: [] } as never;

describe("createTools", () => {
  it("returns the six Claude-Code tools with descriptions and execute", () => {
    const { ctx } = makeCtx();
    const tools = createTools(ctx);
    const names = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] as const;
    for (const n of names) {
      const t = tools[n];
      expect(typeof t.description).toBe("string");
      expect((t.description ?? "").length).toBeGreaterThan(10);
      expect(t.inputSchema).toBeDefined();
      expect(typeof t.execute).toBe("function");
    }
  });

  it("Read.execute returns cat -n formatted content", async () => {
    const { ctx } = makeCtx({ "/a.txt": "hi\n" });
    const tools = createTools(ctx);
    const out = await tools.Read.execute!({ file_path: "/a.txt" }, callOpts);
    expect(out).toBe("     1\thi");
  });

  it("Write.execute then Read.execute round-trips", async () => {
    const { ctx } = makeCtx();
    const tools = createTools(ctx);
    const w = await tools.Write.execute!({ file_path: "/x.txt", content: "data" }, callOpts);
    expect(w).toContain("created");
    const r = await tools.Read.execute!({ file_path: "/x.txt" }, callOpts);
    expect(r).toBe("     1\tdata");
  });

  it("Bash.execute returns combined output string", async () => {
    const { ctx } = makeCtx();
    const tools = createTools(ctx);
    const out = await tools.Bash.execute!({ command: "echo hey" }, callOpts);
    expect(out).toBe("hey\n");
  });

  it("Edit.execute returns an Error string instead of throwing for EditError", async () => {
    const { ctx } = makeCtx({ "/a.txt": "abc" });
    const tools = createTools(ctx);
    const out = await tools.Edit.execute!(
      { file_path: "/a.txt", old_string: "zzz", new_string: "q" },
      callOpts,
    );
    expect(out).toContain("Error:");
    expect(out).toContain("not found");
  });

  it("Glob.execute lists matching files", async () => {
    const { ctx } = makeCtx({ "/a.ts": "1", "/b.ts": "2" });
    const tools = createTools(ctx);
    const out = await tools.Glob.execute!({ pattern: "*.ts" }, callOpts);
    expect(out).toBe("/a.ts\n/b.ts");
  });

  it("Grep.execute returns matching files", async () => {
    const { ctx } = makeCtx({ "/a.ts": "needle\n", "/b.ts": "nope\n" });
    const tools = createTools(ctx);
    const out = await tools.Grep.execute!({ pattern: "needle" }, callOpts);
    expect(out).toBe("/a.ts");
  });

  it("Grep.execute returns an Error string (not a throw) for an invalid regex", async () => {
    const { ctx } = makeCtx({ "/a.ts": "x\n" });
    const tools = createTools(ctx);
    // execute must resolve to a string, never reject.
    const out = await tools.Grep.execute!({ pattern: "(" }, callOpts);
    expect(out).toMatch(/^Error:/);
  });

  it("Write.execute returns an Error string (not a throw) when target is a directory; dir stays intact", async () => {
    const { ctx, kernel } = makeCtx({ "/d/keep.txt": "orig" });
    const tools = createTools(ctx);
    const out = await tools.Write.execute!({ file_path: "/d", content: "x" }, callOpts);
    expect(out).toMatch(/^Error:/);
    // Directory and its contents are untouched.
    expect((await kernel.sys.stat("/d")).kind).toBe("dir");
    expect(await readBack(kernel, "/d/keep.txt")).toBe("orig");
  });

  it("Grep.execute files_with_matches output is lexicographically sorted", async () => {
    const { ctx } = makeCtx({
      "/m.txt": "hit\n",
      "/a/early.txt": "hit\n",
      "/z/late.txt": "hit\n",
    });
    const tools = createTools(ctx);
    const out = await tools.Grep.execute!(
      { pattern: "hit", output_mode: "files_with_matches" },
      callOpts,
    );
    expect(out).toBe("/a/early.txt\n/m.txt\n/z/late.txt");
  });

  it("Read.execute returns a string (not a throw) on a directory path", async () => {
    const { ctx } = makeCtx({ "/d/keep.txt": "orig" });
    const tools = createTools(ctx);
    const out = await tools.Read.execute!({ file_path: "/d" }, callOpts);
    expect(typeof out).toBe("string");
    expect(out).toContain("directory");
  });

  it("Bash.execute returns a string (not a throw) on a failing command", async () => {
    const { ctx } = makeCtx();
    const tools = createTools(ctx);
    const out = await tools.Bash.execute!({ command: "cat /does/not/exist" }, callOpts);
    expect(typeof out).toBe("string");
  });
});
