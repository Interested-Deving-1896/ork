import { KernelError } from "../errors.js";
import type { Middleware } from "../syscalls.js";
import type { Vfs } from "../vfs.js";

export interface Limits {
  maxFsBytes: number;
  maxFileSize: number;
  maxSyscallsPerTurn: number;
  maxProcs: number;
  /** Plafond de la taille du corps des réponses HTTP (octets). */
  maxResponseSize: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFsBytes: 64 * 1024 * 1024,
  maxFileSize: 8 * 1024 * 1024,
  maxSyscallsPerTurn: 10_000,
  maxProcs: 64,
  maxResponseSize: 8 * 1024 * 1024,
};

export class QuotaTracker {
  syscallCount = 0;

  constructor(
    readonly limits: Limits,
    readonly vfs: Vfs,
  ) {}

  resetTurn(): void {
    this.syscallCount = 0;
  }
}

export function quotasMiddleware(tracker: QuotaTracker): Middleware {
  return async (call, next) => {
    tracker.syscallCount++;
    if (tracker.syscallCount > tracker.limits.maxSyscallsPerTurn) {
      throw new KernelError("EQUOTA", `maxSyscallsPerTurn (${tracker.limits.maxSyscallsPerTurn}) exceeded`);
    }
    if (call.name === "writeFile" && call.bytes !== undefined) {
      if (call.bytes > tracker.limits.maxFileSize) {
        throw new KernelError("EQUOTA", `maxFileSize (${tracker.limits.maxFileSize}) exceeded`);
      }
      // Pessimiste sur overwrite : on ne déduit pas l'ancienne taille. Simple et sûr.
      if (tracker.vfs.totalBytes() + call.bytes > tracker.limits.maxFsBytes) {
        throw new KernelError("EQUOTA", `maxFsBytes (${tracker.limits.maxFsBytes}) exceeded`);
      }
    }
    return next();
  };
}
