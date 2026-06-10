import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { compact, estimateTokens } from "../src/index.js";

function msg(role: "user" | "assistant", content: string): ModelMessage {
  return { role, content } as ModelMessage;
}

function toolCallMsg(id: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "Bash", input: {} }],
  } as ModelMessage;
}

function toolResultMsg(id: string): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "Bash", output: { type: "text", value: "ok" } }],
  } as ModelMessage;
}

/** True if a message is a tool-result (role "tool"). */
function isToolResult(m: ModelMessage): boolean {
  return m.role === "tool";
}

describe("estimateTokens", () => {
  it("grows with content length", () => {
    const small = estimateTokens([msg("user", "hi")]);
    const big = estimateTokens([msg("user", "x".repeat(4000))]);
    expect(big).toBeGreaterThan(small);
  });
});

describe("compact", () => {
  it("returns equal content but a fresh array (not aliased) when under budget", () => {
    const messages = [msg("user", "a"), msg("assistant", "b")];
    const out = compact(messages, 1000);
    expect(out).toEqual(messages);
    expect(out).not.toBe(messages);
  });

  it("returns equal content but a fresh array when at or below KEEP_LAST count", () => {
    const messages = Array.from({ length: 5 }, () => msg("user", "x".repeat(10000)));
    // budget tiny, but <= KEEP_LAST (10) -> content unchanged, fresh array
    const out = compact(messages, 1);
    expect(out).toEqual(messages);
    expect(out).not.toBe(messages);
  });

  it("truncates older messages and inserts a synthetic note when over budget", () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg("user", `m${i} ` + "x".repeat(500)));
    const out = compact(messages, 100);
    expect(out.length).toBeLessThan(messages.length);
    const head = out[0];
    expect(head && head.role).toBe("system");
    expect(head && typeof head.content === "string" && head.content).toContain("omitted");
    // Last message preserved verbatim.
    expect(out[out.length - 1]).toBe(messages[messages.length - 1]);
  });

  it("over-budget compaction keeps system note first and last messages", () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg("user", `m${i} ` + "x".repeat(500)));
    const out = compact(messages, 100);
    expect(out[0] && out[0].role).toBe("system");
    expect(out[out.length - 1]).toBe(messages[messages.length - 1]);
    expect(out.length).toBeLessThan(messages.length);
  });

  it("does not start the kept tail with an orphaned tool-result", () => {
    // Build 30 messages. Arrange so the naive slice(-10) start (index 20) is a
    // tool-result whose tool-call lives at index 19 (dropped). The compactor
    // must walk forward so the kept tail starts on a clean boundary.
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 19; i++) messages.push(msg("user", `u${i} ` + "x".repeat(500)));
    // The tool-call (index 19) sits just before the naive cut; its result (index
    // 20 == slice start, index -10) would be orphaned if we keep the naive slice.
    messages.push(toolCallMsg("c1")); // 19 -> index -11 (dropped by naive slice)
    messages.push(toolResultMsg("c1")); // 20 -> index -10 (naive slice start) ORPHAN
    for (let i = 0; i < 9; i++) messages.push(msg("user", `t${i} ` + "x".repeat(500))); // 21..29

    const out = compact(messages, 100);
    // index 0 is the synthetic system note
    expect(out[0] && out[0].role).toBe("system");
    const firstKept = out[1];
    expect(firstKept && isToolResult(firstKept)).toBe(false);

    // No tool-result in the output precedes (lacks) its matching tool-call.
    const seenCallIds = new Set<string>();
    for (const m of out) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === "object" && (part as { type?: string }).type === "tool-call") {
            seenCallIds.add((part as { toolCallId: string }).toolCallId);
          }
        }
      }
      if (m.role === "tool" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === "object" && (part as { type?: string }).type === "tool-result") {
            expect(seenCallIds.has((part as { toolCallId: string }).toolCallId)).toBe(true);
          }
        }
      }
    }
  });
});
