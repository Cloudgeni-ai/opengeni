import { createHmac } from "node:crypto";
import type {
  BrowserProtectedAuthFieldValue,
  ProtectedAuthField,
  SiteAuthAuthority,
} from "@opengeni/contracts";

type ConnectionFieldsAuthority = Extract<SiteAuthAuthority, { kind: "connection_fields" }>;

export class BrowserAuthCredentialError extends Error {
  readonly name = "BrowserAuthCredentialError";
}

export function resolveProtectedAuthFieldValues(input: {
  authority: ConnectionFieldsAuthority;
  requestedFields: readonly ProtectedAuthField[];
  credential: Readonly<Record<string, unknown>>;
  nowMs?: number;
}): BrowserProtectedAuthFieldValue[] {
  const configured = new Map(input.authority.fields.map((field) => [field.id, field]));
  return input.requestedFields.map((requested) => {
    const field = configured.get(requested.fieldId);
    if (!field) {
      throw new BrowserAuthCredentialError(
        `Protected auth field ${requested.fieldId} is not configured`,
      );
    }
    const stored = Object.prototype.hasOwnProperty.call(input.credential, field.credentialKey)
      ? input.credential[field.credentialKey]
      : undefined;
    if (typeof stored !== "string" || stored.length === 0) {
      throw new BrowserAuthCredentialError(
        `Credential field ${field.credentialKey} is unavailable`,
      );
    }
    const value =
      field.purpose === "totp"
        ? totpCode(stored, {
            ...(field.digits === undefined ? {} : { digits: field.digits }),
            ...(field.periodSeconds === undefined ? {} : { periodSeconds: field.periodSeconds }),
            ...(field.algorithm === undefined ? {} : { algorithm: field.algorithm }),
            ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
          })
        : stored;
    return {
      fieldId: requested.fieldId,
      locator: requested.locator,
      purpose: field.purpose,
      value,
    };
  });
}

export function totpCode(
  secretValue: string,
  options: {
    digits?: number;
    periodSeconds?: number;
    algorithm?: "sha1" | "sha256" | "sha512";
    nowMs?: number;
  } = {},
): string {
  const uri = secretValue.startsWith("otpauth://") ? parseOtpAuthUri(secretValue) : null;
  const digits = options.digits ?? uri?.digits ?? 6;
  const periodSeconds = options.periodSeconds ?? uri?.periodSeconds ?? 30;
  const algorithm = options.algorithm ?? uri?.algorithm ?? "sha1";
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) {
    throw new BrowserAuthCredentialError("TOTP digits must be between 6 and 10");
  }
  if (!Number.isInteger(periodSeconds) || periodSeconds < 15 || periodSeconds > 300) {
    throw new BrowserAuthCredentialError("TOTP period is outside the supported range");
  }
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new BrowserAuthCredentialError("TOTP time is invalid");
  }
  const secret = decodeBase32(uri?.secret ?? secretValue);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / (periodSeconds * 1_000))));
  const digest = createHmac(algorithm, secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  const code = String(binary % 10 ** digits).padStart(digits, "0");
  secret.fill(0);
  counter.fill(0);
  digest.fill(0);
  return code;
}

function parseOtpAuthUri(value: string): {
  secret: string;
  digits?: number;
  periodSeconds?: number;
  algorithm?: "sha1" | "sha256" | "sha512";
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserAuthCredentialError("TOTP credential contains an invalid otpauth URI");
  }
  if (url.protocol !== "otpauth:" || url.hostname !== "totp") {
    throw new BrowserAuthCredentialError("Only otpauth TOTP credentials are supported");
  }
  const secret = url.searchParams.get("secret")?.trim();
  if (!secret) throw new BrowserAuthCredentialError("TOTP credential has no secret");
  const digits = optionalIntegerParameter(url, "digits");
  const periodSeconds = optionalIntegerParameter(url, "period");
  const rawAlgorithm = url.searchParams.get("algorithm")?.toLowerCase();
  if (rawAlgorithm && !["sha1", "sha256", "sha512"].includes(rawAlgorithm)) {
    throw new BrowserAuthCredentialError("TOTP credential uses an unsupported algorithm");
  }
  return {
    secret,
    ...(digits === undefined ? {} : { digits }),
    ...(periodSeconds === undefined ? {} : { periodSeconds }),
    ...(rawAlgorithm ? { algorithm: rawAlgorithm as "sha1" | "sha256" | "sha512" } : {}),
  };
}

function optionalIntegerParameter(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new BrowserAuthCredentialError(`TOTP ${name} is invalid`);
  }
  return Number(value);
}

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/[\s=-]/gu, "");
  if (!normalized || /[^A-Z2-7]/u.test(normalized)) {
    throw new BrowserAuthCredentialError("TOTP secret is not valid Base32");
  }
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    const digit = code >= 65 && code <= 90 ? code - 65 : code - 50 + 26;
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bytes.length === 0) throw new BrowserAuthCredentialError("TOTP secret is empty");
  return Buffer.from(bytes);
}
