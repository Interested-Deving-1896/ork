import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { compact, estimateTokens } from "../src/index.js";

function msg(role: "user" | "assistant", content: string): ModelMessage {
  return { role, content } as ModelMessage;
}

describe("estimateTokens", () => {
  it("grows with content length", () => {
    const small = estimateTokens([msg("user", "hi")]);
    const big = estimateTokens([msg("user", "x".repeat(4000))]);
    expect(big).toBeGreaterThan(small);
  });
});

describe("compact", () => {
  it("returns messages unchanged when under budget", () => {
    const messages = [msg("user", "a"), msg("assistant", "b")];
    expect(compact(messages, 1000)).toBe(messages);
  });

  it("returns unchanged when at or below KEEP_LAST count regardless of size", () => {
    const messages = Array.from({ length: 5 }, () => msg("user", "x".repeat(10000)));
    // budget tiny, but <= KEEP_LAST (10) -> unchanged
    expect(compact(messages, 1)).toBe(messages);
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
});
