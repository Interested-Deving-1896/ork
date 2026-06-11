import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPointerStore, type PointerStore } from "../src/workspace/pointer-store.js";
import { DiskPointerStore } from "../src/workspace/disk-pointer-store.js";

function suite(name: string, make: () => Promise<{ store: PointerStore; cleanup(): Promise<void> }>) {
  test(`${name}: get on unknown id → null`, async () => {
    const { store, cleanup } = await make();
    try {
      expect(await store.get("u1")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test(`${name}: first set requires expectedVersion 0`, async () => {
    const { store, cleanup } = await make();
    try {
      expect(await store.set("u1", { snapshotId: "a", version: 1 }, 0)).toBe(true);
      expect(await store.get("u1")).toEqual({ snapshotId: "a", version: 1 });
      // re-création avec expectedVersion 0 alors que v1 existe → refus
      expect(await store.set("u1", { snapshotId: "b", version: 1 }, 0)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: CAS advances only from the expected version`, async () => {
    const { store, cleanup } = await make();
    try {
      await store.set("u1", { snapshotId: "a", version: 1 }, 0);
      expect(await store.set("u1", { snapshotId: "b", version: 2 }, 1)).toBe(true);
      // un écrivain retardataire qui croit encore être en v1 → refus
      expect(await store.set("u1", { snapshotId: "c", version: 2 }, 1)).toBe(false);
      expect(await store.get("u1")).toEqual({ snapshotId: "b", version: 2 });
    } finally {
      await cleanup();
    }
  });

  test(`${name}: ids are isolated`, async () => {
    const { store, cleanup } = await make();
    try {
      await store.set("u1", { snapshotId: "a", version: 1 }, 0);
      expect(await store.get("u2")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test(`${name}: concurrent CAS — exactly one winner`, async () => {
    const { store, cleanup } = await make();
    try {
      await store.set("u1", { snapshotId: "base", version: 1 }, 0);
      const results = await Promise.all([
        store.set("u1", { snapshotId: "x", version: 2 }, 1),
        store.set("u1", { snapshotId: "y", version: 2 }, 1),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
}

suite("memory", async () => ({ store: new MemoryPointerStore(), cleanup: async () => {} }));

suite("disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-ptr-"));
  return {
    store: new DiskPointerStore(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

test("disk: unsafe id rejected with EINVAL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-ptr-"));
  try {
    const store = new DiskPointerStore(dir);
    await expect(store.get("../evil")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.set("a/b", { snapshotId: "x", version: 1 }, 0)).rejects.toMatchObject({
      code: "EINVAL",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disk: pointer survives a new store instance (restart)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-ptr-"));
  try {
    const a = new DiskPointerStore(dir);
    await a.set("u1", { snapshotId: "s1", version: 1 }, 0);
    const b = new DiskPointerStore(dir); // « redémarrage »
    expect(await b.get("u1")).toEqual({ snapshotId: "s1", version: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
