// Word expansion: resolve a list of Words (from the parser, with expansions left
// UNRESOLVED) into the final argv fields.
//
// Order of operations per Word, matching a simplified bash:
//   1. Parameter expansion ($VAR/${VAR}) and command substitution ($(...)).
//   2. Word (field) splitting of UNQUOTED expansion results on whitespace.
//   3. Pathname (glob) expansion of unquoted fields containing * ? [.
// Quoted literals and var-quoted/quoted-cmdsub results never split or glob.
//
// We model a Word's expansion as a list of "segments". Each segment is a string
// with a per-region quoted flag tracked at a coarse level: literal-quoted and
// quoted-expansion regions are marked quoted (no split/glob); unquoted regions
// are marked unquoted. Adjacent parts concatenate into the same field until an
// unquoted expansion introduces a split point.

import { ShellError } from "./errors.js";
import type { Word, WordPart } from "./ast.js";

const MAX_CMDSUB_DEPTH = 16;

/** Capture result of recursively running a command-substitution body. */
export interface CaptureResult {
  stdout: string;
  exitCode: number;
}

/** Runtime hooks the expander needs from the interpreter. */
export interface ExpandRuntime {
  /** Resolve a variable name to its value, or undefined if unset. */
  lookup(name: string): string | undefined;
  /** Recursively parse + execute a script, capturing stdout. */
  runCapture(script: string): Promise<CaptureResult>;
  /** Glob a pattern against the VFS; returns sorted matches or null on no match. */
  glob(pattern: string): Promise<string[] | null>;
  /** Current command-substitution nesting depth (for the ≤16 guard). */
  cmdsubDepth: number;
}

// A field under construction. `chunks` are (text, quoted) runs; a field is split
// only at unquoted whitespace inside unquoted-expansion text.
interface FieldBuilder {
  // accumulated text of the current field
  text: string;
  // whether any chunk contributing so far was unquoted (controls glob eligibility)
  hasUnquoted: boolean;
  // whether the current field contains glob metachars from an unquoted region
  globbable: boolean;
  // whether the field received a "concrete" contribution: a literal (quoted or
  // unquoted) or a non-empty unquoted-expansion piece. A field that ends up
  // empty AND non-present (e.g. a bare unset $VAR) is dropped, matching bash.
  present: boolean;
}

function freshField(): FieldBuilder {
  return { text: "", hasUnquoted: false, globbable: false, present: false };
}

const GLOB_META = /[*?[]/;

/**
 * Expand a Word list into argv fields (with field-splitting and globbing).
 */
export async function expandWords(words: Word[], rt: ExpandRuntime): Promise<string[]> {
  const out: string[] = [];
  for (const word of words) {
    const allFields = await expandOneWord(word, rt, /* split */ true);
    // Drop fields that are empty AND received no concrete contribution (e.g. a
    // word that was a single unset/empty unquoted $VAR vanishes entirely).
    const fields = allFields.filter((f) => f.present || f.text.length > 0);
    // Glob each eligible field.
    for (const f of fields) {
      if (f.globbable && GLOB_META.test(f.text)) {
        const matches = await rt.glob(f.text);
        if (matches && matches.length > 0) {
          out.push(...matches);
        } else {
          out.push(f.text); // bash default: no match keeps the literal pattern
        }
      } else {
        out.push(f.text);
      }
    }
  }
  return out;
}

/**
 * Expand a single Word to a single string (no field-splitting, no globbing).
 * Used for redirection targets and assignment values. cmdsub is allowed. A glob
 * in a redirection-target context that would yield multiple fields is impossible
 * here (no split), but callers that DO want to detect ambiguous globs should use
 * expandRedirTarget.
 */
export async function expandWordSingle(word: Word, rt: ExpandRuntime): Promise<string> {
  const fields = await expandOneWord(word, rt, /* split */ false);
  // No split → exactly one field.
  return fields.map((f) => f.text).join("");
}

/**
 * Expand a redirection target: no field-splitting, but DO glob; multiple matches
 * → "ambiguous redirect" ShellError. Zero matches keeps the literal.
 */
export async function expandRedirTarget(word: Word, rt: ExpandRuntime): Promise<string> {
  const fields = await expandOneWord(word, rt, /* split */ false);
  const f = fields[0] ?? freshField();
  if (f.globbable && GLOB_META.test(f.text)) {
    const matches = await rt.glob(f.text);
    if (matches && matches.length > 1) {
      throw new ShellError(`ambiguous redirect: ${f.text}`);
    }
    if (matches && matches.length === 1) return matches[0]!;
  }
  return f.text;
}

// Core: expand one Word into FieldBuilders. When split=false, always returns a
// single field; when split=true, unquoted-expansion whitespace creates breaks.
async function expandOneWord(
  word: Word,
  rt: ExpandRuntime,
  split: boolean,
): Promise<FieldBuilder[]> {
  const fields: FieldBuilder[] = [freshField()];
  const cur = (): FieldBuilder => fields[fields.length - 1]!;

  // A literal contribution (quoted or unquoted): never field-split. Always marks
  // the field present (so `""` or `pre` keep an argument). Unquoted literals are
  // glob-eligible.
  const appendLiteral = (text: string, unquoted: boolean): void => {
    const f = cur();
    f.text += text;
    f.present = true;
    if (unquoted) {
      f.hasUnquoted = true;
      f.globbable = true;
    }
  };

  // Append a run of non-whitespace from an unquoted expansion: glob-eligible,
  // and marks the field present (non-empty unquoted-expansion content).
  const appendExpansionChunk = (text: string): void => {
    const f = cur();
    f.text += text;
    f.present = true;
    f.hasUnquoted = true;
    f.globbable = true;
  };

  // Append text that came from an UNQUOTED expansion, performing field-splitting
  // on whitespace runs when split=true. An empty result contributes nothing and
  // does NOT mark the field present (so a bare unset $VAR vanishes).
  const appendSplit = (text: string): void => {
    if (text.length === 0) return;
    if (!split) {
      appendExpansionChunk(text);
      return;
    }
    let buf = "";
    let pendingBreak = false;
    const commit = (): void => {
      if (buf.length > 0) {
        if (pendingBreak) {
          fields.push(freshField());
          pendingBreak = false;
        }
        appendExpansionChunk(buf);
        buf = "";
      }
    };
    for (const ch of text) {
      if (ch === " " || ch === "\t" || ch === "\n") {
        commit();
        pendingBreak = true;
      } else {
        buf += ch;
      }
    }
    commit();
    // A trailing break is dropped: no trailing empty field.
  };

  for (const part of word) {
    await expandPart(part, rt, { appendLiteral, appendSplit });
  }
  return fields;
}

interface PartSink {
  appendLiteral(text: string, unquoted: boolean): void;
  appendSplit(text: string): void;
}

async function expandPart(part: WordPart, rt: ExpandRuntime, sink: PartSink): Promise<void> {
  switch (part.kind) {
    case "literal":
      // Literals never glob/split; even unquoted literal text with glob chars is
      // globbable, so mark unquoted literals as glob-eligible but not split.
      if (part.quoted) {
        sink.appendLiteral(part.text, false);
      } else {
        // Unquoted literal: contributes glob metachars but is not field-split
        // (the lexer already split words at unquoted whitespace).
        sink.appendLiteral(part.text, true);
      }
      return;
    case "var-quoted": {
      const val = rt.lookup(part.name) ?? "";
      sink.appendLiteral(val, false);
      return;
    }
    case "var": {
      const val = rt.lookup(part.name) ?? "";
      sink.appendSplit(val);
      return;
    }
    case "cmdsub": {
      if (rt.cmdsubDepth >= MAX_CMDSUB_DEPTH) {
        throw new ShellError(`command substitution nested too deep (max ${MAX_CMDSUB_DEPTH})`);
      }
      const res = await rt.runCapture(part.script);
      const stripped = stripTrailingNewlines(res.stdout);
      if (part.quoted) {
        sink.appendLiteral(stripped, false);
      } else {
        sink.appendSplit(stripped);
      }
      return;
    }
  }
}

function stripTrailingNewlines(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "\n") end--;
  return s.slice(0, end);
}

// ---- Glob matching ---------------------------------------------------------

/** Compile a single path-segment glob pattern to a RegExp. */
export function segmentToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "[") {
      // bracket expression: copy until matching ]
      let j = i + 1;
      let negate = false;
      if (pattern[j] === "!" || pattern[j] === "^") {
        negate = true;
        j++;
      }
      let body = "";
      // a ] right after [ (or [!) is a literal
      if (pattern[j] === "]") {
        body += "\\]";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        const ch = pattern[j]!;
        if (ch === "\\") {
          body += "\\\\";
        } else if ("^$.*+?()|{}".includes(ch)) {
          body += "\\" + ch;
        } else {
          body += ch;
        }
        j++;
      }
      if (j >= pattern.length) {
        // unterminated [ → treat the [ as a literal
        re += "\\[";
        i++;
        continue;
      }
      re += "[" + (negate ? "^" : "") + body + "]";
      i = j + 1;
    } else {
      // escape regex metacharacters
      if ("^$.*+?()|{}\\".includes(c)) re += "\\" + c;
      else re += c;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** True if a path-segment pattern contains glob metacharacters. */
export function segmentHasGlob(seg: string): boolean {
  return GLOB_META.test(seg);
}
