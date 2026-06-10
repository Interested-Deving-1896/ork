import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";
import { createSyscalls } from "../src/syscalls.js";
import { permissionsMiddleware } from "../src/middleware/permissions.js";

function makeSys(cfg: Parameters<typeof permissionsMiddleware>[0]) {
  const vfs = new Vfs({ now: () => 1 });
  vfs.mkdir("/knowledge");
  vfs.writeFile("/knowledge/doc.md", new TextEncoder().encode("ro"));
  vfs.mkdir("/work");
  return createSyscalls({ vfs, middlewares: [permissionsMiddleware(cfg)] });
}

test("writes under a ro mount → EACCES; reads still allowed", async () => {
  const sys = makeSys({ mounts: [{ path: "/knowledge", mode: "ro" }] });
  await expect(sys.writeFile("/knowledge/x.txt", "x")).rejects.toMatchObject({ code: "EACCES" });
  await expect(sys.rm("/knowledge/doc.md")).rejects.toMatchObject({ code: "EACCES" });
  await expect(sys.readFile("/knowledge/doc.md")).resolves.toBeInstanceOf(Uint8Array);
  await expect(sys.writeFile("/work/ok.txt", "x")).resolves.toBeUndefined();
});

test("rename out of or into a ro mount → EACCES", async () => {
  const sys = makeSys({ mounts: [{ path: "/knowledge", mode: "ro" }] });
  await expect(sys.rename("/knowledge/doc.md", "/work/doc.md")).rejects.toMatchObject({ code: "EACCES" });
  await sys.writeFile("/work/a.txt", "a");
  await expect(sys.rename("/work/a.txt", "/knowledge/a.txt")).rejects.toMatchObject({ code: "EACCES" });
});

test("network off by default → ENETBLOCKED", async () => {
  const sys = makeSys({});
  await expect(sys.fetch("https://example.com")).rejects.toMatchObject({ code: "ENETBLOCKED" });
});

test("fetch allowed only on allow-listed prefixes", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const fetchImpl = (async () => new Response("ok")) as typeof fetch;
  const sys = createSyscalls({
    vfs,
    fetchImpl,
    middlewares: [permissionsMiddleware({ network: { allowedUrlPrefixes: ["https://api.example.com/"] } })],
  });
  await expect(sys.fetch("https://api.example.com/v1/x")).resolves.toBeInstanceOf(Response);
  await expect(sys.fetch("https://evil.com/")).rejects.toMatchObject({ code: "ENETBLOCKED" });
});

test("host-suffix attack blocked even without trailing slash in prefix", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const fetchImpl = (async () => new Response("ok")) as typeof fetch;
  const sys = createSyscalls({
    vfs,
    fetchImpl,
    middlewares: [permissionsMiddleware({ network: { allowedUrlPrefixes: ["https://api.example.com"] } })],
  });
  await expect(sys.fetch("https://api.example.com.evil.com/")).rejects.toMatchObject({ code: "ENETBLOCKED" });
  await expect(sys.fetch("https://api.example.com/v1")).resolves.toBeInstanceOf(Response);
});

test("path prefix is enforced via parsed pathname", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const fetchImpl = (async () => new Response("ok")) as typeof fetch;
  const sys = createSyscalls({
    vfs,
    fetchImpl,
    middlewares: [permissionsMiddleware({ network: { allowedUrlPrefixes: ["https://api.example.com/v1/"] } })],
  });
  await expect(sys.fetch("https://api.example.com/v1/users")).resolves.toBeInstanceOf(Response);
  await expect(sys.fetch("https://api.example.com/admin")).rejects.toMatchObject({ code: "ENETBLOCKED" });
});

test("unparseable URL → ENETBLOCKED; invalid configured prefix → EINVAL at construction", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const sys = createSyscalls({
    vfs,
    middlewares: [permissionsMiddleware({ network: { allowedUrlPrefixes: ["https://ok.example.com/"] } })],
  });
  await expect(sys.fetch("not a url")).rejects.toMatchObject({ code: "ENETBLOCKED" });
  expect(() => permissionsMiddleware({ network: { allowedUrlPrefixes: ["%%%"] } })).toThrowError(/EINVAL/);
});
