import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { KernelError } from "../errors.js";
import type { SnapshotManifest, SnapshotStore } from "./store.js";

const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key)) throw new KernelError("EINVAL", `unsafe store key: ${key}`);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/** Store sur disque local : blobs/<hash>, trees/<id>.json. Pour dev et tests. */
export class DiskSnapshotStore implements SnapshotStore {
  constructor(private rootDir: string) {}

  #blobPath(hash: string): string {
    assertSafeKey(hash);
    return join(this.rootDir, "blobs", hash);
  }
  #treePath(id: string): string {
    assertSafeKey(id);
    return join(this.rootDir, "trees", `${id}.json`);
  }

  async putBlob(hash: string, data: Uint8Array): Promise<void> {
    const path = this.#blobPath(hash);
    await mkdir(join(this.rootDir, "blobs"), { recursive: true });
    await writeFile(path, data);
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    const path = this.#blobPath(hash);
    try {
      return new Uint8Array(await readFile(path));
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async hasBlob(hash: string): Promise<boolean> {
    const path = this.#blobPath(hash);
    try {
      await access(path);
      return true;
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }
  }

  async putTree(id: string, manifest: SnapshotManifest): Promise<void> {
    const path = this.#treePath(id);
    await mkdir(join(this.rootDir, "trees"), { recursive: true });
    await writeFile(path, JSON.stringify(manifest));
  }

  async getTree(id: string): Promise<SnapshotManifest | null> {
    const path = this.#treePath(id);
    try {
      return JSON.parse(await readFile(path, "utf8")) as SnapshotManifest;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }
}
