import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KernelError } from "../errors.js";
import type { PointerStore, WorkspacePointer } from "./pointer-store.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new KernelError("EINVAL", `unsafe workspace id: ${id}`);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * Pointeurs sur disque : pointers/<id>.json. CAS atomique INTRA-PROCESS
 * uniquement (mutex par id + write-temp-puis-rename). Pour du multi-instance,
 * utiliser un store à écriture conditionnelle (R2/S3 If-Match, DB).
 */
export class DiskPointerStore implements PointerStore {
  #locks = new Map<string, Promise<unknown>>();

  constructor(private rootDir: string) {}

  #path(id: string): string {
    assertSafeId(id);
    return join(this.rootDir, "pointers", `${id}.json`);
  }

  async get(id: string): Promise<WorkspacePointer | null> {
    const path = this.#path(id);
    try {
      return JSON.parse(await readFile(path, "utf8")) as WorkspacePointer;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async set(id: string, pointer: WorkspacePointer, expectedVersion: number): Promise<boolean> {
    const path = this.#path(id);
    // Sérialise les set() concurrents sur le même id dans CE process.
    const tail = this.#locks.get(id) ?? Promise.resolve();
    const run = tail.then(async () => {
      const current = (await this.get(id))?.version ?? 0;
      if (current !== expectedVersion) return false;
      await mkdir(join(this.rootDir, "pointers"), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(pointer));
      await rename(tmp, path); // write atomique
      return true;
    });
    this.#locks.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}
