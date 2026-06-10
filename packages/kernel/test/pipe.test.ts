import { expect, test } from "vitest";
import { ProcTable, type ProcIo } from "../src/proc.js";
import { EventBus } from "../src/events.js";
import { readText, writeAll } from "../src/streams.js";

function makeTable(maxProcs = 8) {
  return new ProcTable({ bus: new EventBus(), maxProcs });
}

const upperMain = async (io: ProcIo) => {
  for await (const chunk of io.stdin) {
    const text = new TextDecoder().decode(chunk).toUpperCase();
    const w = io.stdout.getWriter();
    await w.write(new TextEncoder().encode(text));
    w.releaseLock();
  }
  return 0;
};

test("pipe connects producer stdout to consumer stdin", async () => {
  const table = makeTable();
  const producer = table.spawn(["echo"], async (io) => {
    await writeAll(io.stdout, "hello pipe");
    return 0;
  });
  const consumer = table.spawn(["upper"], upperMain);
  table.pipe(producer, consumer);
  expect(await readText(consumer.stdout)).toBe("HELLO PIPE");
  expect(await consumer.exit).toBe(0);
});

test("maxProcs exceeded → EQUOTA", async () => {
  const table = makeTable(1);
  const blocker = table.spawn(["sleep"], async (io) => {
    await readText(io.stdin); // bloque jusqu'à fermeture du stdin
    return 0;
  });
  expect(() => table.spawn(["echo"], upperMain)).toThrowError(/EQUOTA/);
  await blocker.stdin.close();
  await blocker.exit;
  // un slot s'est libéré
  const next = table.spawn(["echo"], async () => 0);
  expect(await next.exit).toBe(0);
});
