import { describe, expect, test } from "vitest";
import { S3SnapshotStore } from "../src/snapshot-store.js";
import type { S3StoreConfig } from "../src/s3-client.js";
import { FakeS3, type FakeS3Options } from "./fake-s3.js";

function makeStore(opts?: FakeS3Options): { store: S3SnapshotStore; fake: FakeS3 } {
  const fake = new FakeS3(opts);
  const config: S3StoreConfig = {
    bucket: "ork",
    prefix: "ws/",
    endpoint: "https://example.r2.cloudflarestorage.com",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    fetchImpl: fake.fetch,
  };
  return { store: new S3SnapshotStore(config), fake };
}

describe("S3SnapshotStore", () => {
  test("blob put/get/has round-trip", async () => {
    const { store } = makeStore();
    const hash = "abc123";
    expect(await store.hasBlob(hash)).toBe(false);
    expect(await store.getBlob(hash)).toBeNull();

    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await store.putBlob(hash, data);

    expect(await store.hasBlob(hash)).toBe(true);
    const got = await store.getBlob(hash);
    expect(got).toEqual(data);
  });

  test("tree round-trip", async () => {
    const { store } = makeStore();
    const id = "snap1";
    expect(await store.getTree(id)).toBeNull();

    const manifest = {
      version: 1 as const,
      entries: { "/a.txt": { kind: "file" as const, hash: "h", size: 3, mtime: 1 } },
      meta: { foo: "bar" },
    };
    await store.putTree(id, manifest);
    expect(await store.getTree(id)).toEqual(manifest);
  });

  test("blobs are stored under prefix + blobs/, trees under trees/", async () => {
    const { store, fake } = makeStore();
    await store.putBlob("h1", new Uint8Array([9]));
    await store.putTree("t1", { version: 1, entries: {} });
    expect([...fake.objects.keys()]).toEqual(expect.arrayContaining(["ork/ws/blobs/h1", "ork/ws/trees/t1.json"]));
  });

  test("404 → null / false", async () => {
    const { store } = makeStore();
    expect(await store.getBlob("missing")).toBeNull();
    expect(await store.hasBlob("missing")).toBe(false);
    expect(await store.getTree("missing")).toBeNull();
  });

  test("unsafe keys rejected with EINVAL", async () => {
    const { store } = makeStore();
    await expect(store.getBlob("../evil")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.hasBlob("a/b")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.putBlob("a b", new Uint8Array())).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.getTree("..")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.putTree("a.b", { version: 1, entries: {} })).rejects.toMatchObject({ code: "EINVAL" });
  });

  test("non-404 error → throws with status", async () => {
    const fake = new FakeS3();
    // Force un 500 sur GET.
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return new Response("boom", { status: 500 });
      return fake.fetch(url, init);
    };
    const store = new S3SnapshotStore({
      bucket: "ork",
      endpoint: "https://e",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      fetchImpl,
    });
    await expect(store.getBlob("h1")).rejects.toMatchObject({ code: "EINVAL", message: expect.stringContaining("500") });
  });
});
