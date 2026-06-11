/** Référence mutable « état courant d'un workspace » → un snapshot immuable. */
export interface WorkspacePointer {
  snapshotId: string;
  /** Version monotone pour la concurrence optimiste (CAS). Premier commit → 1. */
  version: number;
}

export interface PointerStore {
  get(id: string): Promise<WorkspacePointer | null>;
  /**
   * Compare-and-swap : n'écrit `pointer` que si la version stockée vaut
   * `expectedVersion` (0 = le pointeur ne doit pas encore exister). Retourne
   * false quand la précondition échoue (un autre écrivain a gagné).
   */
  set(id: string, pointer: WorkspacePointer, expectedVersion: number): Promise<boolean>;
}

export class MemoryPointerStore implements PointerStore {
  #map = new Map<string, WorkspacePointer>();

  async get(id: string): Promise<WorkspacePointer | null> {
    return this.#map.get(id) ?? null;
  }

  async set(id: string, pointer: WorkspacePointer, expectedVersion: number): Promise<boolean> {
    const current = this.#map.get(id)?.version ?? 0;
    if (current !== expectedVersion) return false;
    this.#map.set(id, pointer);
    return true;
  }
}
