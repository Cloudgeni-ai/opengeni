/**
 * The storage backstop for known secret values (docs/secrets.md, Masking).
 *
 * An agent attempt (and a first-party tool call that received resolved
 * values) runs inside `withSecretValueMasking`. Durable writers of
 * conversation text call `maskSecretValuesForStorage` on what they are about
 * to store: session event payloads, history items, command output, messages
 * to other sessions, goals and notes. Outside such a context it is a no-op.
 *
 * Writers mask their input before any idempotency comparison, so a retry of
 * the same write compares masked text with masked text. Masking never throws:
 * a failure stores the input unchanged and reports a metadata-only diagnostic
 * through the masker.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** What the backstop needs from a memory (`SecretValueMemory` satisfies it). */
export type SecretValueStorageMasker = {
  readonly size: number;
  mask<T>(value: T, stage?: string): T;
};

const maskers = new AsyncLocalStorage<SecretValueStorageMasker>();

function composed(
  outer: SecretValueStorageMasker,
  inner: SecretValueStorageMasker,
): SecretValueStorageMasker {
  return {
    get size() {
      return outer.size + inner.size;
    },
    mask<T>(value: T, stage?: string): T {
      return outer.mask(inner.mask(value, stage), stage);
    },
  };
}

/**
 * Run `run` with `masker` active for every durable write it makes. A nested
 * context masks with both the outer and the inner values.
 */
export function withSecretValueMasking<T>(
  masker: SecretValueStorageMasker | null | undefined,
  run: () => T,
): T {
  if (!masker) return run();
  const outer = maskers.getStore();
  return maskers.run(outer ? composed(outer, masker) : masker, run);
}

/** The masker of the current attempt or tool call, if any. */
export function activeSecretValueMasker(): SecretValueStorageMasker | undefined {
  return maskers.getStore();
}

/** `value` with every known secret value replaced, or `value` itself when none applies. */
export function maskSecretValuesForStorage<T>(value: T, stage = "storage"): T {
  const masker = maskers.getStore();
  if (!masker || masker.size === 0) return value;
  try {
    return masker.mask(value, stage);
  } catch {
    // SecretValueMemory never throws; a foreign masker must not fail a write.
    return value;
  }
}
