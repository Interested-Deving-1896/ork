import { expect, test } from "vitest";
import { normalizePath, parentOf, basename } from "../src/path.js";
import { KernelError } from "../src/errors.js";

test("normalizePath canonicalizes", () => {
  expect(normalizePath("/a/b/../c")).toBe("/a/c");
  expect(normalizePath("/a//b/./c/")).toBe("/a/b/c");
  expect(normalizePath("/")).toBe("/");
});

test("relative paths resolve against cwd", () => {
  expect(normalizePath("b.txt", "/work")).toBe("/work/b.txt");
  expect(normalizePath("../x", "/work/sub")).toBe("/work/x");
});

test(".. clamps at root, never escapes", () => {
  expect(normalizePath("/../../etc/passwd")).toBe("/etc/passwd");
  expect(normalizePath("../../..", "/a")).toBe("/");
});

test("null byte rejected with EINVAL", () => {
  expect(() => normalizePath("/a\0b")).toThrowError(KernelError);
  try {
    normalizePath("/a\0b");
  } catch (e) {
    expect((e as KernelError).code).toBe("EINVAL");
  }
});

test("parentOf and basename", () => {
  expect(parentOf("/a/b/c")).toBe("/a/b");
  expect(parentOf("/a")).toBe("/");
  expect(basename("/a/b.txt")).toBe("b.txt");
  expect(basename("/")).toBe("/");
});
