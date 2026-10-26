/**
 * Capture of secret-shaped values found in tool output into the run's task
 * vault (docs/secrets.md, Masking). The agent then sees, and can use, a
 * reference instead of the value.
 *
 * Each value becomes one hosted, encrypted item named after its kind plus a
 * short keyed HMAC of the value (keyed with the deployment's encryption key),
 * so the same value found again reuses the same item and the name reveals
 * nothing. Item writes are audited like any other secret write (metadata
 * only). Any failure leaves that value to its `[masked <kind>]` marker.
 */
import { createHmac } from "node:crypto";
import {
  SECRET_SHAPE_KINDS,
  type SecretPrincipal,
  type SecretShapeCapturer,
  type SecretShapeKind,
} from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { createVaultService, type VaultService } from "./vault-service";

/** Hex characters of the keyed HMAC in a captured item's name (64 bits). */
const ITEM_NAME_DIGEST_CHARS = 16;

/** Captured items one root session's task vault holds at most; later values get markers. */
export const SECRET_SHAPE_CAPTURED_ITEMS_MAX = 200;
/** Captures running at once for one tool result. */
const CAPTURE_CONCURRENCY = 4;
/** After this many failures in a row an attempt stops trying (markers only). */
const CAPTURE_FAILURES_BEFORE_STOP = 3;

const CAPTURED_ITEM_NAME = new RegExp(
  `^(?:${Object.keys(SECRET_SHAPE_KINDS)
    .map((kind) => kind.replace(/[^a-z0-9-]/g, ""))
    .join("|")})-[0-9a-f]{${ITEM_NAME_DIGEST_CHARS}}$`,
);

/** Whether an item name is one capture gives (`<kind>-<16 hex>`). */
export function isSecretShapeItemName(name: string): boolean {
  return CAPTURED_ITEM_NAME.test(name);
}

/** `<kind>-<keyed HMAC prefix>`: stable per value, safe to show. */
export function secretShapeItemName(
  kind: SecretShapeKind,
  value: string,
  encryptionKey: Uint8Array,
): string {
  const digest = createHmac("sha256", encryptionKey)
    .update("opengeni.secret-shape.v1\u0000")
    .update(kind)
    .update("\u0000")
    .update(value)
    .digest("hex");
  return `${kind}-${digest.slice(0, ITEM_NAME_DIGEST_CHARS)}`;
}

export type SecretCaptureFailure = {
  kind: SecretShapeKind;
  /** An error code or class name; never the value. */
  error: string;
};

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : typeof error;
}

/**
 * A capturer that saves each detected value into the task vault of
 * `principal`'s run and returns the reference of its secret field.
 */
export function createTaskVaultSecretCapturer(input: {
  db: Database;
  encryptionKey: Uint8Array;
  principal: Extract<SecretPrincipal, { kind: "attempt" }>;
  onFailure?: (failure: SecretCaptureFailure) => void;
  /** For tests. */
  service?: VaultService;
}): SecretShapeCapturer {
  const service =
    input.service ?? createVaultService({ db: input.db, encryptionKey: input.encryptionKey });
  // One capture per value per attempt, even when it is found again.
  const done = new Map<string, Promise<string | null>>();
  // Captured items already in the task vault, counted once per attempt.
  let captured: Promise<number> | null = null;
  let failuresInARow = 0;
  const report = (kind: SecretShapeKind, error: string) => {
    try {
      input.onFailure?.({ kind, error });
    } catch {
      // Diagnostics never affect capture.
    }
  };
  const captureOne = async (
    kind: SecretShapeKind,
    value: string,
    username: string | undefined,
  ): Promise<string | null> => {
    const info = SECRET_SHAPE_KINDS[kind];
    try {
      captured ??= service.countTaskVaultItemsForAgent(
        input.principal,
        isSecretShapeItemName,
        SECRET_SHAPE_CAPTURED_ITEMS_MAX,
      );
      const count = await captured;
      const references = await service.captureForAgent(input.principal, {
        item: secretShapeItemName(kind, value, input.encryptionKey),
        type: info.itemType,
        field: info.field,
        value,
        ...(username ? { username } : {}),
        createAllowed: count < SECRET_SHAPE_CAPTURED_ITEMS_MAX,
      });
      if (references.created) captured = Promise.resolve(count + 1);
      failuresInARow = 0;
      return references.byField[info.field] ?? null;
    } catch (error) {
      failuresInARow += 1;
      // Counted again with the next capture.
      captured = null;
      report(kind, errorCode(error));
      return null;
    }
  };
  return async (matches) => {
    const references = new Map<string, string>();
    if (failuresInARow >= CAPTURE_FAILURES_BEFORE_STOP) return references;
    const queue = [...matches];
    const worker = async () => {
      for (let match = queue.shift(); match; match = queue.shift()) {
        if (failuresInARow >= CAPTURE_FAILURES_BEFORE_STOP) return;
        let pending = done.get(match.value);
        if (!pending) {
          pending = captureOne(match.kind, match.value, match.username);
          done.set(match.value, pending);
        }
        const reference = await pending;
        if (reference) references.set(match.value, reference);
        else done.delete(match.value);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CAPTURE_CONCURRENCY, queue.length) }, () => worker()),
    );
    return references;
  };
}
