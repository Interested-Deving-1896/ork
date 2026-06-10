import { KernelError } from "../errors.js";
import { Vfs, isLazy } from "../vfs.js";
import { sha256Hex } from "./hash.js";
import type { ManifestEntry, SnapshotManifest, SnapshotStore } from "./store.js";

const enc = new TextEncoder();

export async function snapshotVfs(
  vfs: Vfs,
  store: SnapshotStore,
  opts: { meta?: unknown } = {},
): Promise<{ snapshotId: string; manifest: SnapshotManifest }> {
  // Paths triés → ordre d'insertion déterministe → JSON déterministe → id stable.
  const paths = [...vfs.files()].map(([p]) => p).filter((p) => p !== "/").sort();
  const entries: Record<string, ManifestEntry> = {};
  for (const path of paths) {
    const entry = vfs.entry(path);
    if (entry.kind === "dir") {
      entries[path] = { kind: "dir", mtime: entry.mtime };
      continue;
    }
    if (isLazy(entry.content)) {
      // Jamais hydraté depuis le restore : le blob est déjà dans le store.
      entries[path] = { kind: "file", hash: entry.content.hash, size: entry.content.size, mtime: entry.mtime };
      continue;
    }
    const hash = await sha256Hex(entry.content);
    if (!(await store.hasBlob(hash))) await store.putBlob(hash, entry.content);
    entries[path] = { kind: "file", hash, size: entry.content.byteLength, mtime: entry.mtime };
  }
  const manifest: SnapshotManifest = { version: 1, entries, ...(opts.meta !== undefined ? { meta: opts.meta } : {}) };
  const snapshotId = await sha256Hex(enc.encode(JSON.stringify(manifest)));
  await store.putTree(snapshotId, manifest);
  return { snapshotId, manifest };
}

export async function restoreVfs(
  store: SnapshotStore,
  snapshotId: string,
  opts: { now?: () => number } = {},
): Promise<{ vfs: Vfs; meta?: unknown }> {
  const manifest = await store.getTree(snapshotId);
  if (!manifest) throw new KernelError("ENOENT", `snapshot ${snapshotId}`);
  const vfs = new Vfs(opts);
  vfs.hydrator = async (hash) => {
    const data = await store.getBlob(hash);
    if (!data) throw new KernelError("ENOENT", `blob ${hash}`);
    return data;
  };
  const paths = Object.keys(manifest.entries).sort(); // parents avant enfants
  for (const path of paths) {
    const e = manifest.entries[path]!;
    if (e.kind === "dir") {
      vfs.mkdir(path, { recursive: true });
      // mkdir estampille un mtime frais ; on restaure le mtime du manifest pour
      // que re-snapshot d'un vfs restauré reproduise le même id (content-addressed).
      vfs.entry(path).mtime = e.mtime;
    }
  }
  for (const path of paths) {
    const e = manifest.entries[path]!;
    if (e.kind === "file") vfs.putLazyFile(path, { hash: e.hash, size: e.size }, e.mtime);
  }
  return { vfs, meta: manifest.meta };
}
