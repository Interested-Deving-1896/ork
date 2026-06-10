import { KernelError } from "../errors.js";
import { normalizePath } from "../path.js";
import type { Middleware } from "../syscalls.js";

export interface PermissionsConfig {
  /** Sous-arbres en lecture seule. Tout le reste est rw par défaut. */
  mounts?: Array<{ path: string; mode: "ro" | "rw" }>;
  /** Réseau : absent = tout bloqué. */
  network?: { allowedUrlPrefixes: string[] };
}

export function permissionsMiddleware(cfg: PermissionsConfig): Middleware {
  const mounts = (cfg.mounts ?? []).map((m) => ({ mode: m.mode, path: normalizePath(m.path) }));

  function isReadOnly(path: string): boolean {
    let best: { path: string; mode: "ro" | "rw" } | null = null;
    for (const m of mounts) {
      const prefix = m.path === "/" ? "/" : m.path + "/";
      if (path === m.path || path.startsWith(prefix)) {
        if (!best || m.path.length > best.path.length) best = m;
      }
    }
    return best?.mode === "ro";
  }

  return async (call, next) => {
    if (call.name === "fetch") {
      const allowed = cfg.network?.allowedUrlPrefixes ?? [];
      if (!allowed.some((prefix) => call.url!.startsWith(prefix))) {
        throw new KernelError("ENETBLOCKED", call.url ?? "<no url>");
      }
      return next();
    }
    if (call.write) {
      if (call.path && isReadOnly(call.path)) throw new KernelError("EACCES", `read-only: ${call.path}`);
      if (call.toPath && isReadOnly(call.toPath)) throw new KernelError("EACCES", `read-only: ${call.toPath}`);
    }
    return next();
  };
}
