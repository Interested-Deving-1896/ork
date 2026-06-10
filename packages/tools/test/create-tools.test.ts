import { describe, expect, it } from "vitest";
import { createTools } from "../src/index.js";
import { makeCtx } from "./helpers.js";

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
});
