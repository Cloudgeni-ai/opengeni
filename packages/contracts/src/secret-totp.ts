/**
 * The one TOTP implementation (RFC 6238 over RFC 4226 HOTP). Codes are
 * computed at dispatch from a stored seed and never stored (invariant I4).
 *
 * HMAC uses `@noble/hashes`, which is synchronous and works in Bun, Node,
 * browsers and React Native (no WebCrypto requirement).
 */
import { hmac } from "@noble/hashes/hmac";
import { sha1 } from "@noble/hashes/sha1";
import { sha256, sha512 } from "@noble/hashes/sha2";

export interface TotpParams {
  secretBase32: string;
  algorithm: "SHA1" | "SHA256" | "SHA512";
  digits: 6 | 7 | 8;
  periodSeconds: number;
}

export type SecretClock = { now(): number; sleep(ms: number): Promise<void> };

export const systemSecretClock: SecretClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Wait for the next window when fewer than this many ms remain (Q-33). */
export const TOTP_MIN_REMAINING_MS = 3_000;

export class TotpInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TotpInputError";
  }
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Uppercase, strip spaces, dashes and padding. */
export function normalizeBase32Secret(input: string): string {
  return input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
}

export function decodeBase32(input: string): Uint8Array {
  const normalized = normalizeBase32Secret(input);
  if (normalized.length === 0) throw new TotpInputError("TOTP secret is empty");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new TotpInputError("TOTP secret is not valid Base32");
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length === 0) throw new TotpInputError("TOTP secret is empty");
  return Uint8Array.from(out);
}

function parseAlgorithm(value: string | null): TotpParams["algorithm"] {
  if (value === null) return "SHA1";
  const normalized = value.toUpperCase().replace("-", "");
  if (normalized === "SHA1" || normalized === "SHA256" || normalized === "SHA512") {
    return normalized;
  }
  throw new TotpInputError("TOTP algorithm must be SHA1, SHA256 or SHA512");
}

function parseDigits(value: string | null): TotpParams["digits"] {
  if (value === null) return 6;
  if (value === "6" || value === "7" || value === "8") return Number(value) as 6 | 7 | 8;
  throw new TotpInputError("TOTP digits must be 6, 7 or 8");
}

function parsePeriod(value: string | null): number {
  if (value === null) return 30;
  if (!/^\d+$/.test(value)) throw new TotpInputError("TOTP period is invalid");
  const period = Number(value);
  if (period < 1 || period > 300) throw new TotpInputError("TOTP period must be 1 to 300 seconds");
  return period;
}

/**
 * Accepts an `otpauth://totp/...` URI or a bare Base32 seed (spaces, dashes,
 * padding and lowercase tolerated). Throws `TotpInputError`.
 */
export function parseTotpInput(input: string): TotpParams {
  const trimmed = input.trim();
  if (/^otpauth:/i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new TotpInputError("TOTP otpauth URI is invalid");
    }
    // Engines differ on whether the type lands in host or pathname for
    // non-special schemes; accept both.
    const kind = (
      url.hostname ||
      url.pathname.replace(/^\/+/, "").split("/")[0] ||
      ""
    ).toLowerCase();
    if (kind !== "totp") throw new TotpInputError("only otpauth://totp URIs are supported");
    const secret = url.searchParams.get("secret");
    if (!secret) throw new TotpInputError("TOTP otpauth URI has no secret");
    const secretBase32 = normalizeBase32Secret(secret);
    decodeBase32(secretBase32);
    return {
      secretBase32,
      algorithm: parseAlgorithm(url.searchParams.get("algorithm")),
      digits: parseDigits(url.searchParams.get("digits")),
      periodSeconds: parsePeriod(url.searchParams.get("period")),
    };
  }
  const secretBase32 = normalizeBase32Secret(trimmed);
  decodeBase32(secretBase32);
  return { secretBase32, algorithm: "SHA1", digits: 6, periodSeconds: 30 };
}

/** True when `input` parses as a TOTP seed or otpauth URI. */
export function isValidTotpInput(input: string): boolean {
  try {
    parseTotpInput(input);
    return true;
  } catch {
    return false;
  }
}

function hotp(key: Uint8Array, counter: number, params: TotpParams): string {
  const message = new Uint8Array(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  const hash = params.algorithm === "SHA1" ? sha1 : params.algorithm === "SHA256" ? sha256 : sha512;
  const digest = hmac(hash, key, message);
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** params.digits).padStart(params.digits, "0");
}

/** Synchronous form of `totpCode` for UI rendering loops. */
export function totpCodeSync(params: TotpParams, atMs: number): string {
  if (!Number.isFinite(atMs) || atMs < 0) throw new TotpInputError("TOTP time is invalid");
  if (!Number.isInteger(params.periodSeconds) || params.periodSeconds < 1) {
    throw new TotpInputError("TOTP period is invalid");
  }
  const counter = Math.floor(atMs / 1000 / params.periodSeconds);
  return hotp(decodeBase32(params.secretBase32), counter, params);
}

/** The code valid at `atMs` (Unix milliseconds). */
export async function totpCode(params: TotpParams, atMs: number): Promise<string> {
  return totpCodeSync(params, atMs);
}

/** Milliseconds left in the window containing `atMs`. */
export function totpRemainingMs(params: TotpParams, atMs: number): number {
  const periodMs = params.periodSeconds * 1000;
  return periodMs - (atMs % periodMs);
}

/**
 * The code to type or send right now. When fewer than 3 s remain in the
 * current window, waits for the next window so the code is not stale on
 * arrival (Q-33).
 */
export async function totpCodeAtDispatch(
  params: TotpParams,
  clock: SecretClock = systemSecretClock,
): Promise<{ code: string; expiresAtMs: number }> {
  let now = clock.now();
  const remaining = totpRemainingMs(params, now);
  if (remaining < TOTP_MIN_REMAINING_MS) {
    await clock.sleep(remaining);
    now = clock.now();
  }
  return { code: totpCodeSync(params, now), expiresAtMs: now + totpRemainingMs(params, now) };
}
