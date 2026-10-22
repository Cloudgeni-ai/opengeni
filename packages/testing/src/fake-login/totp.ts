import { createHmac, randomBytes } from "node:crypto";

/**
 * RFC 4226 / RFC 6238 one-time passwords for the fake-login suite. Independent
 * of the product implementation on purpose: the suite is the oracle the product
 * TOTP code is tested against, so it must not share code with it.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/[\s=-]/gu, "").toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`invalid base32 character ${JSON.stringify(char)}`);
    buffer = ((buffer << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export type TotpOptions = {
  digits?: number;
  period?: number;
  algorithm?: TotpAlgorithm;
};

export function hotp(secret: Uint8Array, counter: number, options: TotpOptions = {}): string {
  const digits = options.digits ?? 6;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac((options.algorithm ?? "SHA1").toLowerCase(), secret)
    .update(message)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totp(secretBase32: string, nowMs: number, options: TotpOptions = {}): string {
  const period = options.period ?? 30;
  return hotp(base32Decode(secretBase32), Math.floor(nowMs / 1000 / period), options);
}

/** Accepts the current window and `drift` windows either side (default 1). */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  options: TotpOptions & { drift?: number } = {},
): boolean {
  const period = options.period ?? 30;
  const drift = options.drift ?? 1;
  const counter = Math.floor(nowMs / 1000 / period);
  const secret = base32Decode(secretBase32);
  for (let delta = -drift; delta <= drift; delta += 1) {
    if (hotp(secret, counter + delta, options) === code.trim()) return true;
  }
  return false;
}

export function randomTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function otpauthUri(input: {
  issuer: string;
  account: string;
  secret: string;
  options?: TotpOptions;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: input.options?.algorithm ?? "SHA1",
    digits: String(input.options?.digits ?? 6),
    period: String(input.options?.period ?? 30),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
