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
  // Always return a FRESH array on every path. The call site rebuilds the live
  // `messages` array from this result; if we returned the same reference,
  // clearing `messages` before re-pushing would wipe the source (see session.ts).
  if (messages.length <= KEEP_LAST) return [...messages];
  if (estimateTokens(messages) <= tokenBudget) return [...messages];

  // Target the last KEEP_LAST messages, then walk the boundary forward so the
  // kept tail starts on a provider-valid message (never an orphaned tool-result
  // whose originating tool-call was dropped).
  let cut = messages.length - KEEP_LAST;
  cut = advancePastOrphans(messages, cut);

  const tail = messages.slice(cut);
  const droppedCount = cut; // everything before `cut` is omitted
  const note: ModelMessage = {
    role: "system",
    content: `[earlier conversation omitted: ${droppedCount} message(s) compacted to fit the context budget. Files in the virtual filesystem are unaffected — read them if you need prior state.]`,
  };
  return [note, ...tail];
}

/**
 * Given a candidate cut index, advance it forward until the first kept message
 * is a clean boundary: a `user` message or a plain assistant text message. This
 * drops any leading tool-result (whose tool-call was dropped) and any leading
 * assistant tool-call message whose results would be split. We never advance
 * past the last message, so at least one message is always kept.
 */
function advancePastOrphans(messages: ModelMessage[], cut: number): number {
  let i = cut;
  const last = messages.length - 1;
  while (i < last && !isCleanBoundary(messages[i]!)) {
    i += 1;
  }
  return i;
}

/** A "clean" first-kept message: a user message or a plain assistant text message. */
function isCleanBoundary(m: ModelMessage): boolean {
  if (m.role === "user") return true;
  if (m.role === "assistant") {
    // Plain text assistant message is a valid start; one that carries tool-calls
    // is not (its tool-results may or may not all be kept — drop it to be safe).
    if (typeof m.content === "string") return true;
    if (Array.isArray(m.content)) {
      return !m.content.some(
        (part) =>
          part !== null &&
          typeof part === "object" &&
          (part as { type?: string }).type === "tool-call",
      );
    }
    return true;
  }
  // role "tool" (tool-result) or "system" — not a clean start for the tail.
  return false;
}
