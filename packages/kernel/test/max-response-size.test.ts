import { expect, test, vi } from "vitest";
import { Vfs } from "../src/vfs.js";
import { createSyscalls } from "../src/syscalls.js";
import { createKernel } from "../src/kernel.js";

const dec = new TextDecoder();
const enc = new TextEncoder();

function makeSys(opts: { maxResponseSize?: number; fetchImpl: typeof fetch }) {
  const vfs = new Vfs({ now: () => 1 });
  return createSyscalls({
    vfs,
    middlewares: [],
    fetchImpl: opts.fetchImpl,
    maxResponseSize: opts.maxResponseSize,
  });
}

test("small body passes through unchanged — text() works", async () => {
  const fetchImpl = (async () => new Response("hello world")) as typeof fetch;
  const sys = makeSys({ maxResponseSize: 1024, fetchImpl });
  const res = await sys.fetch("https://api.example.com/x");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hello world");
});

test("Content-Length over the limit → EQUOTA without reading the body", async () => {
  // On the Content-Length fast path we must reject without entering the read loop.
  // We prove the body was not consumed by us: the stream is cancelled (connection released)
  // and never drained to completion — `pulls` stays at the initial priming pull at most,
  // and crucially `read()` is never invoked by our code (tracked via getReader spy).
  let pulls = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(enc.encode("x".repeat(100)));
    },
    cancel,
  });
  const getReaderSpy = vi.spyOn(body, "getReader");
  const fetchImpl = (async () =>
    new Response(body, { headers: { "Content-Length": "1000000" } })) as typeof fetch;
  const sys = makeSys({ maxResponseSize: 16, fetchImpl });
  await expect(sys.fetch("https://api.example.com/big")).rejects.toMatchObject({ code: "EQUOTA" });
  // Our code never acquired a reader → it never read the body.
  expect(getReaderSpy).not.toHaveBeenCalled();
  // The body was cancelled to free the connection.
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("streaming body over the limit WITHOUT Content-Length → EQUOTA once crossed", async () => {
  // Emits 8 chunks of 10 bytes = 80 bytes, no Content-Length. Limit is 16.
  let emitted = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= 8) {
        controller.close();
        return;
      }
      emitted++;
      controller.enqueue(enc.encode("0123456789"));
    },
  });
  const fetchImpl = (async () => new Response(body)) as typeof fetch;
  const sys = makeSys({ maxResponseSize: 16, fetchImpl });
  await expect(sys.fetch("https://api.example.com/stream")).rejects.toMatchObject({ code: "EQUOTA" });
  // Must abort early, not drain all 8 chunks.
  expect(emitted).toBeLessThan(8);
});

test("body exactly at the limit passes; one byte over fails", async () => {
  const okImpl = (async () => new Response("1234567890123456")) as typeof fetch; // 16 bytes
  const okSys = makeSys({ maxResponseSize: 16, fetchImpl: okImpl });
  expect(await (await okSys.fetch("https://x.test/a")).text()).toHaveLength(16);

  const overImpl = (async () => new Response("12345678901234567")) as typeof fetch; // 17 bytes
  const overSys = makeSys({ maxResponseSize: 16, fetchImpl: overImpl });
  await expect(overSys.fetch("https://x.test/b")).rejects.toMatchObject({ code: "EQUOTA" });
});

test("custom limit via createKernel({limits}) enforced end-to-end through kernel.sys.fetch", async () => {
  const fetchImpl = (async () => new Response("this is definitely more than sixteen bytes")) as typeof fetch;
  const kernel = createKernel({
    fetchImpl,
    network: { allowedUrlPrefixes: ["https://api.example.com/"] },
    limits: { maxResponseSize: 16 },
  });
  await expect(kernel.sys.fetch("https://api.example.com/x")).rejects.toMatchObject({ code: "EQUOTA" });
  expect(kernel.limits.maxResponseSize).toBe(16);
});

test("default limit lets a normal small body through end-to-end", async () => {
  const fetchImpl = (async () => new Response("ok")) as typeof fetch;
  const kernel = createKernel({
    fetchImpl,
    network: { allowedUrlPrefixes: ["https://api.example.com/"] },
  });
  const res = await kernel.sys.fetch("https://api.example.com/x");
  expect(dec.decode(new Uint8Array(await res.arrayBuffer()))).toBe("ok");
});
