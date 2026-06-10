import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";
import { createSyscalls } from "../src/syscalls.js";
import { QuotaTracker, quotasMiddleware, DEFAULT_LIMITS } from "../src/middleware/quotas.js";

function makeSys(limits: Partial<typeof DEFAULT_LIMITS>) {
  const vfs = new Vfs({ now: () => 1 });
  const tracker = new QuotaTracker({ ...DEFAULT_LIMITS, ...limits }, vfs);
  const sys = createSyscalls({ vfs, middlewares: [quotasMiddleware(tracker)] });
  return { sys, tracker };
}

test("maxFileSize enforced on write", async () => {
  const { sys } = makeSys({ maxFileSize: 4 });
  await expect(sys.writeFile("/big.txt", "12345")).rejects.toMatchObject({ code: "EQUOTA" });
  await expect(sys.writeFile("/ok.txt", "1234")).resolves.toBeUndefined();
});

test("maxFsBytes enforced on cumulative writes", async () => {
  const { sys } = makeSys({ maxFsBytes: 6 });
  await sys.writeFile("/a.txt", "1234");
  await expect(sys.writeFile("/b.txt", "567")).rejects.toMatchObject({ code: "EQUOTA" });
});

test("maxSyscallsPerTurn enforced, resetTurn() clears the counter", async () => {
  const { sys, tracker } = makeSys({ maxSyscallsPerTurn: 2 });
  await sys.writeFile("/a.txt", "x");
  await sys.readFile("/a.txt");
  await expect(sys.readFile("/a.txt")).rejects.toMatchObject({ code: "EQUOTA" });
  tracker.resetTurn();
  await expect(sys.readFile("/a.txt")).resolves.toBeInstanceOf(Uint8Array);
});
