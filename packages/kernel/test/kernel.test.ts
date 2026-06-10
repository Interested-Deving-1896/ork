import { expect, test } from "vitest";
import { createKernel, restoreKernel } from "../src/kernel.js";
import { MemorySnapshotStore } from "../src/snapshot/store.js";
import { readText, writeAll } from "../src/streams.js";

const dec = new TextDecoder();

test("createKernel seeds files (string and bytes), creates parent dirs", async () => {
  const kernel = createKernel({
    files: { "/data/users.json": '[{"name":"Alice"}]', "/data/raw.bin": new Uint8Array([1, 2]) },
  });
  expect(dec.decode(await kernel.sys.readFile("/data/users.json"))).toBe('[{"name":"Alice"}]');
  expect((await kernel.sys.stat("/data/raw.bin")).size).toBe(2);
});

test("full pipeline: middlewares actifs (trace + permissions + quotas)", async () => {
  const kernel = createKernel({
    files: { "/ro/doc.md": "x" },
    mounts: [{ path: "/ro", mode: "ro" }],
    limits: { maxSyscallsPerTurn: 2 },
  });
  const events: unknown[] = [];
  kernel.events.subscribe((ev) => events.push(ev));
  await expect(kernel.sys.writeFile("/ro/y.txt", "y")).rejects.toMatchObject({ code: "EACCES" });
  expect(events).toContainEqual(
    expect.objectContaining({ type: "syscall", name: "writeFile", ok: false, code: "EACCES" }),
  );
  await kernel.sys.readFile("/ro/doc.md");
  await kernel.sys.readFile("/ro/doc.md");
  await expect(kernel.sys.readFile("/ro/doc.md")).rejects.toMatchObject({ code: "EQUOTA" });
  kernel.resetTurn();
  await expect(kernel.sys.readFile("/ro/doc.md")).resolves.toBeInstanceOf(Uint8Array);
});

test("procs wired to the same event bus", async () => {
  const kernel = createKernel();
  const events: unknown[] = [];
  kernel.events.subscribe((ev) => events.push(ev));
  const proc = kernel.procs.spawn(["echo"], async (io) => {
    await writeAll(io.stdout, "hi");
    return 0;
  });
  expect(await readText(proc.stdout)).toBe("hi");
  await proc.exit;
  expect(events).toContainEqual(expect.objectContaining({ type: "proc.spawn", argv: ["echo"] }));
  expect(events).toContainEqual(expect.objectContaining({ type: "proc.exit", exitCode: 0 }));
});

test("snapshot → restoreKernel round-trip, work continues", async () => {
  const store = new MemorySnapshotStore();
  const k1 = createKernel({ files: { "/work/a.txt": "v1" } });
  await k1.sys.writeFile("/work/b.txt", "added");
  const { snapshotId } = await k1.snapshot(store, { meta: { turn: 1 } });

  const { kernel: k2, meta } = await restoreKernel({ store, snapshotId });
  expect(meta).toEqual({ turn: 1 });
  expect(dec.decode(await k2.sys.readFile("/work/b.txt"))).toBe("added");
  await k2.sys.writeFile("/work/c.txt", "more");
  const { snapshotId: id2 } = await k2.snapshot(store);
  expect(id2).not.toBe(snapshotId);
});

test("network blocked by default on a fresh kernel", async () => {
  const kernel = createKernel();
  await expect(kernel.sys.fetch("https://example.com")).rejects.toMatchObject({ code: "ENETBLOCKED" });
});
