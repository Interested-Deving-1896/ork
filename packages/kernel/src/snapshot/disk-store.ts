import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { SnapshotManifest, SnapshotStore } from "./store.js";

/** Store sur disque local : blobs/<hash>, trees/<id>.json. Pour dev et tests. */
export class DiskSnapshotStore implements SnapshotStore {
  constructor(private rootDir: string) {}

  #blobPath(hash: string): string {
    return join(this.rootDir, "blobs", hash);
  }
  #treePath(id: string): string {
    return join(this.rootDir, "trees", `${id}.json`);
  }

  async putBlob(hash: string, data: Uint8Array): Promise<void> {
    await mkdir(join(this.rootDir, "blobs"), { recursive: true });
    await writeFile(this.#blobPath(hash), data);
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.#blobPath(hash)));
    } catch {
      return null;
    }
  }

  async hasBlob(hash: string): Promise<boolean> {
    try {
      await access(this.#blobPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async putTree(id: string, manifest: SnapshotManifest): Promise<void> {
    await mkdir(join(this.rootDir, "trees"), { recursive: true });
    await writeFile(this.#treePath(id), JSON.stringify(manifest));
  }

  async getTree(id: string): Promise<SnapshotManifest | null> {
    try {
      return JSON.parse(await readFile(this.#treePath(id), "utf8")) as SnapshotManifest;
    } catch {
      return null;
    }
  }
}
