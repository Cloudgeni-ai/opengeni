// Vault wire types (hand-written mirrors of `@opengeni/contracts` vaults.ts).
// SDK consumers do not need the contracts runtime; apps/web pins these
// mirrors against the zod schemas in a type-parity test.
import type { VaultPolicy } from "./types";

export type { VaultPolicy };

export type VaultOwnerKind = "user" | "workspace" | "organization" | "task";
export type VaultSource = "opengeni" | "onepassword" | "host";
export type VaultMode = "read_write" | "read_only";
export type VaultSyncStatus = "ok" | "syncing" | "error" | "auth_expired" | "rate_limited";
export type VaultItemType = "login" | "api_key" | "note" | "file" | "passkey";
export type VaultFieldKind = "text" | "concealed" | "totp" | "file";

export type VaultAvailability = {
  /** null = every workspace in the organization. */
  allowedWorkspaceIds: string[] | null;
  allowPersonalWorkspaces: boolean;
};

export type VaultSummary = {
  id: string;
  workspaceId: string;
  ownerKind: VaultOwnerKind;
  ownerLabel: string;
  rootSessionId: string | null;
  name: string;
  description: string | null;
  source: VaultSource;
  mode: VaultMode;
  syncStatus: VaultSyncStatus;
  syncErrorCode: string | null;
  syncErrorMessage: string | null;
  lastSyncedAt: string | null;
  rateLimitedUntil: string | null;
  providerConnectionId: string | null;
  availability: VaultAvailability | null;
  isDefault: boolean;
  itemCount: number;
  canWrite: boolean;
  canManage: boolean;
  generation: number;
  createdAt: string;
  updatedAt: string;
};

export type VaultItemReferences = {
  primary: string | null;
  otp: string | null;
  byField: Record<string, string>;
};

export type VaultItemSummary = {
  id: string;
  vaultId: string;
  type: VaultItemType;
  name: string;
  websites: string[];
  username: string | null;
  hasTotp: boolean;
  hasPasskey: boolean;
  expiresAt: string | null;
  archivedAt: string | null;
  lastUsedAt: string | null;
  updatedAt: string;
  references: VaultItemReferences;
};

export type VaultItemField = {
  id: string;
  name: string;
  kind: VaultFieldKind;
  position: number;
  /** null for provider fields. */
  currentVersion: number | null;
  /** Plaintext only for kind "text"; null otherwise. */
  value: string | null;
  fileName: string | null;
  fileSize: number | null;
  reference: string;
  updatedAt: string;
};

export type PasskeySummary = {
  rpId: string;
  userName: string | null;
  credentialIdSuffix: string;
  signCount: number;
  leasedUntil: string | null;
  lastUsedAt: string | null;
};

export type VaultItem = VaultItemSummary & {
  fields: VaultItemField[];
  passkey: PasskeySummary | null;
  aliases: string[];
  primaryFieldId: string | null;
  createdBySubjectId: string | null;
  createdAt: string;
  generation: number;
};

export type VaultVersionCreatedByKind =
  | "human"
  | "agent"
  | "api_key"
  | "migration"
  | "provider"
  | "system";

export type VaultFieldVersionMeta = {
  version: number;
  current: boolean;
  createdAt: string;
  createdByKind: VaultVersionCreatedByKind;
  createdBySubjectId: string | null;
};

export type GeneratePasswordOptions = {
  length?: number | undefined;
  lowercase?: boolean | undefined;
  uppercase?: boolean | undefined;
  digits?: boolean | undefined;
  symbols?: boolean | undefined;
  symbolSet?: string | undefined;
  excludeAmbiguous?: boolean | undefined;
  requireEachClass?: boolean | undefined;
};

export type CreateVaultRequest = {
  name: string;
  description?: string | undefined;
  ownerKind: "user" | "workspace" | "organization";
  availability?: VaultAvailability | undefined;
};

export type UpdateVaultRequest = {
  expectedGeneration: number;
  name?: string | undefined;
  description?: string | null | undefined;
  availability?: VaultAvailability | undefined;
};

export type VaultFieldInput = {
  fieldId?: string | undefined;
  name: string;
  kind?: VaultFieldKind | undefined;
  value?: string | undefined;
  generate?: GeneratePasswordOptions | undefined;
  fromReference?: string | undefined;
  fileBase64?: string | undefined;
  fileName?: string | undefined;
  restoreVersion?: number | undefined;
  remove?: true | undefined;
};

export type CreateVaultItemRequest = {
  type: VaultItemType;
  name: string;
  websites?: string[] | undefined;
  expiresAt?: string | null | undefined;
  fields: VaultFieldInput[];
  primaryFieldName?: string | undefined;
};

export type UpdateVaultItemRequest = Partial<CreateVaultItemRequest> & {
  expectedGeneration: number;
};

export type MoveVaultItemRequest = {
  targetVaultId: string;
  mode: "move" | "copy";
  newName?: string | undefined;
};

export type RevealVaultFieldResponse = {
  value: string;
  encoding: "utf8" | "base64";
  version: number | null;
  totp: { code: string; periodSeconds: number; expiresAt: string } | null;
};

export type ListVaultItemsQuery = {
  q?: string | undefined;
  type?: VaultItemType | undefined;
  includeArchived?: boolean | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export type SessionSecretsVault = VaultSummary & { selected: boolean; selectable: boolean };

export type SessionSecretsView = {
  capabilityEnabled: boolean;
  policy: VaultPolicy;
  effectiveVaultIds: string[];
  /** Nearest ancestor that narrowed, if any. */
  narrowedBySessionId: string | null;
  taskVault: VaultSummary | null;
  taskItems: VaultItemSummary[];
  reachableVaults: SessionSecretsVault[];
};

export type OnePasswordPlanTier = "family" | "teams" | "business";

export type InstallOnePasswordRequest = {
  token: string;
  ownership: "user" | "workspace" | "organization";
  planTier?: OnePasswordPlanTier | undefined;
  label?: string | undefined;
};

export type ProviderVaultMeta = {
  externalVaultId: string;
  name: string;
  itemCount: number | null;
  linkedVaultId: string | null;
};

export type InstallOnePasswordResponse = {
  connectionId: string;
  accountName: string | null;
  vaults: ProviderVaultMeta[];
};

/** A 1Password service account connected in a workspace. Never carries the token. */
export type OnePasswordConnectionSummary = {
  id: string;
  /** Who can use the vaults linked through it. */
  ownership: "user" | "workspace" | "organization";
  /** Sign-in host from the token, for example "my.1password.com". */
  accountName: string | null;
  label: string | null;
  planTier: OnePasswordPlanTier;
  /** When the current token was last checked against 1Password. */
  verifiedAt: string;
  createdAt: string;
  createdBySubjectId: string | null;
  /** The caller can link vaults, replace the token and disconnect it. */
  canManage: boolean;
};

/** A new token for an existing connection; its linked vaults keep working. */
export type ReplaceOnePasswordTokenRequest = {
  token: string;
  planTier?: OnePasswordPlanTier | undefined;
};

export type DisconnectOnePasswordResponse = {
  /** The Opengeni vaults that were unlinked. Nothing is deleted in 1Password. */
  unlinkedVaultIds: string[];
};

export type LinkProviderVaultRequest = {
  provider: "onepassword" | "host";
  connectionId?: string | undefined;
  externalVaultId: string;
  ownerKind: "user" | "workspace" | "organization";
  mode: VaultMode;
  name?: string | undefined;
  availability?: VaultAvailability | undefined;
};

export type CreateManagedProviderVaultRequest = {
  name: string;
  ownerKind: "user" | "workspace" | "organization";
  groupId?: string | undefined;
};

export type VaultErrorCode =
  | "vault_not_found"
  | "vault_item_not_found"
  | "vault_field_not_found"
  | "vault_name_conflict"
  | "vault_item_name_conflict"
  | "vault_limit_reached"
  | "vault_read_only"
  | "vault_generation_conflict"
  | "vault_permission_denied"
  | "vault_reveal_requires_human"
  | "vault_policy_outside_parent"
  | "encryption_key_missing"
  | "provider_auth_invalid"
  | "provider_auth_expired"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_conflict"
  | "variable_sets_removed"
  | "secret_save_forbidden"
  | "invalid_secret_name"
  | "secret_value_too_large"
  | "human_auth_required";
