/**
 * Deterministic chat identities. A conversation id maps to exactly one
 * session id per workspace, so any process can address the same session
 * without storing a mapping, and a double-submitted create collapses through
 * the idempotency key.
 */

/** Fixed RFC 4122 namespace for chat session ids. Never change it. */
export const CHAT_SESSION_NAMESPACE = "7c1e6d3a-5b2f-4e8a-9d4c-0f3b6a8e2c17";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 4122 version 5 (SHA-1) UUID of `name` inside `namespace`. */
export async function uuidV5(name: string, namespace: string): Promise<string> {
  const namespaceBytes = parseUuid(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(digest);
}

export async function chatSessionId(workspaceId: string, conversation: string): Promise<string> {
  return await uuidV5(`${workspaceId}:${conversation}`, CHAT_SESSION_NAMESPACE);
}

export function chatIdempotencyKey(conversation: string): string {
  return `chat:${conversation}`;
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function parseUuid(value: string): Uint8Array {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`Invalid UUID namespace: ${value}`);
  }
  const hex = value.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
