import { EventBus } from "./events.js";
import { normalizePath, parentOf } from "./path.js";
import { ProcTable } from "./proc.js";
import { createSyscalls, type FsSyscalls } from "./syscalls.js";
import { Vfs } from "./vfs.js";
import { permissionsMiddleware, type PermissionsConfig } from "./middleware/permissions.js";
import { DEFAULT_LIMITS, QuotaTracker, quotasMiddleware, type Limits } from "./middleware/quotas.js";
import { traceMiddleware } from "./middleware/trace.js";
import { restoreVfs, snapshotVfs } from "./snapshot/snapshot.js";
import type { SnapshotStore } from "./snapshot/store.js";

export interface KernelOptions {
  /** Fichiers initiaux. Les dossiers parents sont créés automatiquement.
   *  Seedés hors quotas : leurs octets comptent ensuite dans maxFsBytes. */
  files?: Record<string, string | Uint8Array>;
  mounts?: PermissionsConfig["mounts"];
  network?: PermissionsConfig["network"];
  limits?: Partial<Limits>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface Kernel {
  sys: FsSyscalls;
  procs: ProcTable;
  events: EventBus;
  vfs: Vfs;
  limits: Limits;
  snapshot(store: SnapshotStore, opts?: { meta?: unknown }): Promise<{ snapshotId: string }>;
  /** À appeler en début de tour agent : remet les compteurs de quota par tour à zéro. */
  resetTurn(): void;
}

function buildKernel(vfs: Vfs, opts: KernelOptions): Kernel {
  const bus = new EventBus();
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const tracker = new QuotaTracker(limits, vfs);
  const sys = createSyscalls({
    vfs,
    fetchImpl: opts.fetchImpl,
    middlewares: [
      traceMiddleware(bus), // outermost : trace aussi les refus
      permissionsMiddleware({ mounts: opts.mounts, network: opts.network }),
      quotasMiddleware(tracker),
    ],
  });
  const procs = new ProcTable({ bus, maxProcs: limits.maxProcs });
  return {
    sys,
    procs,
    events: bus,
    vfs,
    limits,
    snapshot: async (store, o) => {
      const { snapshotId } = await snapshotVfs(vfs, store, o);
      return { snapshotId };
    },
    resetTurn: () => tracker.resetTurn(),
  };
}

export function createKernel(opts: KernelOptions = {}): Kernel {
  const vfs = new Vfs({ now: opts.now });
  if (opts.files) {
    const enc = new TextEncoder();
    for (const [rawPath, content] of Object.entries(opts.files)) {
      const path = normalizePath(rawPath);
      const parent = parentOf(path);
      if (!vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
      vfs.writeFile(path, typeof content === "string" ? enc.encode(content) : content);
    }
  }
  return buildKernel(vfs, opts);
}

/** La config (limits/mounts/network) est fournie à chaque instanciation : le snapshot
 *  ne persiste que le FS et `meta` (ex. historique de conversation), jamais la config. */
export async function restoreKernel(
  args: { store: SnapshotStore; snapshotId: string } & KernelOptions,
): Promise<{ kernel: Kernel; meta?: unknown }> {
  const { vfs, meta } = await restoreVfs(args.store, args.snapshotId, { now: args.now });
  return { kernel: buildKernel(vfs, args), meta };
}
