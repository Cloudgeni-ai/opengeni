// TEMPORARY: mirrors dossier §10B.1.4 until F1 publishes @opengeni/vaults.
// After the F1 rebase this file only re-exports the real contracts.
export type VaultItemType = "login" | "api_key" | "note" | "file" | "passkey";
export type VaultFieldKind = "text" | "concealed" | "totp" | "file";

export interface TotpParams {
  secretBase32: string;
  algorithm: "SHA1" | "SHA256" | "SHA512";
  digits: 6 | 7 | 8;
  periodSeconds: number;
}
export type SecretMaterial =
  | { type: "text"; value: string }
  | { type: "bytes"; value: Uint8Array }
  | { type: "totp"; params: TotpParams };

export interface VaultProviderCapabilities {
  write: boolean;
  createVault: boolean;
  totp: boolean;
  files: boolean;
  groupGrants: boolean;
  passkeys: false;
}
export interface ProviderVault {
  externalVaultId: string;
  name: string;
  contentVersion: string | null;
  itemCount: number | null;
}
export interface ProviderFieldMeta {
  externalFieldId: string;
  name: string;
  kind: VaultFieldKind;
}
export interface ProviderItemMeta {
  externalItemId: string;
  name: string;
  type: VaultItemType;
  websites: string[];
  fields: ProviderFieldMeta[];
  version: string | null;
  updatedAt: string | null;
}
export interface ProviderFieldValue {
  externalFieldId: string;
  material: SecretMaterial;
}
export interface ProviderWriteItem {
  externalItemId?: string;
  expectedVersion?: string | null;
  name: string;
  type: VaultItemType;
  websites: string[];
  fields: Array<{
    externalFieldId?: string;
    name: string;
    kind: VaultFieldKind;
    value?: string;
    remove?: true;
  }>;
}
export interface ProviderCallBudget {
  take(op: "list" | "read" | "write" | "admin"): void;
}
export interface VaultProviderContext {
  connectionId: string | null;
  budget: ProviderCallBudget;
  signal?: AbortSignal;
}
export interface VaultProvider {
  readonly id: "onepassword" | "host" | "fake";
  capabilities(): VaultProviderCapabilities;
  validate(ctx: VaultProviderContext): Promise<{ accountName: string | null }>;
  listVaults(ctx: VaultProviderContext): Promise<ProviderVault[]>;
  listItems(ctx: VaultProviderContext, externalVaultId: string): Promise<ProviderItemMeta[]>;
  readFields(
    ctx: VaultProviderContext,
    externalVaultId: string,
    externalItemId: string,
    externalFieldIds: readonly string[],
  ): Promise<ProviderFieldValue[]>;
  writeItem(
    ctx: VaultProviderContext,
    externalVaultId: string,
    item: ProviderWriteItem,
  ): Promise<ProviderItemMeta>;
  archiveItem(
    ctx: VaultProviderContext,
    externalVaultId: string,
    externalItemId: string,
  ): Promise<void>;
  createVault?(
    ctx: VaultProviderContext,
    input: { name: string; description?: string; allowAdminsAccess: boolean; groupId?: string },
  ): Promise<ProviderVault>;
}
export type VaultProviderErrorCode =
  | "provider_auth_invalid"
  | "provider_auth_expired"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_conflict"
  | "provider_not_found"
  | "provider_permission_denied";
export class VaultProviderError extends Error {
  constructor(
    readonly code: VaultProviderErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "VaultProviderError";
  }
}

const BASE32 = /^[A-Z2-7]+=*$/;
/** TEMP stand-in for contracts parseTotpInput (otpauth URI or base32 seed). */
export function parseTotpInput(input: string): TotpParams {
  const trimmed = input.trim();
  if (trimmed.toLowerCase().startsWith("otpauth://")) {
    const url = new URL(trimmed);
    const secret = (url.searchParams.get("secret") ?? "").replace(/\s+/g, "").toUpperCase();
    if (!BASE32.test(secret)) throw new Error("invalid TOTP secret");
    const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
    const digits = Number(url.searchParams.get("digits") ?? 6);
    const period = Number(url.searchParams.get("period") ?? 30);
    if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512")
      throw new Error("invalid TOTP algorithm");
    if (digits !== 6 && digits !== 7 && digits !== 8) throw new Error("invalid TOTP digits");
    return { secretBase32: secret, algorithm, digits, periodSeconds: period };
  }
  const secret = trimmed.replace(/\s+/g, "").toUpperCase();
  if (!BASE32.test(secret)) throw new Error("invalid TOTP secret");
  return { secretBase32: secret, algorithm: "SHA1", digits: 6, periodSeconds: 30 };
}

function base32Bytes(secret: string): Uint8Array<ArrayBuffer> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of secret.replace(/=+$/, "")) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** TEMP stand-in for contracts totpCode (RFC 6238). */
export async function totpCode(params: TotpParams, atMs: number): Promise<string> {
  const counter = Math.floor(atMs / 1000 / params.periodSeconds);
  const message = new ArrayBuffer(8);
  new DataView(message).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey(
    "raw",
    base32Bytes(params.secretBase32),
    { name: "HMAC", hash: `SHA-${params.algorithm.slice(3)}` },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** params.digits).padStart(params.digits, "0");
}
