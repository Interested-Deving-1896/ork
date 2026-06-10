import { describe, expect, it } from "vitest";
import { editFileTool, EditError } from "../src/index.js";
import { makeCtx, readBack } from "./helpers.js";

describe("Edit", () => {
  it("replaces a unique occurrence and writes back", async () => {
    const { ctx, kernel } = makeCtx({ "/a.txt": "hello world" });
    const res = await editFileTool({ file_path: "/a.txt", old_string: "world", new_string: "ork" }, ctx);
    expect(res.replacements).toBe(1);
    expect(await readBack(kernel, "/a.txt")).toBe("hello ork");
  });

  it("errors when old_string is not found", async () => {
    const { ctx } = makeCtx({ "/a.txt": "abc" });
    await expect(
      editFileTool({ file_path: "/a.txt", old_string: "xyz", new_string: "q" }, ctx),
    ).rejects.toThrow(/not found/);
  });

  it("errors when old_string is not unique without replace_all", async () => {
    const { ctx } = makeCtx({ "/a.txt": "a a a" });
    await expect(
      editFileTool({ file_path: "/a.txt", old_string: "a", new_string: "b" }, ctx),
    ).rejects.toThrow(/not unique \(3 occurrences\)/);
  });

  it("replaces all occurrences with replace_all and counts them", async () => {
    const { ctx, kernel } = makeCtx({ "/a.txt": "a a a" });
    const res = await editFileTool(
      { file_path: "/a.txt", old_string: "a", new_string: "b", replace_all: true },
      ctx,
    );
    expect(res.replacements).toBe(3);
    expect(await readBack(kernel, "/a.txt")).toBe("b b b");
  });

  it("errors when old_string equals new_string", async () => {
    const { ctx } = makeCtx({ "/a.txt": "x" });
    await expect(
      editFileTool({ file_path: "/a.txt", old_string: "x", new_string: "x" }, ctx),
    ).rejects.toThrow(/identical/);
  });

  it("errors on a missing file", async () => {
    const { ctx } = makeCtx();
    await expect(
      editFileTool({ file_path: "/nope.txt", old_string: "a", new_string: "b" }, ctx),
    ).rejects.toThrow(/does not exist/);
  });

  it("throws EditError instances for callers to branch on", async () => {
    const { ctx } = makeCtx({ "/a.txt": "abc" });
    await expect(
      editFileTool({ file_path: "/a.txt", old_string: "z", new_string: "q" }, ctx),
    ).rejects.toBeInstanceOf(EditError);
  });

  it("replaces only the first occurrence by default semantics check", async () => {
    const { ctx, kernel } = makeCtx({ "/a.txt": "one TWO three TWO" });
    // "TWO" appears twice → not unique without replace_all
    await expect(
      editFileTool({ file_path: "/a.txt", old_string: "TWO", new_string: "2" }, ctx),
    ).rejects.toThrow(/not unique/);
    // With enough context the match is unique:
    const res = await editFileTool(
      { file_path: "/a.txt", old_string: "one TWO", new_string: "one 2" },
      ctx,
    );
    expect(res.replacements).toBe(1);
    expect(await readBack(kernel, "/a.txt")).toBe("one 2 three TWO");
  });
});
