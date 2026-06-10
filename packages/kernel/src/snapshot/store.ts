export type ManifestEntry =
  | { kind: "file"; hash: string; size: number; mtime: number }
  | { kind: "dir"; mtime: number };

export interface SnapshotManifest {
  version: 1;
  /** path canonique → entrée. Les clés DOIVENT être insérées triées (déterminisme de l'id). */
  entries: Record<string, ManifestEntry>;
  /** Métadonnées opaques (ex. historique de conversation du harness). */
  meta?: unknown;
}

export interface SnapshotStore {
  putBlob(hash: string, data: Uint8Array): Promise<void>;
  getBlob(hash: string): Promise<Uint8Array | null>;
  hasBlob(hash: string): Promise<boolean>;
  putTree(id: string, manifest: SnapshotManifest): Promise<void>;
  getTree(id: string): Promise<SnapshotManifest | null>;
}

export class MemorySnapshotStore implements SnapshotStore {
  #blobs = new Map<string, Uint8Array>();
  #trees = new Map<string, string>(); // JSON sérialisé, immuable

  async putBlob(hash: string, data: Uint8Array): Promise<void> {
    // Le blob est stocké par référence : le caller ne doit pas muter le buffer après put.
    this.#blobs.set(hash, data);
  }
  async getBlob(hash: string): Promise<Uint8Array | null> {
    return this.#blobs.get(hash) ?? null;
  }
  async hasBlob(hash: string): Promise<boolean> {
    return this.#blobs.has(hash);
  }
  async putTree(id: string, manifest: SnapshotManifest): Promise<void> {
    this.#trees.set(id, JSON.stringify(manifest));
  }
  async getTree(id: string): Promise<SnapshotManifest | null> {
    const json = this.#trees.get(id);
    return json ? (JSON.parse(json) as SnapshotManifest) : null;
  }
}
