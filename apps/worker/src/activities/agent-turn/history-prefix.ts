import { createHash } from "node:crypto";
import { normalizeProtocolJsonValue, sanitizeHistoryItemsForModel } from "@opengeni/runtime";

/** A position is an append cursor only while the items before it stay identical. */
export class HistoryPrefixGuard {
  private persisted: string[] = [];

  seed(items: Array<Record<string, unknown>>, count: number, truncationTokens?: number) {
    const keys = this.keys(items, truncationTokens);
    if (keys.length < count)
      throw new Error("Conversation history seed is shorter than its durable prefix");
    this.persisted = keys.slice(0, count);
  }

  verify(items: Array<Record<string, unknown>>, truncationTokens?: number): string[] {
    const keys = this.keys(items, truncationTokens);
    for (let i = 0; i < this.persisted.length; i++) {
      if (keys[i] !== this.persisted[i]) {
        // No content in diagnostics: this may include private user/tool data.
        throw new Error(
          `Conversation history durable prefix changed at item ${i}; refusing to skip unsaved work`,
        );
      }
    }
    return keys;
  }

  acknowledge(keys: string[], count: number) {
    this.persisted = keys.slice(0, count);
  }

  private keys(items: Array<Record<string, unknown>>, truncationTokens?: number): string[] {
    return sanitizeHistoryItemsForModel(items, truncationTokens).map((item) =>
      createHash("sha256")
        .update(
          JSON.stringify(sorted(normalizeProtocolJsonValue(item, "$", REQUEST_MARKS_OMITTED))),
        )
        .digest("hex"),
    );
  }
}

/**
 * An item's identity is its stored JSON form. Provider projection marks some
 * turn-input items with request-local symbol keys (for example how a Claude
 * web search is projected for another transport); they are never stored or
 * sent, so they are not part of the item's durable identity. Any other value
 * JSON cannot carry is converted exactly as history persistence converts and
 * logs it, so the identity matches the stored row without a second log line.
 */
const REQUEST_MARKS_OMITTED = { onAdjustment: () => undefined } as const;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sorted(entry)]),
    );
  }
  return value;
}
