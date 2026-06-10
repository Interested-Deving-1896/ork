import { KernelError } from "./errors.js";
import type { EventBus } from "./events.js";

export interface ProcIo {
  argv: string[];
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
}

export type ProcMain = (io: ProcIo) => Promise<number | void>;
export type ProcStatus = "running" | "exited";

export interface ProcHandle {
  pid: number;
  ppid: number;
  argv: string[];
  /** Côté écriture : le parent alimente le stdin du proc. */
  stdin: WritableStream<Uint8Array>;
  /** Côtés lecture : le parent consomme stdout/stderr. */
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exit: Promise<number>;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  argv: string[];
  status: ProcStatus;
  exitCode: number | null;
}

interface ProcRecord {
  handle: ProcHandle;
  status: ProcStatus;
  exitCode: number | null;
}

export class ProcTable {
  #nextPid = 1;
  #procs = new Map<number, ProcRecord>();
  #bus: EventBus;
  #maxProcs: number;

  constructor(opts: { bus: EventBus; maxProcs?: number }) {
    this.#bus = opts.bus;
    this.#maxProcs = opts.maxProcs ?? Infinity;
  }

  spawn(argv: string[], main: ProcMain, opts: { ppid?: number } = {}): ProcHandle {
    let running = 0;
    for (const p of this.#procs.values()) if (p.status === "running") running++;
    if (running >= this.#maxProcs) throw new KernelError("EQUOTA", `maxProcs (${this.#maxProcs}) exceeded`);

    const pid = this.#nextPid++;
    const ppid = opts.ppid ?? 0;
    // Le buffer de lecture (readable) reçoit un HWM élevé : un proc peut écrire
    // sur stdout/stderr puis se terminer même si le parent ne consomme pas encore
    // la sortie (sémantique d'un buffer de pipe). Sans ça, write()/close() sur le
    // côté writable d'un TransformStream non drainé ne se résolvent jamais.
    const pipeBuffer = new CountQueuingStrategy({ highWaterMark: 1024 });
    const stdin = new TransformStream<Uint8Array, Uint8Array>(undefined, undefined, pipeBuffer);
    const stdout = new TransformStream<Uint8Array, Uint8Array>(undefined, undefined, pipeBuffer);
    const stderr = new TransformStream<Uint8Array, Uint8Array>(undefined, undefined, pipeBuffer);

    const record: ProcRecord = { handle: null as unknown as ProcHandle, status: "running", exitCode: null };

    const exit = (async () => {
      let code: number;
      try {
        code = (await main({ argv, stdin: stdin.readable, stdout: stdout.writable, stderr: stderr.writable })) ?? 0;
      } catch (err) {
        code = 1;
        try {
          const writer = stderr.writable.getWriter();
          const msg = err instanceof Error ? err.message : String(err);
          await writer.write(new TextEncoder().encode(msg + "\n"));
          writer.releaseLock();
        } catch {
          // stderr déjà verrouillé ou fermé par main — tant pis pour le message
        }
      }
      for (const side of [stdout.writable, stderr.writable]) {
        try {
          await side.close();
        } catch {
          // déjà fermé par main
        }
      }
      record.status = "exited";
      record.exitCode = code;
      this.#bus.emit({ type: "proc.exit", pid, exitCode: code });
      return code;
    })();

    const handle: ProcHandle = {
      pid,
      ppid,
      argv,
      stdin: stdin.writable,
      stdout: stdout.readable,
      stderr: stderr.readable,
      exit,
    };
    record.handle = handle;
    this.#procs.set(pid, record);
    this.#bus.emit({ type: "proc.spawn", pid, ppid, argv });
    return handle;
  }

  wait(pid: number): Promise<number> {
    const record = this.#procs.get(pid);
    if (!record) throw new KernelError("ENOENT", `pid ${pid}`);
    return record.handle.exit;
  }

  list(): ProcInfo[] {
    return [...this.#procs.values()].map((r) => ({
      pid: r.handle.pid,
      ppid: r.handle.ppid,
      argv: r.handle.argv,
      status: r.status,
      exitCode: r.exitCode,
    }));
  }
}
