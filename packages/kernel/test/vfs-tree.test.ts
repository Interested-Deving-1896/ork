import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function seeded() {
  const vfs = new Vfs({ now: () => 1 });
  vfs.mkdir("/work");
  vfs.mkdir("/work/sub");
  vfs.writeFile("/work/a.txt", enc.encode("aa"));
  vfs.writeFile("/work/sub/b.txt", enc.encode("bbbb"));
  return vfs;
}

test("readdir lists direct children, sorted", () => {
  const vfs = seeded();
  expect(vfs.readdir("/work")).toEqual(["a.txt", "sub"]);
  expect(vfs.readdir("/")).toEqual(["work"]);
});

test("readdir on a file → ENOTDIR", () => {
  const vfs = seeded();
  expect(() => vfs.readdir("/work/a.txt")).toThrowError(/ENOTDIR/);
});

test("rm file, rm dir requires recursive when non-empty", () => {
  const vfs = seeded();
  vfs.rm("/work/a.txt");
  expect(vfs.exists("/work/a.txt")).toBe(false);
  expect(() => vfs.rm("/work")).toThrowError(/ENOTEMPTY/);
  vfs.rm("/work", { recursive: true });
  expect(vfs.exists("/work")).toBe(false);
  expect(vfs.exists("/work/sub/b.txt")).toBe(false);
});

test("rm / is forbidden", () => {
  const vfs = seeded();
  expect(() => vfs.rm("/")).toThrowError(/EINVAL/);
});

test("rename moves a file", async () => {
  const vfs = seeded();
  vfs.rename("/work/a.txt", "/work/c.txt");
  expect(vfs.exists("/work/a.txt")).toBe(false);
  expect(dec.decode(await vfs.readFile("/work/c.txt"))).toBe("aa");
});

test("rename moves a whole subtree", async () => {
  const vfs = seeded();
  vfs.rename("/work", "/done");
  expect(dec.decode(await vfs.readFile("/done/sub/b.txt"))).toBe("bbbb");
  expect(vfs.exists("/work")).toBe(false);
});

test("totalBytes sums file sizes", () => {
  const vfs = seeded();
  expect(vfs.totalBytes()).toBe(6); // "aa" + "bbbb"
});

test("rename into own subtree → EINVAL", () => {
  const vfs = seeded();
  expect(() => vfs.rename("/work", "/work/sub")).toThrowError(/EINVAL/);
  expect(() => vfs.rename("/work", "/work/sub/deep")).toThrowError(/EINVAL/);
  // l'arbre est intact
  expect(vfs.exists("/work/a.txt")).toBe(true);
  expect(vfs.exists("/work/sub/b.txt")).toBe(true);
});

test("rename onto existing dir → EEXIST", () => {
  const vfs = seeded();
  vfs.mkdir("/other");
  expect(() => vfs.rename("/work", "/other")).toThrowError(/EEXIST/);
});

test("rename dir onto existing file → ENOTDIR", () => {
  const vfs = seeded();
  expect(() => vfs.rename("/work/sub", "/work/a.txt")).toThrowError(/ENOTDIR/);
});

test("rename file onto existing file overwrites", async () => {
  const vfs = seeded();
  vfs.writeFile("/work/target.txt", enc.encode("old"));
  vfs.rename("/work/a.txt", "/work/target.txt");
  expect(dec.decode(await vfs.readFile("/work/target.txt"))).toBe("aa");
  expect(vfs.exists("/work/a.txt")).toBe(false);
});

test("self-rename is a no-op", async () => {
  const vfs = seeded();
  vfs.rename("/work/a.txt", "/work/a.txt");
  expect(dec.decode(await vfs.readFile("/work/a.txt"))).toBe("aa");
});
