import { MockLanguageModelV2 } from "ai/test";
import type {
  LanguageModelV2StreamPart,
  LanguageModelV2FinishReason,
} from "@ai-sdk/provider";

/**
 * A scripted "step" the mock model emits on one `doStream` call. Either a final
 * text answer, or one/more tool calls (the AI SDK runs them, then calls the
 * model again for the next step — which consumes the next script entry).
 *
 * Mirrors the proven helper in @ork/harness/test/mock-model.ts.
 */
export type ScriptStep =
  | { kind: "text"; text: string; finishReason?: LanguageModelV2FinishReason }
  | {
      kind: "tools";
      text?: string;
      calls: Array<{ toolName: string; input: unknown; toolCallId?: string }>;
      finishReason?: LanguageModelV2FinishReason;
    };

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

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function stepToParts(step: ScriptStep, idx: number): LanguageModelV2StreamPart[] {
  const parts: LanguageModelV2StreamPart[] = [{ type: "stream-start", warnings: [] }];

  if (step.kind === "text") {
    const id = `t${idx}`;
    parts.push(
      { type: "text-start", id },
      { type: "text-delta", id, delta: step.text },
      { type: "text-end", id },
      { type: "finish", finishReason: step.finishReason ?? "stop", usage },
    );
    return parts;
  }

  if (step.text) {
    const id = `t${idx}`;
    parts.push(
      { type: "text-start", id },
      { type: "text-delta", id, delta: step.text },
      { type: "text-end", id },
    );
  }
  step.calls.forEach((c, i) => {
    parts.push({
      type: "tool-call",
      toolCallId: c.toolCallId ?? `call-${idx}-${i}`,
      toolName: c.toolName,
      input: JSON.stringify(c.input),
    });
  });
  parts.push({ type: "finish", finishReason: step.finishReason ?? "tool-calls", usage });
  return parts;
}

/** Build a MockLanguageModelV2 that emits `script` steps in order. */
export function scriptedModel(script: ScriptStep[]): MockLanguageModelV2 {
  let call = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      const step = script[call] ?? { kind: "text", text: "" };
      const parts = stepToParts(step as ScriptStep, call);
      call += 1;
      return { stream: streamFromParts(parts) };
    },
  });
}

/** A model that emits an `error` stream part (mid-stream provider error). */
export function errorPartModel(message = "stream-boom"): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: streamFromParts([
        { type: "stream-start", warnings: [] },
        { type: "error", error: new Error(message) },
        { type: "finish", finishReason: "error", usage },
      ]),
    }),
  });
}
