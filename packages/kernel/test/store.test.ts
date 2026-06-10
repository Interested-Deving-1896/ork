import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/snapshot/hash.js";
import { MemorySnapshotStore, type SnapshotManifest } from "../src/snapshot/store.js";
import { DiskSnapshotStore } from "../src/snapshot/disk-store.js";

const enc = new TextEncoder();

test("sha256Hex is deterministic and matches known vector", async () => {
  // echo -n "abc" | shasum -a 256
  expect(await sha256Hex(enc.encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

const manifest: SnapshotManifest = {
  version: 1,
  entries: { "/a.txt": { kind: "file", hash: "h1", size: 2, mtime: 1 } },
  meta: { turn: 3 },
};

test("MemorySnapshotStore blob + tree round-trip", async () => {
  const store = new MemorySnapshotStore();
  expect(await store.hasBlob("h1")).toBe(false);
  expect(await store.getBlob("h1")).toBeNull();
  await store.putBlob("h1", enc.encode("hi"));
  expect(await store.hasBlob("h1")).toBe(true);
  expect(new TextDecoder().decode((await store.getBlob("h1"))!)).toBe("hi");
  await store.putTree("snap1", manifest);
  expect(await store.getTree("snap1")).toEqual(manifest);
  expect(await store.getTree("nope")).toBeNull();
});

test("DiskSnapshotStore blob + tree round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-store-"));
  try {
    const store = new DiskSnapshotStore(dir);
    await store.putBlob("h1", enc.encode("hi"));
    expect(await store.hasBlob("h1")).toBe(true);
    expect(await store.getBlob("h2")).toBeNull();
    expect(new TextDecoder().decode((await store.getBlob("h1"))!)).toBe("hi");
    await store.putTree("snap1", manifest);
    expect(await store.getTree("snap1")).toEqual(manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DiskSnapshotStore rejects traversal-shaped ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-store-"));
  try {
    const store = new DiskSnapshotStore(dir);
    await expect(store.putBlob("../evil", enc.encode("x"))).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.getBlob("a/b")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.putTree("../../tree", { version: 1, entries: {} })).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.getTree("..")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.hasBlob("with space")).rejects.toMatchObject({ code: "EINVAL" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DiskSnapshotStore surfaces corruption instead of returning null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-store-"));
  try {
    const store = new DiskSnapshotStore(dir);
    await store.putTree("snap1", { version: 1, entries: {} });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(dir, "trees", "snap1.json"), "{corrupt");
    await expect(store.getTree("snap1")).rejects.toThrow();
    expect(await store.getTree("missing")).toBeNull(); // ENOENT reste null
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
