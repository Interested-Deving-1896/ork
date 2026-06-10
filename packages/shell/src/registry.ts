// Registry of external commands (programs run as kernel procs). Shell-state
// builtins (cd, export, assignments) are handled in the interpreter and are NOT
// registered here. This seed set is the minimum needed to exercise the
// interpreter; later tasks add the full coreutils-like command set.

import { isKernelError, readAll, writeAll } from "@ork/kernel";
import type { CommandImpl } from "./types.js";

export class CommandRegistry {
  #map = new Map<string, CommandImpl>();

  register(name: string, impl: CommandImpl): this {
    this.#map.set(name, impl);
    return this;
  }

  get(name: string): CommandImpl | undefined {
    return this.#map.get(name);
  }

  has(name: string): boolean {
    return this.#map.has(name);
  }
}

// echo: join args with single spaces + trailing newline; -n suppresses newline.
const echo: CommandImpl = async (ctx) => {
  let args = ctx.argv.slice(1);
  let newline = true;
  if (args[0] === "-n") {
    newline = false;
    args = args.slice(1);
  }
  const out = args.join(" ") + (newline ? "\n" : "");
  await writeAll(ctx.stdout, out);
  return 0;
};

// cat: no file args copies stdin; otherwise reads each file via the syscalls.
const cat: CommandImpl = async (ctx) => {
  const files = ctx.argv.slice(1);
  if (files.length === 0) {
    await writeAll(ctx.stdout, await readAll(ctx.stdin));
    return 0;
  }
  let code = 0;
  for (const f of files) {
    try {
      const data = await ctx.sys.readFile(ctx.resolve(f));
      await writeAll(ctx.stdout, data);
    } catch (err) {
      if (isKernelError(err) && err.code === "ENOENT") {
        await writeAll(ctx.stderr, `cat: ${f}: No such file or directory\n`);
        code = 1;
      } else if (isKernelError(err) && err.code === "EISDIR") {
        await writeAll(ctx.stderr, `cat: ${f}: Is a directory\n`);
        code = 1;
      } else {
        throw err;
      }
    }
  }
  return code;
};

const pwd: CommandImpl = async (ctx) => {
  await writeAll(ctx.stdout, ctx.cwd + "\n");
  return 0;
};

const trueCmd: CommandImpl = async () => 0;
const falseCmd: CommandImpl = async () => 1;

/** A registry seeded with the minimal builtins the interpreter tests need. */
export function defaultRegistry(): CommandRegistry {
  const r = new CommandRegistry();
  r.register("echo", echo);
  r.register("cat", cat);
  r.register("pwd", pwd);
  r.register("true", trueCmd);
  r.register("false", falseCmd);
  return r;
}
