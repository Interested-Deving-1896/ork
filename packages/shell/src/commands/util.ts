// Shared helpers for command implementations. Lifted from fs.ts so text.ts and
// fs.ts can reuse them instead of duplicating.

import { isKernelError } from "@ork/kernel";
import type { CommandContext } from "../types.js";

/** Small flag parser: collects single-char flags from clustered/separate args
 * (e.g. `-la`, `-l -a`) until the first non-flag or `--`. Returns the flag set
 * plus the remaining operands (in order). Flags taking values are not handled
 * here — commands that need them parse explicitly. */
export function parseFlags(
  args: string[],
  known: Set<string>,
): { flags: Set<string>; rest: string[] } {
  const flags = new Set<string>();
  const rest: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      i++;
      break;
    }
    if (a.length > 1 && a.startsWith("-")) {
      let ok = true;
      const chars = a.slice(1).split("");
      for (const c of chars) if (!known.has(c)) ok = false;
      if (ok) {
        for (const c of chars) flags.add(c);
        continue;
      }
    }
    break;
  }
  for (; i < args.length; i++) rest.push(args[i]!);
  return { flags, rest };
}

/** stat() returning null on ENOENT, rethrowing other kernel errors. */
export async function statOrNull(
  ctx: CommandContext,
  abs: string,
): Promise<import("@ork/kernel").Stat | null> {
  try {
    return await ctx.sys.stat(abs);
  } catch (err) {
    if (isKernelError(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

/** Take the first/last N lines of text, normalizing the trailing newline. */
export function takeLines(text: string, n: number, tail: boolean): string {
  if (text === "") return "";
  const hadTrailing = text.endsWith("\n");
  const body = hadTrailing ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  const picked = tail ? lines.slice(Math.max(0, lines.length - n)) : lines.slice(0, n);
  if (picked.length === 0) return "";
  return picked.join("\n") + "\n";
}

/** Parse a cut-style LIST into a 1-based membership predicate, or null if
 * invalid. Accepts N, "N-", "-M", "N-M" and comma-joined combinations. */
export function parseRangeList(list: string): ((i: number) => boolean) | null {
  const ranges: Array<[number, number]> = [];
  for (const part of list.split(",")) {
    if (part === "") continue;
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^(\d+)$/))) {
      const n = parseInt(m[1]!, 10);
      ranges.push([n, n]);
    } else if ((m = part.match(/^(\d+)-$/))) {
      ranges.push([parseInt(m[1]!, 10), Infinity]);
    } else if ((m = part.match(/^-(\d+)$/))) {
      ranges.push([1, parseInt(m[1]!, 10)]);
    } else if ((m = part.match(/^(\d+)-(\d+)$/))) {
      ranges.push([parseInt(m[1]!, 10), parseInt(m[2]!, 10)]);
    } else {
      return null;
    }
  }
  if (ranges.length === 0) return null;
  return (i: number) => ranges.some(([lo, hi]) => i >= lo && i <= hi);
}

/** Split text into lines, dropping a single trailing newline's empty tail.
 * Returns [] for empty input. Used by text commands that operate line-wise. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const hadTrailing = text.endsWith("\n");
  const body = hadTrailing ? text.slice(0, -1) : text;
  return body.split("\n");
}
