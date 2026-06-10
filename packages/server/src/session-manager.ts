import { randomUUID } from "node:crypto";
import {
  createSession,
  restoreSession,
  type Session,
  type SessionConfig,
} from "@ork/harness";
import {
  MemorySnapshotStore,
  type SnapshotStore,
  type PermissionsConfig,
  type Limits,
} from "@ork/kernel";
import type { LanguageModel } from "ai";

/**
 * Maps a model id string (as carried over HTTP) to a concrete model the harness
 * accepts. The default resolver is the identity function: the string is passed
 * straight to the AI SDK (gateway routing of "provider/model"). Tests inject a
 * resolver that returns a scripted mock model instance instead.
 */
export type ModelResolver = (modelId: string) => LanguageModel;

const identityResolver: ModelResolver = (modelId) => modelId;

export interface SessionManagerOptions {
  /** Snapshot store backing snapshot/restore. Defaults to an in-memory store. */
  store?: SnapshotStore;
  /** Resolves a model id string to a LanguageModel. Defaults to identity. */
  modelResolver?: ModelResolver;
}

export interface CreateArgs {
  tenant: string;
  model: string;
  files?: Record<string, string | Uint8Array>;
  system?: string;
  mounts?: PermissionsConfig["mounts"];
  network?: PermissionsConfig["network"];
  limits?: Partial<Limits>;
}

export interface RestoreArgs {
  tenant: string;
  snapshotId: string;
  model: string;
  mounts?: PermissionsConfig["mounts"];
  network?: PermissionsConfig["network"];
  limits?: Partial<Limits>;
}

interface Entry {
  session: Session;
  tenant: string;
  lastUsed: number;
  snapshotId?: string;
}

/** Raised by the manager when a lookup fails; carries an HTTP-ish status. */
export class SessionError extends Error {
  constructor(
    readonly status: 404 | 403,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Entry>();
  private readonly store: SnapshotStore;
  private readonly resolveModel: ModelResolver;

  constructor(opts: SessionManagerOptions = {}) {
    this.store = opts.store ?? new MemorySnapshotStore();
    this.resolveModel = opts.modelResolver ?? identityResolver;
  }

  /** Create a fresh session and return its id. */
  create(args: CreateArgs): string {
    const cfg: SessionConfig = {
      model: this.resolveModel(args.model),
      files: args.files,
      system: args.system,
      mounts: args.mounts,
      network: args.network,
      limits: args.limits,
    };
    const session = createSession(cfg);
    return this.store_(session, args.tenant);
  }

  /** Restore a session from a snapshot and return the new session id. */
  async restore(args: RestoreArgs): Promise<string> {
    const session = await restoreSession({
      store: this.store,
      snapshotId: args.snapshotId,
      model: this.resolveModel(args.model),
      mounts: args.mounts,
      network: args.network,
      limits: args.limits,
    });
    return this.store_(session, args.tenant, args.snapshotId);
  }

  /** Look up a session, enforcing tenant ownership. Throws SessionError. */
  get(sessionId: string, tenant: string): Entry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new SessionError(404, "session_not_found", `no such session: ${sessionId}`);
    }
    if (entry.tenant !== tenant) {
      throw new SessionError(403, "forbidden", "session belongs to another tenant");
    }
    entry.lastUsed = nowMs();
    return entry;
  }

  /** Snapshot a session, record and return the new snapshot id. */
  async snapshot(sessionId: string, tenant: string): Promise<string> {
    const entry = this.get(sessionId, tenant);
    const { snapshotId } = await entry.session.snapshot(this.store);
    entry.snapshotId = snapshotId;
    return snapshotId;
  }

  /**
   * Remove a session, taking a best-effort final snapshot first. Returns the
   * final snapshot id when it succeeded.
   */
  async remove(sessionId: string, tenant: string): Promise<{ snapshotId?: string }> {
    const entry = this.get(sessionId, tenant);
    let snapshotId: string | undefined;
    try {
      const res = await entry.session.snapshot(this.store);
      snapshotId = res.snapshotId;
    } catch {
      // Best-effort: a snapshot failure must not block eviction.
    }
    this.sessions.delete(sessionId);
    return { snapshotId };
  }

  private store_(session: Session, tenant: string, snapshotId?: string): string {
    const id = randomUUID();
    this.sessions.set(id, { session, tenant, lastUsed: nowMs(), snapshotId });
    return id;
  }
}

// Date.now() is only banned inside workflow scripts; here it merely stamps
// lastUsed for future eviction. crypto.randomUUID() is used for ids.
function nowMs(): number {
  return Date.now();
}
