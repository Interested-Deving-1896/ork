export async function sha256Hex(data: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
