import { expect, test } from "vitest";
import { ProcTable, type ProcIo } from "../src/proc.js";
import { EventBus, type KernelEvent } from "../src/events.js";
import { readText, writeAll } from "../src/streams.js";

function makeTable() {
  const bus = new EventBus();
  const events: KernelEvent[] = [];
  bus.subscribe((ev) => events.push(ev));
  return { table: new ProcTable({ bus, maxProcs: 8 }), events };
}

const echoMain = (text: string) => async (io: ProcIo) => {
  await writeAll(io.stdout, text);
  return 0;
};

test("spawn runs main, stdout readable, exit code via wait", async () => {
  const { table } = makeTable();
  const proc = table.spawn(["echo", "hi"], echoMain("hi\n"));
  expect(proc.pid).toBe(1);
  expect(await readText(proc.stdout)).toBe("hi\n");
  expect(await table.wait(proc.pid)).toBe(0);
});

test("main receives argv and can read stdin", async () => {
  const { table } = makeTable();
  // un `cat` virtuel : copie stdin vers stdout
  const proc = table.spawn(["cat"], async (io) => {
    for await (const chunk of io.stdin) {
      const w = io.stdout.getWriter();
      await w.write(chunk);
      w.releaseLock();
    }
    return 0;
  });
  await writeAll(proc.stdin, "via stdin");
  await proc.stdin.close();
  expect(await readText(proc.stdout)).toBe("via stdin");
  expect(await proc.exit).toBe(0);
});

test("throwing main → exit 1, message on stderr", async () => {
  const { table } = makeTable();
  const proc = table.spawn(["boom"], async () => {
    throw new Error("kaput");
  });
  expect(await proc.exit).toBe(1);
  expect(await readText(proc.stderr)).toContain("kaput");
});

test("spawn/exit events emitted", async () => {
  const { table, events } = makeTable();
  const proc = table.spawn(["echo"], echoMain(""));
  await proc.exit;
  expect(events).toContainEqual({ type: "proc.spawn", pid: proc.pid, ppid: 0, argv: ["echo"] });
  expect(events).toContainEqual({ type: "proc.exit", pid: proc.pid, exitCode: 0 });
});

test("wait on unknown pid → ENOENT (throw synchrone)", () => {
  const { table } = makeTable();
  expect(() => table.wait(999)).toThrowError(/ENOENT/);
});
