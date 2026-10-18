export async function boundedJsonReceipt(response: Response, maxBytes = 65_536): Promise<unknown> {
  if (!response.body) throw new Error("DELIVERY_RECEIPT_MISSING");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("DELIVERY_RECEIPT_TOO_LARGE");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
