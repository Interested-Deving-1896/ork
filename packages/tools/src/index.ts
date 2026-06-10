import { tool, type Tool } from "ai";
import type { ToolContext } from "./context.js";
import { bashInputSchema, bashTool, type BashInput } from "./tools/bash.js";
import { readFileTool, readInputSchema, type ReadInput } from "./tools/read.js";
import { writeFileTool, writeInputSchema, type WriteInput } from "./tools/write.js";
import { editFileTool, editInputSchema, EditError, type EditInput } from "./tools/edit.js";
import { globInputSchema, globTool, type GlobInput } from "./tools/glob.js";
import { grepInputSchema, grepTool, type GrepInput } from "./tools/grep.js";

export const TOOLS_VERSION = "0.0.1";

// ---- shared context ---------------------------------------------------------
export { type ToolContext } from "./context.js";

// ---- core functions + schemas + types --------------------------------------
export { bashTool, bashInputSchema, BASH_OUTPUT_CAP, type BashInput, type BashResult } from "./tools/bash.js";
export { readFileTool, readInputSchema, type ReadInput, type ReadResult } from "./tools/read.js";
export { writeFileTool, writeInputSchema, type WriteInput, type WriteResult } from "./tools/write.js";
export { editFileTool, editInputSchema, EditError, type EditInput, type EditResult } from "./tools/edit.js";
export { globTool, globInputSchema, type GlobInput, type GlobResult } from "./tools/glob.js";
export { grepTool, grepInputSchema, type GrepInput, type GrepResult } from "./tools/grep.js";
export { globToRegExp } from "./glob-match.js";
export { walkFiles } from "./walk.js";

// ---- Claude-Code-style tool descriptions (sent to the model) ----------------
const DESCRIPTIONS = {
  Bash: "Executes a shell command in the virtual filesystem and returns its stdout, stderr, and exit code. Use for running pipelines, inspecting state, and file operations not covered by the dedicated tools.",
  Read: "Reads a file from the filesystem and returns its contents with cat -n style line numbers. Supports reading a slice via offset (1-based line) and limit. Use before editing a file.",
  Write: "Writes content to a file, creating parent directories as needed and overwriting any existing file. Prefer Edit for changing part of an existing file.",
  Edit: "Performs an exact string replacement in a file. old_string must match exactly and be unique unless replace_all is set; new_string must differ from old_string.",
  Glob: "Finds files matching a glob pattern (supports **, *, ?, [...]) under an optional path. Returns matching paths, one per line.",
  Grep: "Searches file contents for a regular expression. Supports filtering files by glob, case-insensitive matching, line numbers, context lines, and output modes (files_with_matches, content, count).",
} as const;

/**
 * AI SDK tool set returned by {@link createTools}: the six Claude-Code tools,
 * each bound to a fixed context. Built with the real `ai` v5 `tool()` helper
 * (which takes `description`, `inputSchema`, `execute`). The `execute` of each
 * tool returns the model-facing string; structured results stay accessible via
 * the exported core functions.
 */
export interface OrkTools {
  Bash: Tool<BashInput, string>;
  Read: Tool<ReadInput, string>;
  Write: Tool<WriteInput, string>;
  Edit: Tool<EditInput, string>;
  Glob: Tool<GlobInput, string>;
  Grep: Tool<GrepInput, string>;
}

/**
 * Wrap the core tool functions as AI SDK tools bound to `ctx`. The model calls
 * these; tests should prefer the exported core functions directly.
 */
export function createTools(ctx: ToolContext): OrkTools {
  return {
    Bash: tool({
      description: DESCRIPTIONS.Bash,
      inputSchema: bashInputSchema,
      execute: async (input) => (await bashTool(input, ctx)).output,
    }),
    Read: tool({
      description: DESCRIPTIONS.Read,
      inputSchema: readInputSchema,
      execute: async (input) => (await readFileTool(input, ctx)).output,
    }),
    Write: tool({
      description: DESCRIPTIONS.Write,
      inputSchema: writeInputSchema,
      execute: async (input) => (await writeFileTool(input, ctx)).output,
    }),
    Edit: tool({
      description: DESCRIPTIONS.Edit,
      inputSchema: editInputSchema,
      execute: async (input) => {
        try {
          return (await editFileTool(input, ctx)).output;
        } catch (err) {
          if (err instanceof EditError) return `Error: ${err.message}`;
          throw err;
        }
      },
    }),
    Glob: tool({
      description: DESCRIPTIONS.Glob,
      inputSchema: globInputSchema,
      execute: async (input) => (await globTool(input, ctx)).output,
    }),
    Grep: tool({
      description: DESCRIPTIONS.Grep,
      inputSchema: grepInputSchema,
      execute: async (input) => (await grepTool(input, ctx)).output,
    }),
  };
}
