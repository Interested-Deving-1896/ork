import { expect, test } from "vitest";
import { MemorySnapshotStore } from "../src/snapshot/store.js";
import { MemoryPointerStore } from "../src/workspace/pointer-store.js";
import { Workspace, WorkspaceConflictError } from "../src/workspace/workspace.js";
import { gcSnapshots } from "../src/snapshot/gc.js";
import { restoreVfs } from "../src/snapshot/snapshot.js";
import { sha256Hex } from "../src/snapshot/hash.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Construit dans un MemorySnapshotStore :
 *  - lignée A → B → C (un workspace, 3 commits)
 *  - un orphelin O : commit perdant d'un CAS (deux opens du MÊME pointeur, les
 *    deux commitent ; le second perd → son snapshot reste orphelin dans le store).
 * Contenus choisis pour qu'un blob soit partagé entre C et un arbre mort (B),
 * et que d'autres blobs soient uniques à des arbres morts.
 */
async function buildWorld() {
  const store = new MemorySnapshotStore();
  const pointers = new MemoryPointerStore();

  // A : a.txt="shared-keep" + only-a.txt="dead-a"
  const ws = await Workspace.open({ id: "u1", store, pointers });
  await ws.kernel.sys.writeFile("/a.txt", "shared-keep");
  await ws.kernel.sys.writeFile("/only-a.txt", "dead-a");
  const a = (await ws.commit()).snapshotId;

  // B : a.txt unchanged (shared blob persists) + remove only-a, add only-b.txt="dead-b"
  await ws.kernel.sys.rm("/only-a.txt");
  await ws.kernel.sys.writeFile("/only-b.txt", "dead-b");
  const b = (await ws.commit()).snapshotId;

  // C : keep a.txt (shared with A & B) + drop only-b + add only-c.txt="live-c"
  await ws.kernel.sys.rm("/only-b.txt");
  await ws.kernel.sys.writeFile("/only-c.txt", "live-c");
  const c = (await ws.commit()).snapshotId;

  // Orphan O : deux opens du pointeur courant (version 3), les deux commitent.
  // Deux opens du même pointeur (version 3 = état C). Le gagnant repart de C +
  // y.txt (donc PAS de nouveau blob unique) → son arbre est superflu pour ce
  // test : on le neutralise en faisant gagner wsY, et perdre wsX. Pour rester
  // simple on garde un seul snapshot survivant à l'open : wsY commit en premier,
  // wsX perd → wsX est l'orphelin et le pointeur reste sur le snapshot de wsY.
  const wsWin = await Workspace.open({ id: "u1", store, pointers });
  const wsLose = await Workspace.open({ id: "u1", store, pointers });
  await wsWin.kernel.sys.writeFile("/win.txt", "winner");
  await wsLose.kernel.sys.writeFile("/y.txt", "orphan-y"); // blob unique à l'orphelin
  const winnerId = (await wsWin.commit()).snapshotId; // gagnant → avance le pointeur
  let orphan: string | null = null;
  try {
    await wsLose.commit(); // perdant : snapshot écrit MAIS pointeur inchangé
  } catch (err) {
    expect(err).toBeInstanceOf(WorkspaceConflictError);
  }
  // Le snapshot perdant existe : on le retrouve via listing — c'est le tree qui
  // contient y.txt (et pas win.txt).
  for await (const id of store.listTrees()) {
    const m = await store.getTree(id);
    if (m && "/y.txt" in m.entries) orphan = id;
  }
  expect(orphan).not.toBeNull();

  return { store, pointers, a, b, c, winner: winnerId, orphan: orphan! };
}

async function listTreeIds(store: MemorySnapshotStore): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const id of store.listTrees()) out.add(id);
  return out;
}
async function listBlobHashes(store: MemorySnapshotStore): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const h of store.listBlobs()) out.add(h);
  return out;
}

test("gc with roots=[C] deletes orphan + ancestor trees, keeps C", async () => {
  const { store, a, b, c, winner, orphan } = await buildWorld();

  const before = await listTreeIds(store);
  expect(before).toEqual(new Set([a, b, c, winner, orphan]));

  const res = await gcSnapshots(store, { roots: [c] });

  const after = await listTreeIds(store);
  expect(after).toEqual(new Set([c]));
  expect(res.keptTrees).toBe(1);
  expect(res.deletedTrees).toBe(4);

  // Blob "shared-keep" (a.txt, partagé A/B/C) survit ; uniques aux morts disparus.
  const blobs = await listBlobHashes(store);
  const sharedKeep = await sha256Hex(enc.encode("shared-keep"));
  const liveC = await sha256Hex(enc.encode("live-c"));
  const deadA = await sha256Hex(enc.encode("dead-a"));
  const deadB = await sha256Hex(enc.encode("dead-b"));
  const orphanY = await sha256Hex(enc.encode("orphan-y"));
  expect(blobs.has(sharedKeep)).toBe(true);
  expect(blobs.has(liveC)).toBe(true);
  expect(blobs.has(deadA)).toBe(false);
  expect(blobs.has(deadB)).toBe(false);
  expect(blobs.has(orphanY)).toBe(false);
});

test("keepLineageDepth=1 also keeps B (direct parent of C)", async () => {
  const { store, a, b, c, winner, orphan } = await buildWorld();
  await gcSnapshots(store, { roots: [c], keepLineageDepth: 1 });
  const after = await listTreeIds(store);
  expect(after).toEqual(new Set([b, c]));
  expect(after.has(a)).toBe(false);
  expect(after.has(winner)).toBe(false);
  expect(after.has(orphan)).toBe(false);
});

test("dryRun deletes nothing but reports the counts", async () => {
  const { store, a, b, c, winner, orphan } = await buildWorld();
  const before = await listTreeIds(store);
  const beforeBlobs = await listBlobHashes(store);

  const res = await gcSnapshots(store, { roots: [c], dryRun: true });
  expect(res.deletedTrees).toBe(4);
  expect(res.keptTrees).toBe(1);
  expect(res.deletedBlobs).toBeGreaterThan(0);

  expect(await listTreeIds(store)).toEqual(before);
  expect(await listBlobHashes(store)).toEqual(beforeBlobs);
  expect(before).toEqual(new Set([a, b, c, winner, orphan]));
});

test("empty roots + non-empty store → EINVAL", async () => {
  const { store } = await buildWorld();
  await expect(gcSnapshots(store, { roots: [] })).rejects.toMatchObject({ code: "EINVAL" });
});

test("force overrides the empty-roots guard and wipes everything", async () => {
  const { store } = await buildWorld();
  const res = await gcSnapshots(store, { roots: [], force: true });
  expect(res.keptTrees).toBe(0);
  expect(await listTreeIds(store)).toEqual(new Set());
  expect(await listBlobHashes(store)).toEqual(new Set());
});

test("restore of C still works after GC (integrity intact)", async () => {
  const { store, c } = await buildWorld();
  await gcSnapshots(store, { roots: [c] });
  const { vfs } = await restoreVfs(store, c);
  expect(dec.decode(await vfs.readFile("/a.txt"))).toBe("shared-keep");
  expect(dec.decode(await vfs.readFile("/only-c.txt"))).toBe("live-c");
});
