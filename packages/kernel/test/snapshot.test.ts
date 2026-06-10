import { expect, test, vi } from "vitest";
import { Vfs } from "../src/vfs.js";
import { MemorySnapshotStore } from "../src/snapshot/store.js";
import { snapshotVfs, restoreVfs } from "../src/snapshot/snapshot.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function seeded() {
  const vfs = new Vfs({ now: () => 1 });
  vfs.mkdir("/work");
  vfs.writeFile("/work/a.txt", enc.encode("alpha"));
  vfs.writeFile("/work/b.txt", enc.encode("beta"));
  return vfs;
}

test("snapshot then restore yields identical content", async () => {
  const store = new MemorySnapshotStore();
  const { snapshotId } = await snapshotVfs(seeded(), store, { meta: { turn: 1 } });
  const { vfs: restored, meta } = await restoreVfs(store, snapshotId, { now: () => 2 });
  expect(dec.decode(await restored.readFile("/work/a.txt"))).toBe("alpha");
  expect(restored.readdir("/work")).toEqual(["a.txt", "b.txt"]);
  expect(meta).toEqual({ turn: 1 });
});

test("same FS content → same snapshotId (deterministic, content-addressed)", async () => {
  const s1 = await snapshotVfs(seeded(), new MemorySnapshotStore());
  const s2 = await snapshotVfs(seeded(), new MemorySnapshotStore());
  expect(s1.snapshotId).toBe(s2.snapshotId);
});

test("incremental: unchanged blobs are not re-uploaded", async () => {
  const store = new MemorySnapshotStore();
  const putBlob = vi.spyOn(store, "putBlob");
  const vfs = seeded();
  await snapshotVfs(vfs, store);
  expect(putBlob).toHaveBeenCalledTimes(2); // a.txt + b.txt
  putBlob.mockClear();
  vfs.writeFile("/work/c.txt", enc.encode("gamma"));
  await snapshotVfs(vfs, store);
  expect(putBlob).toHaveBeenCalledTimes(1); // seulement c.txt
});

test("restore is lazy: blobs fetched only on first read; stat needs no fetch", async () => {
  const store = new MemorySnapshotStore();
  const { snapshotId } = await snapshotVfs(seeded(), store);
  const getBlob = vi.spyOn(store, "getBlob");
  const { vfs: restored } = await restoreVfs(store, snapshotId);
  expect(getBlob).not.toHaveBeenCalled();
  expect(restored.stat("/work/a.txt").size).toBe(5); // taille depuis le manifest
  expect(getBlob).not.toHaveBeenCalled();
  await restored.readFile("/work/a.txt");
  expect(getBlob).toHaveBeenCalledTimes(1);
  await restored.readFile("/work/a.txt"); // hydraté : pas de re-fetch
  expect(getBlob).toHaveBeenCalledTimes(1);
});

test("snapshot of a restored-lazy vfs reuses hashes without hydrating", async () => {
  const store = new MemorySnapshotStore();
  const { snapshotId } = await snapshotVfs(seeded(), store);
  const { vfs: restored } = await restoreVfs(store, snapshotId);
  const getBlob = vi.spyOn(store, "getBlob");
  const { snapshotId: again } = await snapshotVfs(restored, store);
  expect(again).toBe(snapshotId);
  expect(getBlob).not.toHaveBeenCalled();
});

test("restore unknown id → ENOENT", async () => {
  await expect(restoreVfs(new MemorySnapshotStore(), "nope")).rejects.toMatchObject({ code: "ENOENT" });
});
