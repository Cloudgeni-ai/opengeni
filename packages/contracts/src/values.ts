/**
 * Small runtime helpers shared across packages. Dependency-free and safe in
 * browsers, React Native, workers and servers, so any package can import
 * `@opengeni/contracts/values` without pulling in zod or Node built-ins.
 */

/** A non-null object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An `Error`'s message, or the value converted to a string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lowercase hex SHA-256 of bytes, or of a string's UTF-8 encoding, with Web Crypto. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  // A copy hands Web Crypto a plain ArrayBuffer even for views over shared memory.
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.byteLength);
  if (typeof data !== "string") bytes.set(data);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
