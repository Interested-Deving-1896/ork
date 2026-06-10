import { describe, expect, it } from "vitest";
import { grepTool } from "../src/index.js";
import { makeCtx } from "./helpers.js";

describe("Grep", () => {
  const files = {
    "/a.ts": "import x\nconst foo = 1\nexport foo\n",
    "/b.ts": "const bar = 2\n",
    "/c.md": "foo appears here\nand FOO too\n",
    "/sub/d.ts": "foo nested\n",
  };

  it("defaults to files_with_matches mode", async () => {
    const { ctx } = makeCtx(files);
    const res = await grepTool({ pattern: "foo" }, ctx);
    expect(res.files).toEqual(["/a.ts", "/c.md", "/sub/d.ts"]);
    expect(res.output).toBe("/a.ts\n/c.md\n/sub/d.ts");
  });

  it("content mode shows matching lines prefixed with file", async () => {
    const { ctx } = makeCtx(files);
    const res = await grepTool({ pattern: "bar", output_mode: "content" }, ctx);
    expect(res.output).toBe("/b.ts:const bar = 2");
    expect(res.matchCount).toBe(1);
  });

  it("content mode with line numbers", async () => {
    const { ctx } = makeCtx(files);
    const res = await grepTool(
      { pattern: "export", output_mode: "content", line_numbers: true },
      ctx,
    );
    expect(res.output).toBe("/a.ts:3:export foo");
  });

  it("count mode reports per-file counts", async () => {
    const { ctx } = makeCtx(files);
    const res = await grepTool({ pattern: "foo", output_mode: "count" }, ctx);
    expect(res.output).toBe("/a.ts:2\n/c.md:1\n/sub/d.ts:1");
  });

  it("case-insensitive matches both cases", async () => {
    const { ctx } = makeCtx(files);
    const res = await grepTool(
      { pattern: "foo", path: "/c.md", output_mode: "count", case_insensitive: true },
      ctx,
    );
    expect(res.output).toBe("/c.md:2");
  });

  it("glob filter restricts file set", async () => {
    const { ctx } = makeCtx(files);
    const res = await grepTool({ pattern: "foo", glob: "*.md" }, ctx);
    expect(res.files).toEqual(["/c.md"]);
  });

  it("supports regex patterns", async () => {
    const { ctx } = makeCtx(files);
    const res = await grepTool({ pattern: "^const \\w+ = \\d", output_mode: "content" }, ctx);
    expect(res.output).toBe("/a.ts:const foo = 1\n/b.ts:const bar = 2");
  });

  it("context lines included in content mode", async () => {
    const { ctx } = makeCtx({ "/x.txt": "l1\nl2\nMATCH\nl4\nl5\n" });
    const res = await grepTool(
      { pattern: "MATCH", output_mode: "content", context: 1 },
      ctx,
    );
    expect(res.output).toBe("/x.txt:l2\n/x.txt:MATCH\n/x.txt:l4");
  });

  it("returns 'No matches found' when nothing matches", async () => {
    const { ctx } = makeCtx(files);
    const res = await grepTool({ pattern: "zzz" }, ctx);
    expect(res.output).toBe("No matches found");
    expect(res.matchCount).toBe(0);
  });

  it("searches a single file when path is a file", async () => {
    const { ctx } = makeCtx(files);
    const res = await grepTool({ pattern: "foo", path: "/a.ts", output_mode: "count" }, ctx);
    expect(res.output).toBe("/a.ts:2");
  });

  it("skips binary files", async () => {
    const { ctx } = makeCtx({ "/bin": new Uint8Array([102, 111, 111, 0]), "/t.txt": "foo\n" });
    const res = await grepTool({ pattern: "foo" }, ctx);
    expect(res.files).toEqual(["/t.txt"]);
  });
});
