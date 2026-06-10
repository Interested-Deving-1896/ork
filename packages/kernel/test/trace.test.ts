import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";
import { createSyscalls } from "../src/syscalls.js";
import { EventBus, type KernelEvent } from "../src/events.js";
import { traceMiddleware } from "../src/middleware/trace.js";
import { permissionsMiddleware } from "../src/middleware/permissions.js";

function makeTraced() {
  const vfs = new Vfs({ now: () => 1 });
  const bus = new EventBus();
  const events: KernelEvent[] = [];
  bus.subscribe((ev) => events.push(ev));
  // trace OUTERMOST : capture aussi les refus des middlewares internes
  const sys = createSyscalls({
    vfs,
    middlewares: [traceMiddleware(bus), permissionsMiddleware({ mounts: [{ path: "/ro", mode: "ro" }] })],
  });
  vfs.mkdir("/ro");
  return { sys, events };
}

test("successful syscall emits syscall + fs.write events", async () => {
  const { sys, events } = makeTraced();
  await sys.writeFile("/a.txt", "abc");
  expect(events).toContainEqual({ type: "syscall", name: "writeFile", path: "/a.txt", ok: true });
  expect(events).toContainEqual({ type: "fs.write", path: "/a.txt", bytes: 3 });
});

test("failed syscall emits ok:false with errno code, error still thrown", async () => {
  const { sys, events } = makeTraced();
  await expect(sys.readFile("/missing")).rejects.toMatchObject({ code: "ENOENT" });
  expect(events).toContainEqual({ type: "syscall", name: "readFile", path: "/missing", ok: false, code: "ENOENT" });
});

test("permission denials are traced (trace is outermost)", async () => {
  const { sys, events } = makeTraced();
  await expect(sys.writeFile("/ro/x.txt", "x")).rejects.toMatchObject({ code: "EACCES" });
  expect(events).toContainEqual({ type: "syscall", name: "writeFile", path: "/ro/x.txt", ok: false, code: "EACCES" });
});
