import { expect, test, vi } from "vitest";
import { EventBus, type KernelEvent } from "../src/events.js";

test("emit delivers to all subscribers", () => {
  const bus = new EventBus();
  const a = vi.fn();
  const b = vi.fn();
  bus.subscribe(a);
  bus.subscribe(b);
  const ev: KernelEvent = { type: "proc.exit", pid: 1, exitCode: 0 };
  bus.emit(ev);
  expect(a).toHaveBeenCalledWith(ev);
  expect(b).toHaveBeenCalledWith(ev);
});

test("unsubscribe stops delivery", () => {
  const bus = new EventBus();
  const fn = vi.fn();
  const unsub = bus.subscribe(fn);
  unsub();
  bus.emit({ type: "fs.write", path: "/a", bytes: 3 });
  expect(fn).not.toHaveBeenCalled();
});

test("a throwing listener does not break delivery nor the emitter", () => {
  const bus = new EventBus();
  const boom = vi.fn(() => {
    throw new Error("listener bug");
  });
  const after = vi.fn();
  bus.subscribe(boom);
  bus.subscribe(after);
  expect(() => bus.emit({ type: "proc.exit", pid: 1, exitCode: 0 })).not.toThrow();
  expect(boom).toHaveBeenCalled();
  expect(after).toHaveBeenCalled();
});
