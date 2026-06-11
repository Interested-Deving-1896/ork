import { expect, test } from "vitest";
import { Workspace, WorkspaceConflictError } from "../src/workspace/workspace.js";
import { MemoryPointerStore } from "../src/workspace/pointer-store.js";
import { MemorySnapshotStore } from "../src/snapshot/store.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function stores() {
  return { store: new MemorySnapshotStore(), pointers: new MemoryPointerStore() };
}

test("open on unknown id → empty workspace (or seeded)", async () => {
  const s = stores();
  const ws = await Workspace.open({ id: "u1", ...s, seed: { "/workspace/hello.txt": "hi" } });
  expect(dec.decode(await ws.kernel.sys.readFile("/workspace/hello.txt"))).toBe("hi");
});

test("commit → pointer advances; reopen sees committed state", async () => {
  const s = stores();
  const ws1 = await Workspace.open({ id: "u1", ...s });
  await ws1.kernel.sys.mkdir("/workspace", { recursive: true });
  await ws1.kernel.sys.writeFile("/workspace/a.txt", "v1");
  const { snapshotId } = await ws1.commit();
  expect(snapshotId).toMatch(/^[0-9a-f]{64}$/);
  expect(await s.pointers.get("u1")).toEqual({ snapshotId, version: 1 });

  const ws2 = await Workspace.open({ id: "u1", ...s });
  expect(dec.decode(await ws2.kernel.sys.readFile("/workspace/a.txt"))).toBe("v1");
});

test("successive commits chain versions and lineage", async () => {
  const s = stores();
  const ws = await Workspace.open({ id: "u1", ...s });
  await ws.kernel.sys.writeFile("/a.txt", "1");
  const c1 = await ws.commit();
  await ws.kernel.sys.writeFile("/a.txt", "2");
  const c2 = await ws.commit();
  expect((await s.pointers.get("u1"))!.version).toBe(2);
  // lineage : le manifest du 2e commit référence le 1er comme parent
  const manifest = await s.store.getTree(c2.snapshotId);
  expect(manifest?.meta).toMatchObject({ workspace: { id: "u1", parent: c1.snapshotId } });
});

test("two open workspaces on the same id: second commit → WorkspaceConflictError", async () => {
  const s = stores();
  const seedWs = await Workspace.open({ id: "u1", ...s, seed: { "/base.txt": "b" } });
  await seedWs.commit();

  const a = await Workspace.open({ id: "u1", ...s });
  const b = await Workspace.open({ id: "u1", ...s });
  await a.kernel.sys.writeFile("/from-a.txt", "a");
  await b.kernel.sys.writeFile("/from-b.txt", "b");
  await a.commit(); // gagne
  await expect(b.commit()).rejects.toBeInstanceOf(WorkspaceConflictError);
  // l'état gagnant est celui de a (vfs.exists est synchrone)
  const ws = await Workspace.open({ id: "u1", ...s });
  expect(ws.kernel.vfs.exists("/from-a.txt")).toBe(true);
  expect(ws.kernel.vfs.exists("/from-b.txt")).toBe(false);
});

test("workspaces of different ids are isolated", async () => {
  const s = stores();
  const u = await Workspace.open({ id: "u1", ...s });
  await u.kernel.sys.writeFile("/secret.txt", "u1 only");
  await u.commit();
  const v = await Workspace.open({ id: "u2", ...s });
  expect(v.kernel.vfs.exists("/secret.txt")).toBe(false);
});

test("kernel config (mounts/limits) is applied at open", async () => {
  const s = stores();
  const seedWs = await Workspace.open({ id: "u1", ...s, seed: { "/ro/doc.md": "x" } });
  await seedWs.commit();
  const ws = await Workspace.open({ id: "u1", ...s, mounts: [{ path: "/ro", mode: "ro" }] });
  await expect(ws.kernel.sys.writeFile("/ro/nope.txt", "x")).rejects.toMatchObject({
    code: "EACCES",
  });
});
