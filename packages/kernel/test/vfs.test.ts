import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";
import { KernelError } from "../src/errors.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeVfs() {
  let t = 1000;
  return new Vfs({ now: () => t++ });
}

test("write then read round-trip", async () => {
  const vfs = makeVfs();
  vfs.writeFile("/a.txt", enc.encode("hello"));
  expect(dec.decode(await vfs.readFile("/a.txt"))).toBe("hello");
});

test("read missing file → ENOENT", async () => {
  const vfs = makeVfs();
  await expect(vfs.readFile("/nope")).rejects.toMatchObject({ code: "ENOENT" });
});

test("read a directory → EISDIR", async () => {
  const vfs = makeVfs();
  vfs.mkdir("/d");
  await expect(vfs.readFile("/d")).rejects.toMatchObject({ code: "EISDIR" });
});

test("write requires existing parent dir", () => {
  const vfs = makeVfs();
  expect(() => vfs.writeFile("/no/such/file.txt", enc.encode("x"))).toThrowError(KernelError);
});

test("write over a directory → EISDIR", () => {
  const vfs = makeVfs();
  vfs.mkdir("/d");
  expect(() => vfs.writeFile("/d", enc.encode("x"))).toThrowError(/EISDIR/);
});

test("stat reports kind, size, mtime", () => {
  const vfs = makeVfs();
  vfs.writeFile("/a.txt", enc.encode("hello"));
  const s = vfs.stat("/a.txt");
  expect(s.kind).toBe("file");
  expect(s.size).toBe(5);
  expect(s.mtime).toBeGreaterThan(0);
  expect(vfs.stat("/").kind).toBe("dir");
});

test("exists", () => {
  const vfs = makeVfs();
  expect(vfs.exists("/")).toBe(true);
  expect(vfs.exists("/a")).toBe(false);
});
