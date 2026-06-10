import { describe, expect, it } from "vitest";
import { writeFileTool } from "../src/index.js";
import { makeCtx, readBack } from "./helpers.js";

describe("Write", () => {
  it("creates a new file and reports created", async () => {
    const { ctx, kernel } = makeCtx();
    const res = await writeFileTool({ file_path: "/a.txt", content: "hello" }, ctx);
    expect(res.created).toBe(true);
    expect(res.output).toContain("created");
    expect(await readBack(kernel, "/a.txt")).toBe("hello");
  });

  it("creates missing parent directories", async () => {
    const { ctx, kernel } = makeCtx();
    const res = await writeFileTool({ file_path: "/deep/nested/dir/f.txt", content: "x" }, ctx);
    expect(res.created).toBe(true);
    expect(await readBack(kernel, "/deep/nested/dir/f.txt")).toBe("x");
    const stat = await kernel.sys.stat("/deep/nested/dir");
    expect(stat.kind).toBe("dir");
  });

  it("overwrites an existing file and reports updated", async () => {
    const { ctx, kernel } = makeCtx({ "/a.txt": "old" });
    const res = await writeFileTool({ file_path: "/a.txt", content: "new" }, ctx);
    expect(res.created).toBe(false);
    expect(res.output).toContain("updated");
    expect(await readBack(kernel, "/a.txt")).toBe("new");
  });

  it("resolves relative paths against cwd", async () => {
    const { ctx, kernel } = makeCtx({}, "/work");
    await writeFileTool({ file_path: "out.txt", content: "rel" }, ctx);
    expect(await readBack(kernel, "/work/out.txt")).toBe("rel");
  });

  it("rejects writing over a directory", async () => {
    const { ctx } = makeCtx({ "/dir/f": "x" });
    await expect(writeFileTool({ file_path: "/dir", content: "y" }, ctx)).rejects.toThrow();
  });
});
