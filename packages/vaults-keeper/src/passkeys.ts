import { createPrivateKey } from "node:crypto";
import { type ProviderPasskey, type ProviderPasskeyMeta, VaultProviderError } from "./contract";
import type { KeeperRecord } from "./sdk";

/**
 * Keeper keeps a login's passkeys in a field of type "passkey" whose values
 * look like `{ privateKey: <EC JWK>, credentialId, signCount, userId,
 * relyingParty, username }`, ids base64url.
 */
type KeeperPasskeyValue = Record<string, unknown>;

function base64url(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length > 0 ? bytes.toString("base64url") : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Every passkey value in the record, in field order. */
function passkeyValues(record: KeeperRecord): KeeperPasskeyValue[] {
  const data = (record.data && typeof record.data === "object" ? record.data : {}) as {
    fields?: unknown;
    custom?: unknown;
  };
  const entries: unknown[] = [
    ...(Array.isArray(data.fields) ? data.fields : []),
    ...(Array.isArray(data.custom) ? data.custom : []),
  ];
  const values: KeeperPasskeyValue[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { type, value: list } = entry as { type?: unknown; value?: unknown };
    if (type !== "passkey") continue;
    for (const value of Array.isArray(list) ? list : []) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        values.push(value as KeeperPasskeyValue);
      }
    }
  }
  return values;
}

function metaOf(value: KeeperPasskeyValue): ProviderPasskeyMeta | null {
  const credentialId = base64url(value.credentialId);
  const rpId = text(value.relyingParty);
  if (!credentialId || !rpId) return null;
  return { credentialId, rpId, userName: text(value.username) };
}

function signCountOf(value: KeeperPasskeyValue): number {
  const count = value.signCount;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/** The PKCS#8 form of an EC P-256 JWK, or null for any other key. */
function pkcs8Of(jwk: unknown): string | null {
  if (!jwk || typeof jwk !== "object") return null;
  const { kty, crv, x, y, d } = jwk as Record<string, unknown>;
  if (kty !== "EC" || crv !== "P-256") return null;
  if (typeof x !== "string" || typeof y !== "string" || typeof d !== "string") return null;
  try {
    const der = createPrivateKey({ key: { kty, crv, x, y, d }, format: "jwk" }).export({
      format: "der",
      type: "pkcs8",
    });
    return Buffer.from(der).toString("base64url");
  } catch {
    return null;
  }
}

/** The record's passkeys without their keys, for the mirror. */
export function keeperPasskeyMetas(record: KeeperRecord): ProviderPasskeyMeta[] {
  return passkeyValues(record).flatMap((value) => {
    const meta = metaOf(value);
    return meta ? [meta] : [];
  });
}

/** The record's P-256 passkeys with their key material. */
export function keeperPasskeys(record: KeeperRecord): ProviderPasskey[] {
  return passkeyValues(record).flatMap((value) => {
    const meta = metaOf(value);
    const privateKey = meta ? pkcs8Of(value.privateKey) : null;
    if (!meta || !privateKey) return [];
    return [
      {
        credentialId: meta.credentialId,
        rpId: meta.rpId,
        userHandle: base64url(value.userId),
        userName: meta.userName ?? null,
        userDisplayName: null,
        privateKey,
        signCount: signCountOf(value),
      },
    ];
  });
}

/**
 * Raise one passkey's counter in the record (in place). Returns false when it
 * was already at least `signCount`; `provider_not_found` when there is no
 * such passkey.
 */
export function raiseKeeperPasskeySignCount(
  record: KeeperRecord,
  credentialId: string,
  signCount: number,
): boolean {
  const value = passkeyValues(record).find((candidate) => {
    return metaOf(candidate)?.credentialId === credentialId;
  });
  if (!value)
    throw new VaultProviderError("provider_not_found", "The Keeper record has no such passkey");
  if (signCountOf(value) >= signCount) return false;
  value.signCount = signCount;
  return true;
}
