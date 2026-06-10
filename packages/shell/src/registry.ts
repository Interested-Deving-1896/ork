// Registry of external commands (programs run as kernel procs). Shell-state
// builtins (cd, export, read, assignments) are handled in the interpreter and
// are NOT registered here.
//
// Command implementations live in ./commands/*: core.ts (echo/cat/pwd/true/
// false/:/env/date/which) and test.ts (the POSIX test/[ evaluator). This module
// just wires them together.

import type { CommandImpl } from "./types.js";
import { cat, date, echo, env, falseCmd, makeWhich, pwd, trueCmd } from "./commands/core.js";
import { test } from "./commands/test.js";

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

// Shell-state builtins handled in the interpreter, not the registry. `which`
// reports these as builtins too.
const STATE_BUILTINS = new Set(["cd", "export", "read"]);

/** A registry seeded with the builtin command set. */
export function defaultRegistry(): CommandRegistry {
  const r = new CommandRegistry();

  // core
  r.register("echo", echo);
  r.register("cat", cat);
  r.register("pwd", pwd);
  r.register("true", trueCmd);
  r.register("false", falseCmd);
  r.register(":", trueCmd); // `:` is a no-op alias of true
  r.register("env", env);
  r.register("date", date);

  // test / [
  r.register("test", test);
  r.register("[", test);

  // which: reports registered builtins + shell-state builtins.
  r.register("which", makeWhich((name) => r.has(name) || STATE_BUILTINS.has(name)));

  return r;
}
