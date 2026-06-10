export type KernelEvent =
  | { type: "syscall"; name: string; path?: string; ok: boolean; code?: string }
  | { type: "fs.write"; path: string; bytes: number }
  | { type: "proc.spawn"; pid: number; ppid: number; argv: string[] }
  | { type: "proc.exit"; pid: number; exitCode: number }
  | { type: "net.fetch"; url: string; method: string; status?: number };

export type KernelEventListener = (ev: KernelEvent) => void;

export class EventBus {
  #listeners = new Set<KernelEventListener>();

  emit(ev: KernelEvent): void {
    for (const fn of this.#listeners) {
      try {
        fn(ev);
      } catch {
        // Un listener défaillant ne doit jamais casser l'exécution ni priver
        // les autres listeners de l'événement — l'observabilité est passive.
      }
    }
  }

  subscribe(fn: KernelEventListener): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }
}
