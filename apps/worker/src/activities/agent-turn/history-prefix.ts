import { normalizeProtocolJsonValue, sanitizeHistoryItemsForModel } from "@opengeni/runtime";

/**
 * An item's durable identity: its canonical JSON tree (protocol-normalized,
 * keys sorted). The tree is built afresh for every item and shares only
 * immutable primitives with the input, so a retained identity cannot change
 * when the SDK later mutates or replaces the item it was taken from. Two
 * identities are equal exactly when their `JSON.stringify` forms are equal,
 * which compares by structure without serializing or hashing the whole history
 * on every model call.
 *
 * Retained trees hold new object and array shells but reuse the item's own
 * strings, so they cost roughly the history's structure, not its text (about
 * 24 KB for a 466 KB history, against 14 KB for per-item SHA-256 digests).
 * Strings the identity rewrites (a truncated tool output, a converted value)
 * are its own copies. Hashing instead would cost several times more CPU on
 * every call, because every item must still be keyed on every call.
 */
export type HistoryPrefixKey = unknown;

/**
 * A position is an append cursor only while the items before it stay identical.
 *
 * Each `verify` sanitizes and canonicalizes the whole current history (as the
 * stored rows would be written) and compares every item of the durable prefix
 * structurally with the identity retained at the last `seed`/`acknowledge`.
 * The identities it returns become the retained ones on `acknowledge`, so they
 * keep referencing the live history's strings.
 */
export class HistoryPrefixGuard {
  private persisted: HistoryPrefixKey[] = [];

  seed(items: Array<Record<string, unknown>>, count: number, truncationTokens?: number) {
    const keys = this.keys(items, truncationTokens);
    if (keys.length < count)
      throw new Error("Conversation history seed is shorter than its durable prefix");
    this.persisted = keys.slice(0, count);
  }

  verify(items: Array<Record<string, unknown>>, truncationTokens?: number): HistoryPrefixKey[] {
    const keys = this.keys(items, truncationTokens);
    for (let i = 0; i < this.persisted.length; i++) {
      if (i >= keys.length || !sameCanonicalJson(keys[i], this.persisted[i])) {
        // No content in diagnostics: this may include private user/tool data.
        throw new Error(
          `Conversation history durable prefix changed at item ${i}; refusing to skip unsaved work`,
        );
      }
    }
    return keys;
  }

  acknowledge(keys: HistoryPrefixKey[], count: number) {
    this.persisted = keys.slice(0, count);
  }

  private keys(
    items: Array<Record<string, unknown>>,
    truncationTokens?: number,
  ): HistoryPrefixKey[] {
    return sanitizeHistoryItemsForModel(items, truncationTokens).map((item) =>
      sorted(normalizeProtocolJsonValue(item, "$", REQUEST_MARKS_OMITTED)),
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

/**
 * `JSON.stringify(left) === JSON.stringify(right)` for canonical trees, without
 * serializing. Canonical trees are protocol-normalized JSON (plain objects and
 * arrays, strings, booleans, null, finite numbers), where serialization is
 * injective: equal output means the same key sequence at every object and the
 * same value at every position. `0 === -0` matches their shared "0" form.
 */
export function sameCanonicalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  const leftObject = typeof left === "object" && left !== null;
  const rightObject = typeof right === "object" && right !== null;
  // Normalized trees hold only finite numbers, so distinct primitives always
  // differ; printing them keeps the rule exact for any primitive JSON would
  // print alike (a non-finite number and null).
  if (!leftObject || !rightObject)
    return !leftObject && !rightObject && JSON.stringify(left) === JSON.stringify(right);
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (!sameCanonicalJson(left[i], right[i])) return false;
    return true;
  }
  if (Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i++) {
    const key = leftKeys[i]!;
    if (key !== rightKeys[i]) return false;
    if (
      !sameCanonicalJson(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      )
    )
      return false;
  }
  return true;
}
