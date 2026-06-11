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

/**
 * Extension optionnelle d'un {@link SnapshotStore} : énumération et suppression.
 * Requise par le GC (mark-and-sweep). Rétro-compatible — un store qui ne
 * l'implémente pas reste un SnapshotStore valide ; le GC le refuse via {@link isListable}.
 */
export interface ListableSnapshotStore extends SnapshotStore {
  /** Énumère les ids de tous les arbres (snapshots) présents. */
  listTrees(): AsyncIterable<string>;
  /** Énumère les hashes de tous les blobs présents. */
  listBlobs(): AsyncIterable<string>;
  /** Supprime un arbre. Absent (déjà supprimé) → no-op. */
  deleteTree(id: string): Promise<void>;
  /** Supprime un blob. Absent (déjà supprimé) → no-op. */
  deleteBlob(hash: string): Promise<void>;
}

export function isListable(store: SnapshotStore): store is ListableSnapshotStore {
  const s = store as Partial<ListableSnapshotStore>;
  return (
    typeof s.listTrees === "function" &&
    typeof s.listBlobs === "function" &&
    typeof s.deleteTree === "function" &&
    typeof s.deleteBlob === "function"
  );
}

export class MemorySnapshotStore implements ListableSnapshotStore {
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
  async *listTrees(): AsyncIterable<string> {
    // Snapshot des clés : itérer une copie tolère un delete concurrent du sweep.
    for (const id of [...this.#trees.keys()]) yield id;
  }
  async *listBlobs(): AsyncIterable<string> {
    for (const hash of [...this.#blobs.keys()]) yield hash;
  }
  async deleteTree(id: string): Promise<void> {
    this.#trees.delete(id);
  }
  async deleteBlob(hash: string): Promise<void> {
    this.#blobs.delete(hash);
  }
}
