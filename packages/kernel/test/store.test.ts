import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/snapshot/hash.js";
import { MemorySnapshotStore, isListable, type SnapshotManifest } from "../src/snapshot/store.js";
import { DiskSnapshotStore } from "../src/snapshot/disk-store.js";
import { snapshotVfs } from "../src/snapshot/snapshot.js";
import { gcSnapshots } from "../src/snapshot/gc.js";
import { Vfs } from "../src/vfs.js";

async function collect(it: AsyncIterable<string>): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const x of it) out.add(x);
  return out;
}

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

test("isListable: Memory + Disk stores are listable", async () => {
  expect(isListable(new MemorySnapshotStore())).toBe(true);
  const dir = await mkdtemp(join(tmpdir(), "ork-store-"));
  try {
    expect(isListable(new DiskSnapshotStore(dir))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // Un store sans les méthodes de listing n'est pas listable.
  const bare = { putBlob() {}, getBlob() {}, hasBlob() {}, putTree() {}, getTree() {} };
  expect(isListable(bare as never)).toBe(false);
});

test("DiskSnapshotStore listing on empty store yields nothing (no dirs yet)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-store-"));
  try {
    const store = new DiskSnapshotStore(dir);
    expect(await collect(store.listTrees())).toEqual(new Set());
    expect(await collect(store.listBlobs())).toEqual(new Set());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DiskSnapshotStore listTrees/listBlobs + delete (ENOENT tolerated)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-store-"));
  try {
    const store = new DiskSnapshotStore(dir);
    await store.putBlob("h1", enc.encode("a"));
    await store.putBlob("h2", enc.encode("b"));
    await store.putTree("t1", { version: 1, entries: {} });
    await store.putTree("t2", { version: 1, entries: {} });

    expect(await collect(store.listTrees())).toEqual(new Set(["t1", "t2"]));
    expect(await collect(store.listBlobs())).toEqual(new Set(["h1", "h2"]));

    await store.deleteTree("t1");
    await store.deleteBlob("h2");
    await store.deleteTree("t1"); // re-delete → no-op
    await store.deleteBlob("nope"); // absent → no-op

    expect(await collect(store.listTrees())).toEqual(new Set(["t2"]));
    expect(await collect(store.listBlobs())).toEqual(new Set(["h1"]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gcSnapshots end-to-end over DiskSnapshotStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-store-"));
  try {
    const store = new DiskSnapshotStore(dir);

    // Arbre vivant : keep.txt (blob partagé) + live.txt.
    const live = new Vfs({ now: () => 1 });
    live.writeFile("/keep.txt", enc.encode("keep"));
    live.writeFile("/live.txt", enc.encode("live"));
    const { snapshotId: liveId } = await snapshotVfs(live, store);

    // Arbre mort : keep.txt (même blob) + dead.txt (blob unique).
    const dead = new Vfs({ now: () => 1 });
    dead.writeFile("/keep.txt", enc.encode("keep"));
    dead.writeFile("/dead.txt", enc.encode("dead"));
    await snapshotVfs(dead, store);

    const res = await gcSnapshots(store, { roots: [liveId] });
    expect(res.keptTrees).toBe(1);
    expect(res.deletedTrees).toBe(1);

    expect(await collect(store.listTrees())).toEqual(new Set([liveId]));
    const blobs = await collect(store.listBlobs());
    expect(blobs.has(await sha256Hex(enc.encode("keep")))).toBe(true);
    expect(blobs.has(await sha256Hex(enc.encode("live")))).toBe(true);
    expect(blobs.has(await sha256Hex(enc.encode("dead")))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
