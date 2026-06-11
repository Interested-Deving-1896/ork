export const KERNEL_VERSION = "0.0.1";

export { KernelError, isKernelError, type ErrnoCode } from "./errors.js";
export { normalizePath, parentOf, basename } from "./path.js";
export { EventBus, type KernelEvent, type KernelEventListener } from "./events.js";
export { Vfs, isLazy, type Entry, type FileEntry, type DirEntry, type Stat, type LazyRef, type Hydrator } from "./vfs.js";
export {
  createSyscalls,
  type FsSyscalls,
  type Middleware,
  type SyscallDescriptor,
  type SyscallName,
} from "./syscalls.js";
export { permissionsMiddleware, type PermissionsConfig } from "./middleware/permissions.js";
export { quotasMiddleware, QuotaTracker, DEFAULT_LIMITS, type Limits } from "./middleware/quotas.js";
export { traceMiddleware } from "./middleware/trace.js";
export { ProcTable, type ProcHandle, type ProcIo, type ProcMain, type ProcInfo, type ProcStatus } from "./proc.js";
export { readAll, readText, writeAll } from "./streams.js";
export { sha256Hex } from "./snapshot/hash.js";
export { MemorySnapshotStore, type SnapshotStore, type SnapshotManifest, type ManifestEntry } from "./snapshot/store.js";
export { DiskSnapshotStore } from "./snapshot/disk-store.js";
export { snapshotVfs, restoreVfs } from "./snapshot/snapshot.js";
export { createKernel, restoreKernel, type Kernel, type KernelOptions } from "./kernel.js";
export {
  MemoryPointerStore,
  type PointerStore,
  type WorkspacePointer,
} from "./workspace/pointer-store.js";
export { DiskPointerStore } from "./workspace/disk-pointer-store.js";
export {
  Workspace,
  WorkspaceConflictError,
  type WorkspaceOpenOptions,
} from "./workspace/workspace.js";
