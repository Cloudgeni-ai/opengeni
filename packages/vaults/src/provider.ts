import type {
  SecretMaterial,
  VaultFieldKind,
  VaultItemType,
  VaultSource,
} from "@opengeni/contracts";

export interface VaultProviderCapabilities {
  write: boolean;
  createVault: boolean;
  totp: boolean;
  files: boolean;
  groupGrants: boolean;
  /** Passkeys live only in OpenGeni-hosted vaults (D20). */
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
export interface ProviderWriteField {
  externalFieldId?: string;
  name: string;
  kind: VaultFieldKind;
  value?: string;
  remove?: true;
}
export interface ProviderWriteItem {
  externalItemId?: string;
  expectedVersion?: string | null;
  name: string;
  type: VaultItemType;
  websites: string[];
  fields: ProviderWriteField[];
}
export type ProviderCallOperation = "list" | "read" | "write" | "admin";
export interface ProviderCallBudget {
  /** Throws VaultProviderError("provider_rate_limited") when exhausted. */
  take(op: ProviderCallOperation): void;
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

export const VAULT_PROVIDER_ERROR_CODES = [
  "provider_auth_invalid",
  "provider_auth_expired",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_conflict",
  "provider_not_found",
  /**
   * The provider refused the operation for this credential (for example a
   * write into a 1Password vault the service account can only read). The vault
   * service reports `vault_read_only` for writes, `vault_permission_denied` otherwise.
   */
  "provider_permission_denied",
] as const;
export type VaultProviderErrorCode = (typeof VAULT_PROVIDER_ERROR_CODES)[number];

export class VaultProviderError extends Error {
  readonly code: VaultProviderErrorCode;
  readonly retryAfterMs: number | undefined;
  constructor(code: VaultProviderErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "VaultProviderError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isVaultProviderError(error: unknown): error is VaultProviderError {
  return error instanceof VaultProviderError;
}

export interface VaultProviderRegistry {
  /** onepassword: loads the connection credential and the SDK lazily; host: the embedder port; fake: tests/dev. */
  forVault(vault: {
    source: VaultSource;
    providerConnectionId: string | null;
  }): Promise<VaultProvider>;
}

/**
 * A registry over fixed provider factories. Missing providers raise
 * `provider_unavailable`; `opengeni` (hosted) vaults never reach a provider.
 */
export function createVaultProviderRegistry(factories: {
  onepassword?: (connectionId: string | null) => Promise<VaultProvider>;
  host?: () => Promise<VaultProvider>;
}): VaultProviderRegistry {
  return {
    async forVault(vault) {
      if (vault.source === "onepassword" && factories.onepassword) {
        return factories.onepassword(vault.providerConnectionId);
      }
      if (vault.source === "host" && factories.host) return factories.host();
      throw new VaultProviderError(
        "provider_unavailable",
        vault.source === "opengeni"
          ? "hosted vaults are read from the database, not a provider"
          : `no ${vault.source} vault provider is configured`,
      );
    },
  };
}

/** A registry with no providers: every provider vault is unavailable. */
export const EMPTY_VAULT_PROVIDER_REGISTRY: VaultProviderRegistry = createVaultProviderRegistry({});

/**
 * A simple counting budget: at most `limit` calls of any kind (Q-18 uses 50
 * reads per attempt). Exhaustion raises `provider_rate_limited`.
 */
export function createProviderCallBudget(limit: number): ProviderCallBudget & { used(): number } {
  let used = 0;
  return {
    take(op) {
      if (used >= limit) {
        throw new VaultProviderError(
          "provider_rate_limited",
          `this attempt used its ${limit} vault provider calls (last: ${op})`,
        );
      }
      used += 1;
    },
    used: () => used,
  };
}
