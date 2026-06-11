import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION_PREFIX = "v1";
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Encrypts one workspace environment variable value with AES-256-GCM under an
 * operator key held outside Postgres. Output format: `v1:<b64 iv>:<b64 ciphertext||tag>`.
 */
export function encryptEnvironmentValue(key: Uint8Array, plaintext: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION_PREFIX}:${iv.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * Decrypts a stored `v1:` value. Error messages never echo plaintext or
 * ciphertext: unknown versions throw "unsupported environment value format",
 * auth-tag mismatches throw "environment value decryption failed".
 */
export function decryptEnvironmentValue(key: Uint8Array, stored: string): string {
  assertKey(key);
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== VERSION_PREFIX) {
    throw new Error("unsupported environment value format");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const payload = Buffer.from(parts[2]!, "base64");
  if (iv.length !== IV_BYTES || payload.length <= GCM_TAG_BYTES) {
    throw new Error("unsupported environment value format");
  }
  const tag = payload.subarray(payload.length - GCM_TAG_BYTES);
  const ciphertext = payload.subarray(0, payload.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("environment value decryption failed");
  }
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new Error("environment encryption key must be exactly 32 bytes");
  }
}
