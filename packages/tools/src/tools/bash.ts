import { z } from "zod";
import type { ToolContext } from "../context.js";

export const bashInputSchema = z.object({
  command: z.string().describe("The shell command to run."),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional timeout in milliseconds (advisory; see notes)."),
});

export type BashInput = z.infer<typeof bashInputSchema>;

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Combined model-facing string: stdout + an [stderr] section, truncated. */
  output: string;
}

/** Max characters in the model-facing combined output before truncation. */
export const BASH_OUTPUT_CAP = 30_000;

function truncate(s: string): string {
  if (s.length <= BASH_OUTPUT_CAP) return s;
  const head = s.slice(0, BASH_OUTPUT_CAP);
  return `${head}\n[output truncated: ${s.length - BASH_OUTPUT_CAP} more characters]`;
}

/**
 * Run a shell command through the ork shell. Returns the raw stdout/stderr/exit
 * code plus a combined, truncated `output` string suitable for the model.
 *
 * NOTE on `timeout`: the Shell enforces a per-pipeline wall-clock timeout via
 * its constructor option (`timeoutMs`); there is no per-call override on
 * `exec()`. The `timeout` input is accepted for contract compatibility with
 * Claude Code but is advisory in this runtime — configure the Shell's
 * `timeoutMs` when constructing the context to bound execution.
 */
export async function bashTool(input: BashInput, ctx: ToolContext): Promise<BashResult> {
  const { stdout, stderr, exitCode } = await ctx.shell.exec(input.command);

  const combined = stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout;

  return {
    stdout,
    stderr,
    exitCode,
    output: truncate(combined),
  };
}
