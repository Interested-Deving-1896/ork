import { describe, expect, it } from "vitest";
import { readFileTool } from "../src/index.js";
import { makeCtx } from "./helpers.js";

describe("Read", () => {
  it("renders cat -n style with 6-wide line numbers + tab", async () => {
    const { ctx } = makeCtx({ "/a.txt": "alpha\nbeta\ngamma\n" });
    const res = await readFileTool({ file_path: "/a.txt" }, ctx);
    expect(res.output).toBe("     1\talpha\n     2\tbeta\n     3\tgamma");
    expect(res.note).toBeUndefined();
  });

  it("handles a file without a trailing newline", async () => {
    const { ctx } = makeCtx({ "/a.txt": "one\ntwo" });
    const res = await readFileTool({ file_path: "/a.txt" }, ctx);
    expect(res.output).toBe("     1\tone\n     2\ttwo");
  });

  it("honors offset (1-based)", async () => {
    const { ctx } = makeCtx({ "/a.txt": "l1\nl2\nl3\nl4\n" });
    const res = await readFileTool({ file_path: "/a.txt", offset: 3 }, ctx);
    expect(res.output).toBe("     3\tl3\n     4\tl4");
  });

  it("honors limit", async () => {
    const { ctx } = makeCtx({ "/a.txt": "l1\nl2\nl3\nl4\n" });
    const res = await readFileTool({ file_path: "/a.txt", limit: 2 }, ctx);
    expect(res.output).toBe("     1\tl1\n     2\tl2");
  });

  it("honors offset + limit together", async () => {
    const { ctx } = makeCtx({ "/a.txt": "l1\nl2\nl3\nl4\nl5\n" });
    const res = await readFileTool({ file_path: "/a.txt", offset: 2, limit: 2 }, ctx);
    expect(res.output).toBe("     2\tl2\n     3\tl3");
  });

  it("resolves relative paths against cwd", async () => {
    const { ctx } = makeCtx({ "/sub/x.txt": "hi\n" }, "/sub");
    const res = await readFileTool({ file_path: "x.txt" }, ctx);
    expect(res.output).toBe("     1\thi");
  });

  it("returns a clear message for a missing file", async () => {
    const { ctx } = makeCtx();
    const res = await readFileTool({ file_path: "/nope.txt" }, ctx);
    expect(res.output).toBe("File does not exist.");
    expect(res.note).toBe("missing");
  });

  it("errors on a directory", async () => {
    const { ctx } = makeCtx({ "/dir/f.txt": "x" });
    const res = await readFileTool({ file_path: "/dir" }, ctx);
    expect(res.note).toBe("directory");
    expect(res.output).toContain("directory");
  });

  it("notes an empty file", async () => {
    const { ctx } = makeCtx({ "/empty.txt": "" });
    const res = await readFileTool({ file_path: "/empty.txt" }, ctx);
    expect(res.note).toBe("empty");
    expect(res.output).toContain("empty");
  });

  it("detects binary files (NUL bytes)", async () => {
    const { ctx } = makeCtx({ "/bin": new Uint8Array([1, 2, 0, 3]) });
    const res = await readFileTool({ file_path: "/bin" }, ctx);
    expect(res.output).toBe("[binary file]");
    expect(res.note).toBe("binary");
  });
});
