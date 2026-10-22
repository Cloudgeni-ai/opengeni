import type { SessionEvent } from "@opengeni/contracts";

export type ParsedSseEvent = {
  id?: string;
  event?: string;
  data: string;
};

export async function collectSse(
  url: string,
  options: {
    count: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<SessionEvent[]> {
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  const timeout = setTimeout(() => abort.abort(), options.timeoutMs ?? 20_000);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    const { SessionEvent: SessionEventSchema } = await import("@opengeni/contracts");
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok || !response.body) {
      throw new Error(`SSE request failed: ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const out: SessionEvent[] = [];
    while (out.length < options.count) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const parsed = parseSseBlock(part);
        if (!parsed?.data || parsed.data.startsWith(":")) {
          continue;
        }
        out.push(SessionEventSchema.parse(JSON.parse(parsed.data)));
        if (out.length >= options.count) {
          abort.abort();
          break;
        }
      }
    }
    return out;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function parseSseBlock(block: string): ParsedSseEvent | null {
  const event: ParsedSseEvent = { data: "" };
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const index = line.indexOf(":");
    const field = index >= 0 ? line.slice(0, index) : line;
    const value = index >= 0 ? line.slice(index + 1).replace(/^ /, "") : "";
    if (field === "id") {
      event.id = value;
    } else if (field === "event") {
      event.event = value;
    } else if (field === "data") {
      event.data = event.data ? `${event.data}\n${value}` : value;
    }
  }
  return event.data || event.event || event.id ? event : null;
}
