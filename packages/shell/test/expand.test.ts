import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import {
  expandWords,
  expandWordSingle,
  expandRedirTarget,
  segmentToRegExp,
  type ExpandRuntime,
} from "../src/expand.js";
import { ShellError } from "../src/errors.js";
import type { SimpleCommand, Word } from "../src/ast.js";

// Extract the word list of a single simple command.
function words(src: string): Word[] {
  const script = parse(src);
  const cmd = script.statements[0]!.andOr.first.commands[0] as SimpleCommand;
  return cmd.words;
}

// A test runtime with a fixed variable map and an in-memory glob set.
function rt(opts: {
  vars?: Record<string, string>;
  files?: string[];
  cwd?: string;
} = {}): ExpandRuntime {
  const vars = opts.vars ?? {};
  const files = opts.files ?? [];
  const cwd = opts.cwd ?? "/";
  return {
    cmdsubDepth: 0,
    lookup: (name) => vars[name],
    runCapture: async (script) => {
      // Minimal: echo X -> X\n ; supports the cmdsub tests below.
      const m = /^\s*echo\s+(.*?)\s*$/.exec(script);
      if (m) return { stdout: m[1] + "\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    },
    glob: async (pattern) => {
      // Very small glob: support "*.txt" style suffix matching against `files`
      // which are absolute paths; honor cwd for relative patterns.
      const abs = pattern.startsWith("/") ? pattern : `${cwd === "/" ? "" : cwd}/${pattern}`.replace(/\/+/g, "/");
      const re = new RegExp("^" + abs.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*") + "$");
      const matched = files.filter((f) => re.test(f)).sort();
      return matched.length > 0 ? matched : null;
    },
  };
}

describe("expand: literals and variables", () => {
  it("plain literals pass through", async () => {
    expect(await expandWords(words("echo a b c"), rt())).toEqual(["echo", "a", "b", "c"]);
  });

  it("$VAR expands; unquoted result is field-split on whitespace", async () => {
    const out = await expandWords(words("echo $X"), rt({ vars: { X: "a b  c" } }));
    expect(out).toEqual(["echo", "a", "b", "c"]);
  });

  it('"$VAR" is a single field (no split)', async () => {
    const out = await expandWords(words('echo "$X"'), rt({ vars: { X: "a b c" } }));
    expect(out).toEqual(["echo", "a b c"]);
  });

  it("undefined variable expands to empty and contributes nothing when alone", async () => {
    const out = await expandWords(words("echo $NOPE"), rt());
    expect(out).toEqual(["echo"]);
  });

  it("adjacent literal + var concatenate", async () => {
    const out = await expandWords(words("echo pre$X"), rt({ vars: { X: "fix" } }));
    expect(out).toEqual(["echo", "prefix"]);
  });

  it("${VAR} braces", async () => {
    const out = await expandWords(words("echo ${X}y"), rt({ vars: { X: "x" } }));
    expect(out).toEqual(["echo", "xy"]);
  });
});

describe("expand: command substitution", () => {
  it("$(echo hi) inserts the captured stdout (newline stripped)", async () => {
    const out = await expandWords(words("echo $(echo hi)"), rt());
    expect(out).toEqual(["echo", "hi"]);
  });

  it("unquoted cmdsub field-splits", async () => {
    const out = await expandWords(words("echo $(echo a b c)"), rt());
    expect(out).toEqual(["echo", "a", "b", "c"]);
  });

  it("quoted cmdsub is a single field", async () => {
    const out = await expandWords(words('echo "$(echo a b c)"'), rt());
    expect(out).toEqual(["echo", "a b c"]);
  });

  it("enforces cmdsub depth <= 16", async () => {
    const deep = rt();
    deep.cmdsubDepth = 16;
    await expect(expandWords(words("echo $(echo hi)"), deep)).rejects.toBeInstanceOf(ShellError);
  });
});

describe("expand: globs", () => {
  const files = ["/a.txt", "/b.txt", "/c.log"];

  it("*.txt expands to sorted matches", async () => {
    const out = await expandWords(words("echo *.txt"), rt({ files }));
    expect(out).toEqual(["echo", "/a.txt", "/b.txt"]);
  });

  it("no-match keeps the literal pattern", async () => {
    const out = await expandWords(words("echo *.zzz"), rt({ files }));
    expect(out).toEqual(["echo", "*.zzz"]);
  });

  it('quoted "*.txt" does not glob', async () => {
    const out = await expandWords(words('echo "*.txt"'), rt({ files }));
    expect(out).toEqual(["echo", "*.txt"]);
  });
});

describe("expand: single-word and redirect target", () => {
  it("expandWordSingle does not split or glob", async () => {
    const out = await expandWordSingle(words("x $X")[1]!, rt({ vars: { X: "a b" } }));
    expect(out).toBe("a b");
  });

  it("expandRedirTarget throws on ambiguous (multi-match) glob", async () => {
    const w = words("echo *.txt")[1]!;
    await expect(expandRedirTarget(w, rt({ files: ["/a.txt", "/b.txt"] }))).rejects.toBeInstanceOf(
      ShellError,
    );
  });

  it("expandRedirTarget returns the single match", async () => {
    const w = words("echo *.txt")[1]!;
    const out = await expandRedirTarget(w, rt({ files: ["/only.txt"] }));
    expect(out).toBe("/only.txt");
  });
});

describe("expand: segmentToRegExp", () => {
  it("* matches within a segment but not /", () => {
    const re = segmentToRegExp("*.txt");
    expect(re.test("a.txt")).toBe(true);
    expect(re.test("a/b.txt")).toBe(false);
  });

  it("? matches a single char", () => {
    const re = segmentToRegExp("a?c");
    expect(re.test("abc")).toBe(true);
    expect(re.test("ac")).toBe(false);
  });

  it("[a-c] character class", () => {
    const re = segmentToRegExp("[a-c]");
    expect(re.test("b")).toBe(true);
    expect(re.test("d")).toBe(false);
  });
});
