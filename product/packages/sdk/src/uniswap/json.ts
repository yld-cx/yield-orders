import { SwapError } from "./types.ts";

export async function boundedJson(
  response: Response,
  maximum = 262144,
): Promise<unknown> {
  if (!response.body) throw new SwapError("Empty response", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new SwapError("Request or response too large", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new SwapError("Invalid JSON", 400);
  }
}
