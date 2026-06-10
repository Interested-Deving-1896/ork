import { KernelError } from "./errors.js";
import { normalizePath, parentOf } from "./path.js";

export type LazyRef = { hash: string; size: number };
export type FileEntry = { kind: "file"; content: Uint8Array | LazyRef; mtime: number };
export type DirEntry = { kind: "dir"; mtime: number };
export type Entry = FileEntry | DirEntry;
export type Stat = { kind: "file" | "dir"; size: number; mtime: number };
export type Hydrator = (hash: string) => Promise<Uint8Array>;

export function isLazy(content: Uint8Array | LazyRef): content is LazyRef {
  return !(content instanceof Uint8Array);
}

export class Vfs {
  #entries = new Map<string, Entry>();
  #now: () => number;
  /** Posé par restoreVfs : résout un hash de blob vers son contenu (Task 14). */
  hydrator: Hydrator | null = null;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#entries.set("/", { kind: "dir", mtime: this.#now() });
  }

  entry(path: string): Entry {
    const e = this.#entries.get(normalizePath(path));
    if (!e) throw new KernelError("ENOENT", path);
    return e;
  }

  exists(path: string): boolean {
    return this.#entries.has(normalizePath(path));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    const e = this.entry(p);
    if (e.kind === "dir") throw new KernelError("EISDIR", p);
    if (isLazy(e.content)) {
      if (!this.hydrator) throw new KernelError("ENOENT", `no hydrator for blob ${e.content.hash}`);
      const data = await this.hydrator(e.content.hash);
      e.content = data;
      return data;
    }
    return e.content;
  }

  writeFile(path: string, content: Uint8Array): void {
    const p = normalizePath(path);
    const existing = this.#entries.get(p);
    if (existing?.kind === "dir") throw new KernelError("EISDIR", p);
    const parentPath = parentOf(p);
    const parent = this.#entries.get(parentPath);
    if (!parent) throw new KernelError("ENOENT", `parent ${parentPath}`);
    if (parent.kind !== "dir") throw new KernelError("ENOTDIR", parentPath);
    this.#entries.set(p, { kind: "file", content, mtime: this.#now() });
  }

  stat(path: string): Stat {
    const e = this.entry(path);
    if (e.kind === "dir") return { kind: "dir", size: 0, mtime: e.mtime };
    const size = isLazy(e.content) ? e.content.size : e.content.byteLength;
    return { kind: "file", size, mtime: e.mtime };
  }

  mkdir(path: string, opts: { recursive?: boolean } = {}): void {
    const p = normalizePath(path);
    const existing = this.#entries.get(p);
    if (existing) {
      if (existing.kind === "dir" && opts.recursive) return;
      throw new KernelError("EEXIST", p);
    }
    const parentPath = parentOf(p);
    if (!this.#entries.has(parentPath)) {
      if (!opts.recursive) throw new KernelError("ENOENT", `parent ${parentPath}`);
      this.mkdir(parentPath, opts);
    }
    const parent = this.#entries.get(parentPath)!;
    if (parent.kind !== "dir") throw new KernelError("ENOTDIR", parentPath);
    this.#entries.set(p, { kind: "dir", mtime: this.#now() });
  }

  /** Itère toutes les entrées (paths canoniques) — utilisé par snapshot. */
  files(): IterableIterator<[string, Entry]> {
    return this.#entries.entries();
  }

  readdir(path: string): string[] {
    const p = normalizePath(path);
    const e = this.entry(p);
    if (e.kind !== "dir") throw new KernelError("ENOTDIR", p);
    const prefix = p === "/" ? "/" : p + "/";
    const names: string[] = [];
    for (const key of this.#entries.keys()) {
      if (key === p || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest.includes("/")) names.push(rest);
    }
    return names.sort();
  }

  rm(path: string, opts: { recursive?: boolean } = {}): void {
    const p = normalizePath(path);
    if (p === "/") throw new KernelError("EINVAL", "cannot remove /");
    const e = this.entry(p);
    if (e.kind === "dir") {
      const children = this.readdir(p);
      if (children.length > 0 && !opts.recursive) throw new KernelError("ENOTEMPTY", p);
      for (const child of children) this.rm(`${p}/${child}`, opts);
    }
    this.#entries.delete(p);
  }

  rename(from: string, to: string): void {
    const f = normalizePath(from);
    const t = normalizePath(to);
    const e = this.entry(f);
    if (f === t) return;
    if (t === f || t.startsWith(f === "/" ? "/" : f + "/")) {
      throw new KernelError("EINVAL", `cannot move ${f} into itself`);
    }
    const target = this.#entries.get(t);
    if (target) {
      if (target.kind === "dir") throw new KernelError("EEXIST", t);
      if (e.kind === "dir") throw new KernelError("ENOTDIR", t);
      // from=file, to=file existant : écrasement silencieux, sémantique POSIX assumée
    }
    const parentPath = parentOf(t);
    const parent = this.#entries.get(parentPath);
    if (!parent) throw new KernelError("ENOENT", `parent ${parentPath}`);
    if (parent.kind !== "dir") throw new KernelError("ENOTDIR", parentPath);
    const moves: Array<[string, string]> = [[f, t]];
    if (e.kind === "dir") {
      const prefix = f + "/";
      for (const key of this.#entries.keys()) {
        if (key.startsWith(prefix)) moves.push([key, t + key.slice(f.length)]);
      }
    }
    for (const [oldKey, newKey] of moves) {
      const entry = this.#entries.get(oldKey)!;
      this.#entries.delete(oldKey);
      this.#entries.set(newKey, entry);
    }
  }

  totalBytes(): number {
    let total = 0;
    for (const e of this.#entries.values()) {
      if (e.kind === "file") total += isLazy(e.content) ? e.content.size : e.content.byteLength;
    }
    return total;
  }
}
