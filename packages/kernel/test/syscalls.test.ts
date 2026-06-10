import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";
import { createSyscalls, type Middleware, type SyscallDescriptor } from "../src/syscalls.js";

const dec = new TextDecoder();

test("syscalls delegate to vfs", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const sys = createSyscalls({ vfs, middlewares: [] });
  await sys.mkdir("/d");
  await sys.writeFile("/d/a.txt", "hi");
  expect(dec.decode(await sys.readFile("/d/a.txt"))).toBe("hi");
  expect((await sys.stat("/d/a.txt")).size).toBe(2);
  expect(await sys.readdir("/d")).toEqual(["a.txt"]);
  await sys.rename("/d/a.txt", "/d/b.txt");
  await sys.rm("/d/b.txt");
  expect(vfs.exists("/d/b.txt")).toBe(false);
});

test("middlewares wrap every call, in order, with a normalized descriptor", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const seen: string[] = [];
  const mw =
    (tag: string): Middleware =>
    async (call: SyscallDescriptor, next) => {
      seen.push(`${tag}:${call.name}:${call.path ?? ""}`);
      return next();
    };
  const sys = createSyscalls({ vfs, middlewares: [mw("outer"), mw("inner")] });
  await sys.writeFile("a.txt", "x"); // chemin relatif → normalisé vers /a.txt
  expect(seen).toEqual(["outer:writeFile:/a.txt", "inner:writeFile:/a.txt"]);
});

test("descriptor carries write flag and byte count", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const calls: SyscallDescriptor[] = [];
  const spy: Middleware = async (call, next) => {
    calls.push({ ...call });
    return next();
  };
  const sys = createSyscalls({ vfs, middlewares: [spy] });
  await sys.writeFile("/a.txt", "hello");
  await sys.readFile("/a.txt");
  expect(calls[0]).toMatchObject({ name: "writeFile", write: true, bytes: 5 });
  expect(calls[1]).toMatchObject({ name: "readFile", write: false });
});

test("fetch goes through middlewares and fetchImpl", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const fetchImpl = (async () => new Response("ok")) as typeof fetch;
  const calls: SyscallDescriptor[] = [];
  const spy: Middleware = async (call, next) => {
    calls.push({ ...call });
    return next();
  };
  const sys = createSyscalls({ vfs, middlewares: [spy], fetchImpl });
  const res = await sys.fetch("https://api.example.com/x");
  expect(await res.text()).toBe("ok");
  expect(calls[0]).toMatchObject({ name: "fetch", url: "https://api.example.com/x" });
});
