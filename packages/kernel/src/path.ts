import { KernelError } from "./errors.js";

/** Canonicalise un chemin virtuel. `..` est clampé à la racine (pas d'évasion possible). */
export function normalizePath(path: string, cwd = "/"): string {
  if (path.includes("\0")) throw new KernelError("EINVAL", "null byte in path");
  const abs = path.startsWith("/") ? path : `${cwd}/${path}`;
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function basename(path: string): string {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}
