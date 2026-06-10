import { describe, it, expect } from "vitest";
import { tokenize, type Token } from "../src/lexer.js";
import { ShellParseError } from "../src/errors.js";
import type { WordPart } from "../src/ast.js";

function words(toks: Token[]): Token[] {
  return toks.filter((t) => t.type === "WORD");
}

describe("lexer: basic words and operators", () => {
  it("tokenizes simple words", () => {
    const t = tokenize("echo hello world");
    const w = words(t);
    expect(w.map((x) => x.text)).toEqual(["echo", "hello", "world"]);
  });

  it("recognizes pipe operators", () => {
    const t = tokenize("a | b");
    expect(t.filter((x) => x.type === "OP").map((x) => x.text)).toEqual(["|"]);
  });

  it("longest-match: && over &, || over |", () => {
    const t = tokenize("a && b || c & d");
    expect(t.filter((x) => x.type === "OP").map((x) => x.text)).toEqual(["&&", "||", "&"]);
  });

  it("emits a newline token", () => {
    const t = tokenize("a\nb");
    expect(t.some((x) => x.type === "NEWLINE")).toBe(true);
  });
});

describe("lexer: redirections (longest match)", () => {
  it("matches 2>&1 before 2>", () => {
    const t = tokenize("cmd 2>&1");
    expect(t.filter((x) => x.type === "REDIR").map((x) => x.text)).toEqual(["2>&1"]);
  });
  it("matches >> before >", () => {
    const t = tokenize("echo x >> f");
    expect(t.filter((x) => x.type === "REDIR").map((x) => x.text)).toEqual([">>"]);
  });
  it("matches 2>> and 2>", () => {
    expect(tokenize("a 2>> f").filter((x) => x.type === "REDIR")[0]?.text).toBe("2>>");
    expect(tokenize("a 2> f").filter((x) => x.type === "REDIR")[0]?.text).toBe("2>");
  });
  it("matches < and >", () => {
    expect(tokenize("a < f").filter((x) => x.type === "REDIR")[0]?.text).toBe("<");
    expect(tokenize("a > f").filter((x) => x.type === "REDIR")[0]?.text).toBe(">");
  });
});

describe("lexer: quoting", () => {
  it("single quotes are literal and quoted", () => {
    const w = words(tokenize("echo 'single $NOEXPAND'"));
    expect(w[1]?.word).toEqual<WordPart[]>([{ kind: "literal", text: "single $NOEXPAND", quoted: true }]);
  });

  it("double quotes keep var-quoted parts", () => {
    const w = words(tokenize('echo "double $VAR text"'));
    expect(w[1]?.word).toEqual<WordPart[]>([
      { kind: "literal", text: "double ", quoted: true },
      { kind: "var-quoted", name: "VAR" },
      { kind: "literal", text: " text", quoted: true },
    ]);
  });

  it("escaped space keeps one word", () => {
    const w = words(tokenize("echo a\\ b"));
    expect(w.length).toBe(2);
    expect(w[1]?.word).toEqual<WordPart[]>([{ kind: "literal", text: "a b", quoted: false }]);
  });

  it("empty double-quoted string is a distinct argument", () => {
    const w = words(tokenize('echo ""'));
    expect(w.length).toBe(2);
    expect(w[1]?.word).toEqual<WordPart[]>([{ kind: "literal", text: "", quoted: true }]);
  });
});

describe("lexer: expansions", () => {
  it("$FOO and ${BAR} unquoted become var parts", () => {
    const w = words(tokenize("echo $FOO ${BAR}"));
    expect(w[1]?.word).toEqual<WordPart[]>([{ kind: "var", name: "FOO" }]);
    expect(w[2]?.word).toEqual<WordPart[]>([{ kind: "var", name: "BAR" }]);
  });

  it("command substitution keeps raw inner text", () => {
    const w = words(tokenize("echo $(cat file)"));
    expect(w[1]?.word).toEqual<WordPart[]>([{ kind: "cmdsub", script: "cat file", quoted: false }]);
  });

  it("nested command substitution keeps full inner text", () => {
    const w = words(tokenize("echo $(echo $(echo x))"));
    expect(w[1]?.word).toEqual<WordPart[]>([
      { kind: "cmdsub", script: "echo $(echo x)", quoted: false },
    ]);
  });

  it("cmdsub inside double quotes is quoted", () => {
    const w = words(tokenize('echo "$(date)"'));
    expect(w[1]?.word).toEqual<WordPart[]>([{ kind: "cmdsub", script: "date", quoted: true }]);
  });

  it("special params like $? parse", () => {
    const w = words(tokenize("echo $?"));
    expect(w[1]?.word).toEqual<WordPart[]>([{ kind: "var", name: "?" }]);
  });
});

describe("lexer: globs survive", () => {
  it("unquoted glob is literal text", () => {
    const w = words(tokenize("ls *.txt"));
    expect(w[1]?.word).toEqual<WordPart[]>([{ kind: "literal", text: "*.txt", quoted: false }]);
  });
  it("quoted glob is quoted literal", () => {
    const w = words(tokenize('echo "*.txt"'));
    expect(w[1]?.word).toEqual<WordPart[]>([{ kind: "literal", text: "*.txt", quoted: true }]);
  });
});

describe("lexer: comments", () => {
  it("strips # to end of line at token start", () => {
    const w = words(tokenize("echo a # comment here"));
    expect(w.map((x) => x.text)).toEqual(["echo", "a"]);
  });
  it("# mid-word is literal", () => {
    const w = words(tokenize("echo a#b"));
    expect(w[1]?.text).toBe("a#b");
  });
});

describe("lexer: heredoc", () => {
  it("collects heredoc body and marks expand", () => {
    const t = tokenize("cat <<EOF\nline1\n$VAR\nEOF\n");
    const h = t.find((x) => x.type === "HEREDOC_OP");
    expect(h?.heredoc?.delimiter).toBe("EOF");
    expect(h?.heredoc?.quoted).toBe(false);
    expect(h?.text).toBe("line1\n$VAR\n");
  });
  it("quoted delimiter marks quoted=true", () => {
    const t = tokenize("cat <<'EOF'\nraw $X\nEOF\n");
    const h = t.find((x) => x.type === "HEREDOC_OP");
    expect(h?.heredoc?.quoted).toBe(true);
    expect(h?.text).toBe("raw $X\n");
  });
});

describe("lexer: errors", () => {
  it("unclosed single quote", () => {
    expect(() => tokenize("echo 'oops")).toThrow(ShellParseError);
  });
  it("unclosed double quote", () => {
    expect(() => tokenize('echo "oops')).toThrow(ShellParseError);
  });
  it("unclosed command substitution", () => {
    expect(() => tokenize("echo $(cat")).toThrow(ShellParseError);
  });
  it("backtick rejected", () => {
    expect(() => tokenize("echo `date`")).toThrow(/backtick/);
  });
  it("arithmetic expansion rejected", () => {
    expect(() => tokenize("echo $((1+1))")).toThrow(/arithmetic/);
  });
  it("param expansion operator rejected", () => {
    expect(() => tokenize("echo ${x%.foo}")).toThrow(/parameter expansion/);
  });
  it("unterminated heredoc", () => {
    expect(() => tokenize("cat <<EOF\nline\n")).toThrow(/heredoc/);
  });
});
