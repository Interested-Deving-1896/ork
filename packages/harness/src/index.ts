export const HARNESS_VERSION = "0.0.1";

export type { SessionEvent } from "./events.js";
export { defaultSystemPrompt, type SystemPromptEnv } from "./system-prompt.js";
export {
  createSession,
  restoreSession,
  type Session,
  type SessionConfig,
  type RestoreSessionArgs,
} from "./session.js";
export { compact, estimateTokens } from "./compaction.js";
