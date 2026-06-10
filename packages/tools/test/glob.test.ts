import { describe, expect, it } from "vitest";
import { globTool, globToRegExp } from "../src/index.js";
import { makeCtx } from "./helpers.js";

describe("globToRegExp", () => {
  it("matches * within a segment but not across /", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("sub/a.ts")).toBe(false);
  });

  it("matches ** across directories", () => {
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("x/y/a.ts")).toBe(true);
  });

  it("matches ? as a single non-slash char", () => {
    expect(globToRegExp("a?.txt").test("ab.txt")).toBe(true);
    expect(globToRegExp("a?.txt").test("a/.txt")).toBe(false);
  });

  it("matches character classes", () => {
    expect(globToRegExp("f[0-9].txt").test("f3.txt")).toBe(true);
    expect(globToRegExp("f[!0-9].txt").test("f3.txt")).toBe(false);
    expect(globToRegExp("f[!0-9].txt").test("fa.txt")).toBe(true);
  });
});

describe("Glob", () => {
  const files = {
    "/src/a.ts": "1",
    "/src/b.ts": "2",
    "/src/nested/c.ts": "3",
    "/src/readme.md": "4",
    "/top.txt": "5",
  };

  it("matches **/*.ts recursively", async () => {
    const { ctx } = makeCtx(files);
    const res = await globTool({ pattern: "**/*.ts" }, ctx);
    expect(res.matches).toEqual(["/src/a.ts", "/src/b.ts", "/src/nested/c.ts"]);
  });

  it("matches *.txt flat from root", async () => {
    const { ctx } = makeCtx(files);
    const res = await globTool({ pattern: "*.txt" }, ctx);
    expect(res.matches).toEqual(["/top.txt"]);
  });

  it("searches under an explicit path", async () => {
    const { ctx } = makeCtx(files);
    const res = await globTool({ pattern: "*.ts", path: "/src" }, ctx);
    expect(res.matches).toEqual(["/src/a.ts", "/src/b.ts"]);
  });

  it("matches in a subdir via prefix", async () => {
    const { ctx } = makeCtx(files);
    const res = await globTool({ pattern: "src/nested/*.ts" }, ctx);
    expect(res.matches).toEqual(["/src/nested/c.ts"]);
  });

  it("returns 'No files found' on no match", async () => {
    const { ctx } = makeCtx(files);
    const res = await globTool({ pattern: "**/*.py" }, ctx);
    expect(res.matches).toEqual([]);
    expect(res.output).toBe("No files found");
  });

  it("results are sorted by path", async () => {
    const { ctx } = makeCtx(files);
    const res = await globTool({ pattern: "**/*.ts" }, ctx);
    expect(res.output).toBe("/src/a.ts\n/src/b.ts\n/src/nested/c.ts");
  });
});
