const enc = new TextEncoder();
const dec = new TextDecoder();

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return dec.decode(await readAll(stream));
}

export async function writeAll(stream: WritableStream<Uint8Array>, data: Uint8Array | string): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(typeof data === "string" ? enc.encode(data) : data);
  } finally {
    writer.releaseLock();
  }
}
