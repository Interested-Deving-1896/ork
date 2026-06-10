// Registry of external commands (programs run as kernel procs). Shell-state
// builtins (cd, export, read, assignments) are handled in the interpreter and
// are NOT registered here.
//
// Command implementations live in ./commands/*: core.ts (echo/cat/pwd/true/
// false/:/env/date/which), test.ts (the POSIX test/[ evaluator) and fs.ts (the
// filesystem + text commands). This module just wires them together.

import type { CommandImpl } from "./types.js";
import { cat, date, echo, env, falseCmd, makeWhich, pwd, trueCmd } from "./commands/core.js";
import { test } from "./commands/test.js";
import {
  base64Cmd,
  cp,
  cut,
  head,
  ls,
  mkdir,
  mv,
  printf,
  rm,
  tail,
  tee,
  touch,
  wc,
} from "./commands/fs.js";
import { diff, find, grep, jq, sed, sort, tr, uniq, xargs } from "./commands/text.js";

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

  // filesystem + text
  r.register("ls", ls);
  r.register("mkdir", mkdir);
  r.register("rm", rm);
  r.register("cp", cp);
  r.register("mv", mv);
  r.register("touch", touch);
  r.register("head", head);
  r.register("tail", tail);
  r.register("wc", wc);
  r.register("printf", printf);
  r.register("tee", tee);
  r.register("base64", base64Cmd);
  r.register("cut", cut);

  // text processing
  r.register("grep", grep);
  r.register("sort", sort);
  r.register("uniq", uniq);
  r.register("tr", tr);
  r.register("sed", sed);
  r.register("find", find);
  r.register("xargs", xargs);
  r.register("diff", diff);
  r.register("jq", jq);

  // which: reports registered builtins + shell-state builtins.
  r.register("which", makeWhich((name) => r.has(name) || STATE_BUILTINS.has(name)));

  return r;
}
