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
  const allowedUrls = (cfg.network?.allowedUrlPrefixes ?? []).map((p) => {
    try {
      return new URL(p);
    } catch {
      throw new KernelError("EINVAL", `invalid url prefix: ${p}`);
    }
  });
  const networkEnabled = cfg.network !== undefined;

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
      const raw = call.url ?? "";
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new KernelError("ENETBLOCKED", raw);
      }
      const allowed =
        networkEnabled &&
        allowedUrls.some((p) => p.origin === url.origin && url.pathname.startsWith(p.pathname));
      if (!allowed) throw new KernelError("ENETBLOCKED", raw);
      return next();
    }
    if (call.write) {
      if (call.path && isReadOnly(call.path)) throw new KernelError("EACCES", `read-only: ${call.path}`);
      if (call.toPath && isReadOnly(call.toPath)) throw new KernelError("EACCES", `read-only: ${call.toPath}`);
    }
    return next();
  };
}
