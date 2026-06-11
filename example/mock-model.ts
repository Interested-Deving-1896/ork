/**
 * Scripted mock LanguageModelV2 — runs under tsx with no LLM key.
 *
 * Copied from `scripts/e2e.ts`: we re-implement the tiny LanguageModelV2
 * streaming surface directly rather than importing `ai/test`, because `ai/test`
 * eagerly pulls in `@ai-sdk/provider-utils/test` -> vitest, which cannot load
 * outside the vitest runner. This drives the exact same harness wire path
 * (stream-start / text-* / tool-call with JSON-stringified input / finish).
 *
 * The exported `Step` shape is the demo-facing one:
 *   { text: "..." }                                   → a final assistant turn
 *   { toolCalls: [{ tool, input }, ...] }             → one or more tool calls
 */
import type {
  LanguageModelV2,
  LanguageModelV2StreamPart,
  LanguageModelV2FinishReason,
} from "@ai-sdk/provider";

/** One scripted model step, in demo-facing shape. */
export type Step =
  | { text: string }
  | { toolCalls: Array<{ tool: string; input: unknown }> };

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function streamFromParts(
  parts: LanguageModelV2StreamPart[],
): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

function stepToParts(step: Step, idx: number): LanguageModelV2StreamPart[] {
  const parts: LanguageModelV2StreamPart[] = [{ type: "stream-start", warnings: [] }];
  let finishReason: LanguageModelV2FinishReason = "stop";
  if ("text" in step) {
    const id = `t${idx}`;
    parts.push(
      { type: "text-start", id },
      { type: "text-delta", id, delta: step.text },
      { type: "text-end", id },
    );
  } else {
    finishReason = "tool-calls";
    step.toolCalls.forEach((c, i) => {
      parts.push({
        type: "tool-call",
        toolCallId: `call-${idx}-${i}`,
        toolName: c.tool,
        input: JSON.stringify(c.input),
      });
    });
  }
  parts.push({ type: "finish", finishReason, usage: USAGE });
  return parts;
}

/**
 * Build a LanguageModelV2 that emits `steps` in order across doStream calls.
 *
 * `delayMs` (optional, default 0) holds each turn open for that long before
 * emitting its stream — useful to keep a per-session turn lock reliably in
 * flight while an overlapping request arrives (see scripts/e2e.ts).
 */
export function scriptedModel(steps: Step[], delayMs = 0): LanguageModelV2 {
  let call = 0;
  return {
    specificationVersion: "v2",
    provider: "mock-provider",
    modelId: "mock-model-id",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("doGenerate not used by the streaming harness");
    },
    doStream: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const step: Step = steps[call] ?? { text: "" };
      const parts = stepToParts(step, call);
      call += 1;
      return { stream: streamFromParts(parts) };
    },
  };
}
