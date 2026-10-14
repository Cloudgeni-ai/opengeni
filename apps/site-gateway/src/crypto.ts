/** WebCrypto helpers shared by signing and cookies. Work in workerd and Bun alike. */

const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value) as Uint8Array<ArrayBuffer>;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function base64urlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  try {
    const padded = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** `bytes` of CSPRNG output, base64url-encoded. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(data: Uint8Array<ArrayBuffer> | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
  return [...(await sha256(data))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    // Bounded: an isolate sees the current and at most a rotated secret.
    if (keys.size > 8) keys.clear();
    keys.set(secret, key);
  }
  return key;
}

export async function hmacBase64url(secret: string, message: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(message));
  return base64url(new Uint8Array(signature));
}

/** Constant-time comparison for equal-length ASCII tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
