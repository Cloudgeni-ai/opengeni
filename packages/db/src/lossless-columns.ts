import { customType, integer } from "drizzle-orm/pg-core";
import { toPostgresLosslessJson, toPostgresLosslessText } from "./lossless-json";
import { maskSecretValuesForStorage } from "./secret-value-masking";

/**
 * Codec truth is explicit and out-of-band. This column intentionally has no
 * database or application default: a caller may set version 1 only in the same
 * statement that writes the corresponding value through the lossless codec.
 */
export function losslessCodecVersion<TName extends string>(name: TName) {
  return integer(name);
}

export const losslessJsonb = customType<{ data: unknown; driverData: string }>({
  dataType() {
    return "jsonb";
  },
  toDriver(value) {
    return JSON.stringify(toPostgresLosslessJson(value));
  },
  fromDriver(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
  },
});

export const losslessText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text";
  },
  toDriver(value) {
    return toPostgresLosslessText(value);
  },
  fromDriver(value) {
    return value;
  },
});

/** Ordered model history: JSON decoding preserves insertion order without repair. */
export const losslessOrderedJson = customType<{ data: unknown; driverData: string }>({
  dataType() {
    return "json";
  },
  toDriver(value) {
    return JSON.stringify(toPostgresLosslessJson(value));
  },
  fromDriver(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
  },
});

/*
 * Conversation columns (session events, history, turn prompts, messages,
 * realtime entries, system updates, run state) mask known secret values at
 * the codec, so every writer inside an attempt or a first-party call that
 * received resolved values stores references instead (docs/secrets.md,
 * Masking). Outside such a context they are exactly the lossless codecs.
 * Other columns (variables, settings, vault metadata) keep values exact.
 */
export const conversationLosslessJsonb = customType<{ data: unknown; driverData: string }>({
  dataType() {
    return "jsonb";
  },
  toDriver(value) {
    return JSON.stringify(toPostgresLosslessJson(maskSecretValuesForStorage(value, "column")));
  },
  fromDriver(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
  },
});

export const conversationLosslessText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text";
  },
  toDriver(value) {
    return toPostgresLosslessText(maskSecretValuesForStorage(value, "column"));
  },
  fromDriver(value) {
    return value;
  },
});

/**
 * A serialized RunState (JSON text) is masked as the object it encodes, so
 * file and image payloads inside it (data URLs, `data` beside a MIME type)
 * are skipped exactly as in history. Unchanged text is stored as written.
 */
export function maskSerializedRunStateForStorage(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return maskSecretValuesForStorage(value, "run_state");
  }
  const masked = maskSecretValuesForStorage(parsed, "run_state");
  return masked === parsed ? value : JSON.stringify(masked);
}

export const conversationRunStateText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text";
  },
  toDriver(value) {
    return toPostgresLosslessText(maskSerializedRunStateForStorage(value));
  },
  fromDriver(value) {
    return value;
  },
});

export const conversationLosslessOrderedJson = customType<{ data: unknown; driverData: string }>({
  dataType() {
    return "json";
  },
  toDriver(value) {
    return JSON.stringify(toPostgresLosslessJson(maskSecretValuesForStorage(value, "column")));
  },
  fromDriver(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
  },
});
