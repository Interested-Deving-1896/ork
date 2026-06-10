import type { ModelMessage } from "ai";

/** Number of most-recent messages always kept verbatim during compaction. */
const KEEP_LAST = 10;

/**
 * Rough token estimate: ~4 chars per token over the JSON-serialized content.
 * Good enough to decide *when* to compact; we never bill on this.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

/**
 * v1 compaction — deterministic, no model call.
 *
 * If the estimated token count is within `tokenBudget`, return `messages`
 * unchanged. Otherwise, keep the last {@link KEEP_LAST} messages verbatim and
 * replace everything before them with a single synthetic system note marking
 * that earlier conversation was omitted. The FS is the durable context, so
 * dropping old turns is safe: the agent re-reads files when it needs them.
 *
 * This is intentionally simple (truncation, not summarization). A model-backed
 * summarizer can replace the body later without changing the call site.
 */
export function compact(messages: ModelMessage[], tokenBudget: number): ModelMessage[] {
  if (messages.length <= KEEP_LAST) return messages;
  if (estimateTokens(messages) <= tokenBudget) return messages;

  const tail = messages.slice(-KEEP_LAST);
  const droppedCount = messages.length - tail.length;
  const note: ModelMessage = {
    role: "system",
    content: `[earlier conversation omitted: ${droppedCount} message(s) compacted to fit the context budget. Files in the virtual filesystem are unaffected — read them if you need prior state.]`,
  };
  return [note, ...tail];
}
