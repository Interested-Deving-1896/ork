import type { Stat, Vfs } from "./vfs.js";
import { normalizePath } from "./path.js";

export type SyscallName =
  | "readFile"
  | "writeFile"
  | "stat"
  | "readdir"
  | "mkdir"
  | "rm"
  | "rename"
  | "fetch";

export interface SyscallDescriptor {
  name: SyscallName;
  /** Chemin principal, déjà normalisé. Absent pour fetch. */
  path?: string;
  /** Cible d'un rename, normalisée. */
  toPath?: string;
  /** URL pour fetch. */
  url?: string;
  /** Méthode HTTP pour fetch (normalisée en majuscules). */
  method?: string;
  /** Taille du payload pour writeFile. */
  bytes?: number;
  /** L'appel mute-t-il le FS ? */
  write: boolean;
}

export type Middleware = (call: SyscallDescriptor, next: () => Promise<unknown>) => Promise<unknown>;

export interface FsSyscalls {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array | string): Promise<void>;
  stat(path: string): Promise<Stat>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export function createSyscalls(opts: {
  vfs: Vfs;
  middlewares: Middleware[];
  fetchImpl?: typeof fetch;
}): FsSyscalls {
  const { vfs, middlewares } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const enc = new TextEncoder();

  function run<T>(call: SyscallDescriptor, impl: () => Promise<T>): Promise<T> {
    Object.freeze(call);
    let next: () => Promise<unknown> = impl;
    for (let i = middlewares.length - 1; i >= 0; i--) {
      const mw = middlewares[i]!;
      const inner = next;
      let called = false;
      next = () =>
        mw(call, () => {
          if (called) throw new Error(`syscall ${call.name}: next() called more than once`);
          called = true;
          return inner();
        });
    }
    return next() as Promise<T>;
  }

  return {
    readFile: (path) =>
      run({ name: "readFile", path: normalizePath(path), write: false }, () => vfs.readFile(path)),
    writeFile: (path, content) => {
      const data = typeof content === "string" ? enc.encode(content) : content;
      return run(
        { name: "writeFile", path: normalizePath(path), bytes: data.byteLength, write: true },
        async () => vfs.writeFile(path, data),
      );
    },
    stat: (path) =>
      run({ name: "stat", path: normalizePath(path), write: false }, async () => vfs.stat(path)),
    readdir: (path) =>
      run({ name: "readdir", path: normalizePath(path), write: false }, async () => vfs.readdir(path)),
    mkdir: (path, o) =>
      run({ name: "mkdir", path: normalizePath(path), write: true }, async () => vfs.mkdir(path, o)),
    rm: (path, o) =>
      run({ name: "rm", path: normalizePath(path), write: true }, async () => vfs.rm(path, o)),
    rename: (from, to) =>
      run(
        { name: "rename", path: normalizePath(from), toPath: normalizePath(to), write: true },
        async () => vfs.rename(from, to),
      ),
    fetch: (url, init) =>
      run(
        { name: "fetch", url, method: (init?.method ?? "GET").toUpperCase(), write: false },
        () => fetchImpl(url, init),
      ),
  };
}
