import { createHmac, randomBytes } from "node:crypto";
import { HTTPException } from "hono/http-exception";

export const INSIGHTS_RESPONSE_TTL_MS = 60_000;
const MAX_ENTRIES = 128,
  MAX_BYTES = 8 * 1024 * 1024,
  MAX_ENTRY_BYTES = 1024 * 1024;

/** Ephemeral keyed digest: raw credentials never become retained map keys or logs. */
export function createInsightsCredentialPartition() {
  const secret = randomBytes(32);
  return (authorization: string | undefined, cookie: string | undefined) =>
    createHmac("sha256", secret)
      .update(JSON.stringify([authorization ?? null, cookie ?? null]))
      .digest("hex");
}

export function createInsightsResponseCache(clock: () => number = () => Date.now()) {
  const entries = new Map<
    string,
    { json: string; fence: string; expiresAt: number; bytes: number }
  >();
  let bytes = 0;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry) {
      bytes -= entry.bytes;
      entries.delete(key);
    }
  };
  return {
    get<T>(key: string, fence: string): T | null {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= clock() || entry.fence !== fence) {
        remove(key);
        return null;
      }
      // The TTL is never extended by a hit, and callers receive isolated objects.
      return JSON.parse(entry.json) as T;
    },
    put(key: string, fence: string, value: unknown): void {
      const json = JSON.stringify(value),
        size = Buffer.byteLength(json);
      if (size > MAX_ENTRY_BYTES) return;
      for (const [existingKey, entry] of entries)
        if (entry.expiresAt <= clock()) remove(existingKey);
      remove(key);
      while (entries.size >= MAX_ENTRIES || bytes + size > MAX_BYTES)
        remove(entries.keys().next().value!);
      entries.set(key, { json, fence, expiresAt: clock() + INSIGHTS_RESPONSE_TTL_MS, bytes: size });
      bytes += size;
    },
    get size() {
      return entries.size;
    },
  };
}

/** Match existing bounded cause-chain PostgreSQL timeout handling; never expose SQL. */
export async function insightsWithFriendlyTimeout<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    let current = error;
    for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
      const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
      if (
        candidate.code === "57014" ||
        (typeof candidate.message === "string" &&
          candidate.message.toLowerCase().includes("statement timeout"))
      ) {
        throw new HTTPException(408, { message: "Range too large, try 7 days." });
      }
      current = candidate.cause;
    }
    throw error;
  }
}
