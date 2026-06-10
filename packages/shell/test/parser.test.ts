import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { ShellParseError } from "../src/errors.js";
import type {
  SimpleCommand,
  IfNode,
  WhileNode,
  ForNode,
  Word,
} from "../src/ast.js";

// ---- helpers --------------------------------------------------------------

// The single statement of a one-statement script.
function onlyStatement(src: string) {
  const script = parse(src);
  expect(script.statements.length).toBe(1);
  return script.statements[0]!;
}

// The single pipeline (no &&/||) with a single command of a one-statement script.
function onlyCommand(src: string) {
  const stmt = onlyStatement(src);
  expect(stmt.andOr.rest.length).toBe(0);
  expect(stmt.andOr.first.commands.length).toBe(1);
  return stmt.andOr.first.commands[0]!;
}

function simple(src: string): SimpleCommand {
  const cmd = onlyCommand(src);
  expect(cmd.kind).toBe("simple");
  return cmd as SimpleCommand;
}

// A bare unquoted word with a single literal part.
function lit(text: string, quoted = false): Word {
  return [{ kind: "literal", text, quoted }];
}

// ---- simple commands ------------------------------------------------------

describe("parser: simple commands", () => {
  it("parses a simple command with arguments", () => {
    const cmd = simple("echo hello world");
    expect(cmd.assignments).toEqual([]);
    expect(cmd.redirections).toEqual([]);
    expect(cmd.words).toEqual([lit("echo"), lit("hello"), lit("world")]);
  });

  it("assignment-only command FOO=bar", () => {
    const cmd = simple("FOO=bar");
    expect(cmd.words).toEqual([]);
    expect(cmd.assignments).toEqual([{ name: "FOO", value: lit("bar") }]);
  });

  it("assignment prefix FOO=bar cmd", () => {
    const cmd = simple("FOO=bar echo hi");
    expect(cmd.assignments).toEqual([{ name: "FOO", value: lit("bar") }]);
    expect(cmd.words).toEqual([lit("echo"), lit("hi")]);
  });

  it("multiple assignment prefixes", () => {
    const cmd = simple("A=1 B=2 run");
    expect(cmd.assignments).toEqual([
      { name: "A", value: lit("1") },
      { name: "B", value: lit("2") },
    ]);
    expect(cmd.words).toEqual([lit("run")]);
  });

  it("assignment with empty value FOO=", () => {
    const cmd = simple("FOO=");
    expect(cmd.assignments).toEqual([{ name: "FOO", value: lit("", true) }]);
  });

  it("assignment value preserves expansions", () => {
    const cmd = simple("FOO=$BAR");
    expect(cmd.assignments).toEqual([
      { name: "FOO", value: [{ kind: "var", name: "BAR" }] },
    ]);
  });

  it("a word that merely contains '=' but is not bare-leading is a plain arg", () => {
    // After the first non-assignment word, FOO=bar is just an argument.
    const cmd = simple("echo FOO=bar");
    expect(cmd.assignments).toEqual([]);
    expect(cmd.words).toEqual([lit("echo"), lit("FOO=bar")]);
  });
});

// ---- pipelines & and/or ---------------------------------------------------

describe("parser: pipelines and and/or", () => {
  it("3-stage pipeline", () => {
    const cmd = onlyStatement("a | b | c");
    const pipe = cmd.andOr.first;
    expect(pipe.commands.length).toBe(3);
    expect(pipe.commands.map((c) => (c as SimpleCommand).words[0])).toEqual([
      lit("a"),
      lit("b"),
      lit("c"),
    ]);
  });

  it("a && b || c ; d", () => {
    const script = parse("a && b || c ; d");
    expect(script.statements.length).toBe(2);
    const first = script.statements[0]!;
    expect(first.andOr.first.commands[0]).toMatchObject({ words: [lit("a")] });
    expect(first.andOr.rest.map((r) => r.op)).toEqual(["&&", "||"]);
    expect(first.andOr.rest[0]!.pipeline.commands[0]).toMatchObject({ words: [lit("b")] });
    expect(first.andOr.rest[1]!.pipeline.commands[0]).toMatchObject({ words: [lit("c")] });
    const second = script.statements[1]!;
    expect(second.andOr.first.commands[0]).toMatchObject({ words: [lit("d")] });
  });

  it("background cmd &", () => {
    const stmt = onlyStatement("sleep 1 &");
    expect(stmt.background).toBe(true);
    expect(stmt.andOr.first.commands[0]).toMatchObject({ words: [lit("sleep"), lit("1")] });
  });

  it("non-background statement has background=false", () => {
    const stmt = onlyStatement("echo hi");
    expect(stmt.background).toBe(false);
  });

  it("multiple statements separated by newline", () => {
    const script = parse("a\nb\nc");
    expect(script.statements.length).toBe(3);
  });

  it("empty input yields no statements", () => {
    expect(parse("").statements).toEqual([]);
    expect(parse("   \n  \n").statements).toEqual([]);
  });
});

// ---- redirections ---------------------------------------------------------

describe("parser: redirections", () => {
  it("> truncate to fd 1", () => {
    const cmd = simple("echo hi > out.txt");
    expect(cmd.redirections).toEqual([{ fd: 1, op: ">", target: lit("out.txt") }]);
  });

  it(">> append to fd 1", () => {
    const cmd = simple("echo hi >> out.txt");
    expect(cmd.redirections).toEqual([{ fd: 1, op: ">>", target: lit("out.txt") }]);
  });

  it("< input on fd 0", () => {
    const cmd = simple("cat < in.txt");
    expect(cmd.redirections).toEqual([{ fd: 0, op: "<", target: lit("in.txt") }]);
  });

  it("2> stderr to file", () => {
    const cmd = simple("cmd 2> err.log");
    expect(cmd.redirections).toEqual([{ fd: 2, op: ">", target: lit("err.log") }]);
  });

  it("2>> stderr append", () => {
    const cmd = simple("cmd 2>> err.log");
    expect(cmd.redirections).toEqual([{ fd: 2, op: ">>", target: lit("err.log") }]);
  });

  it("2>&1 dup with null target", () => {
    const cmd = simple("cmd 2>&1");
    expect(cmd.redirections).toEqual([{ fd: 2, op: "2>&1", target: null }]);
  });

  it("> f 2>&1 combined", () => {
    const cmd = simple("cmd > f 2>&1");
    expect(cmd.redirections).toEqual([
      { fd: 1, op: ">", target: lit("f") },
      { fd: 2, op: "2>&1", target: null },
    ]);
  });

  it("redirection without a command (redir-only) is allowed", () => {
    const cmd = simple("> out.txt");
    expect(cmd.words).toEqual([]);
    expect(cmd.redirections).toEqual([{ fd: 1, op: ">", target: lit("out.txt") }]);
  });

  it("redirection missing a target is an error", () => {
    expect(() => parse("echo hi >")).toThrow(ShellParseError);
  });
});

// ---- heredocs -------------------------------------------------------------

describe("parser: heredocs", () => {
  it("expanding heredoc (unquoted delimiter)", () => {
    const cmd = simple("cat <<EOF\nhello $NAME\nEOF\n");
    expect(cmd.redirections.length).toBe(1);
    const r = cmd.redirections[0]!;
    expect(r.op).toBe("heredoc");
    expect(r.fd).toBe(0);
    expect(r.target).toBeNull();
    expect(r.heredoc).toEqual({ body: "hello $NAME\n", expand: true });
  });

  it("non-expanding heredoc (quoted delimiter)", () => {
    const cmd = simple("cat <<'EOF'\nraw $NAME\nEOF\n");
    const r = cmd.redirections[0]!;
    expect(r.op).toBe("heredoc");
    expect(r.heredoc).toEqual({ body: "raw $NAME\n", expand: false });
  });
});

// ---- if / elif / else -----------------------------------------------------

describe("parser: if", () => {
  it("if/then/fi", () => {
    const cmd = onlyCommand("if true; then echo yes; fi") as IfNode;
    expect(cmd.kind).toBe("if");
    expect(cmd.clauses.length).toBe(1);
    expect(cmd.elseBody).toBeNull();
    const cond = cmd.clauses[0]!.cond;
    expect(cond.statements[0]!.andOr.first.commands[0]).toMatchObject({ words: [lit("true")] });
    expect(cmd.clauses[0]!.body.statements[0]!.andOr.first.commands[0]).toMatchObject({
      words: [lit("echo"), lit("yes")],
    });
  });

  it("if/elif/else/fi", () => {
    const cmd = onlyCommand("if a; then x; elif b; then y; else z; fi") as IfNode;
    expect(cmd.clauses.length).toBe(2);
    expect(cmd.clauses[0]!.cond.statements[0]!.andOr.first.commands[0]).toMatchObject({
      words: [lit("a")],
    });
    expect(cmd.clauses[1]!.cond.statements[0]!.andOr.first.commands[0]).toMatchObject({
      words: [lit("b")],
    });
    expect(cmd.elseBody).not.toBeNull();
    expect(cmd.elseBody!.statements[0]!.andOr.first.commands[0]).toMatchObject({
      words: [lit("z")],
    });
  });

  it("'if' as a quoted word is not a keyword", () => {
    const cmd = simple("echo 'if'");
    expect(cmd.words).toEqual([lit("echo"), lit("if", true)]);
  });

  it("if with trailing redirection", () => {
    const cmd = onlyCommand("if a; then b; fi > out") as IfNode;
    expect(cmd.redirections).toEqual([{ fd: 1, op: ">", target: lit("out") }]);
  });
});

// ---- while ----------------------------------------------------------------

describe("parser: while", () => {
  it("while/do/done", () => {
    const cmd = onlyCommand("while cond; do step; done") as WhileNode;
    expect(cmd.kind).toBe("while");
    expect(cmd.cond.statements[0]!.andOr.first.commands[0]).toMatchObject({ words: [lit("cond")] });
    expect(cmd.body.statements[0]!.andOr.first.commands[0]).toMatchObject({ words: [lit("step")] });
  });

  it("nested if inside while", () => {
    const cmd = onlyCommand("while c; do if a; then b; fi; done") as WhileNode;
    expect(cmd.kind).toBe("while");
    const inner = cmd.body.statements[0]!.andOr.first.commands[0] as IfNode;
    expect(inner.kind).toBe("if");
    expect(inner.clauses[0]!.cond.statements[0]!.andOr.first.commands[0]).toMatchObject({
      words: [lit("a")],
    });
  });
});

// ---- for ------------------------------------------------------------------

describe("parser: for", () => {
  it("for NAME in items; do ...; done", () => {
    const cmd = onlyCommand("for x in a b c; do echo $x; done") as ForNode;
    expect(cmd.kind).toBe("for");
    expect(cmd.varName).toBe("x");
    expect(cmd.items).toEqual([lit("a"), lit("b"), lit("c")]);
    expect(cmd.body.statements[0]!.andOr.first.commands[0]).toMatchObject({
      words: [lit("echo"), [{ kind: "var", name: "x" }]],
    });
  });

  it("for with an empty item list", () => {
    const cmd = onlyCommand("for x in ; do echo $x; done") as ForNode;
    expect(cmd.items).toEqual([]);
  });
});

// ---- rejections -----------------------------------------------------------

describe("parser: rejects out-of-scope constructs", () => {
  it("rejects function definition foo() {}", () => {
    expect(() => parse("foo() { echo hi; }")).toThrow(ShellParseError);
    expect(() => parse("foo() { echo hi; }")).toThrow(/function/);
  });

  it("rejects case", () => {
    expect(() => parse("case x in a) echo a;; esac")).toThrow(ShellParseError);
  });

  it("rejects subshell grouping ( )", () => {
    expect(() => parse("(echo hi)")).toThrow(/subshell/);
  });

  it("rejects unclosed if (missing fi)", () => {
    expect(() => parse("if a; then b")).toThrow(ShellParseError);
  });

  it("rejects unclosed while (missing done)", () => {
    expect(() => parse("while a; do b")).toThrow(ShellParseError);
  });

  it("rejects stray fi", () => {
    expect(() => parse("fi")).toThrow(ShellParseError);
  });

  it("rejects 'then' in command position", () => {
    expect(() => parse("then echo")).toThrow(ShellParseError);
  });

  it("rejects a recursion depth bomb", () => {
    // 200 nested if-conditions exceed MAX_DEPTH (100).
    const bomb = "if ".repeat(200) + "x" + "; then y; fi".repeat(200);
    expect(() => parse(bomb)).toThrow(/depth/);
  });

  it("rejects token-limit overflow", () => {
    const huge = Array.from({ length: 9000 }, (_, i) => `w${i}`).join(" ");
    expect(() => parse(huge)).toThrow(/token limit/);
  });
});
