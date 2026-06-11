import { createKernel, restoreKernel, type Kernel, type KernelOptions } from "../kernel.js";
import type { SnapshotStore } from "../snapshot/store.js";
import type { PointerStore } from "./pointer-store.js";

/** Un commit concurrent a avancé le pointeur entre open() et commit(). */
export class WorkspaceConflictError extends Error {
  constructor(readonly workspaceId: string) {
    super(`workspace ${workspaceId}: concurrent commit detected (pointer moved)`);
    this.name = "WorkspaceConflictError";
  }
}

export interface WorkspaceOpenOptions extends Omit<KernelOptions, "files"> {
  /** Identifiant du workspace (ex. userId). Doit matcher [A-Za-z0-9_-]{1,128} pour les stores disque. */
  id: string;
  store: SnapshotStore;
  pointers: PointerStore;
  /** Fichiers seedés à la PREMIÈRE ouverture (workspace inexistant). Ignoré ensuite. */
  seed?: Record<string, string | Uint8Array>;
}

/**
 * Le « repo » d'un user : un FS persistant référencé par un pointeur versionné.
 * open() restaure l'état courant (lazy) ; commit() snapshot FS-only + avance le
 * pointeur par CAS. Les messages de conversation ne passent JAMAIS par ici —
 * ils appartiennent à l'hôte (un thread par conversation).
 */
export class Workspace {
  private constructor(
    readonly id: string,
    readonly kernel: Kernel,
    private readonly store: SnapshotStore,
    private readonly pointers: PointerStore,
    private version: number,
    private parentSnapshotId: string | null,
  ) {}

  static async open(opts: WorkspaceOpenOptions): Promise<Workspace> {
    const { id, store, pointers, seed, ...kernelOpts } = opts;
    const pointer = await pointers.get(id);
    if (pointer) {
      const { kernel } = await restoreKernel({ store, snapshotId: pointer.snapshotId, ...kernelOpts });
      return new Workspace(id, kernel, store, pointers, pointer.version, pointer.snapshotId);
    }
    const kernel = createKernel({ files: seed, ...kernelOpts });
    return new Workspace(id, kernel, store, pointers, 0, null);
  }

  /**
   * Snapshot FS-only + avance le pointeur (CAS). Le meta porte la lignée
   * ({workspace:{id,parent}}) pour l'historique et un futur GC. Conflit →
   * WorkspaceConflictError : l'hôte rejoue le tour sur un workspace ré-ouvert
   * ou renvoie 409.
   */
  async commit(): Promise<{ snapshotId: string }> {
    const { snapshotId } = await this.kernel.snapshot(this.store, {
      meta: { workspace: { id: this.id, parent: this.parentSnapshotId } },
    });
    const next = this.version + 1;
    const ok = await this.pointers.set(this.id, { snapshotId, version: next }, this.version);
    if (!ok) throw new WorkspaceConflictError(this.id);
    this.version = next;
    this.parentSnapshotId = snapshotId;
    return { snapshotId };
  }
}
