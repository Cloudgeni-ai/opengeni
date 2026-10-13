/**
 * Vaults: the OpenGeni secrets model (replaces variable sets).
 *
 * A vault holds a flat list of items; an item holds named fields; hosted
 * fields keep encrypted versions. Every type here is `z.infer` of its schema.
 *
 * This module must not import runtime values from `./index` (the index
 * re-exports it); only types cross that edge.
 */
import { z } from "zod";
import { GeneratePasswordSpec } from "./secret-generator";

export const VaultOwnerKind = z.enum(["user", "workspace", "organization", "task"]);
export type VaultOwnerKind = z.infer<typeof VaultOwnerKind>;
export const VaultSource = z.enum(["opengeni", "onepassword", "host"]);
export type VaultSource = z.infer<typeof VaultSource>;
export const VaultMode = z.enum(["read_write", "read_only"]);
export type VaultMode = z.infer<typeof VaultMode>;
export const VaultSyncStatus = z.enum(["ok", "syncing", "error", "auth_expired", "rate_limited"]);
export type VaultSyncStatus = z.infer<typeof VaultSyncStatus>;
export const VaultItemType = z.enum(["login", "api_key", "note", "file", "passkey"]);
export type VaultItemType = z.infer<typeof VaultItemType>;
export const VaultFieldKind = z.enum(["text", "concealed", "totp", "file"]);
export type VaultFieldKind = z.infer<typeof VaultFieldKind>;
/** Lookup order for references that name no vault; index = tier. */
export const VAULT_LOOKUP_TIERS = ["task", "user", "workspace", "organization"] as const;
export type VaultLookupTier = (typeof VAULT_LOOKUP_TIERS)[number];

export const VAULT_LIMITS = {
  vaultsPerOwnerScope: 200,
  itemsPerVault: 2_000,
  fieldsPerItem: 50,
  versionsPerField: 10,
  nameMaxChars: 120,
  descriptionMaxChars: 2_000,
  websitesPerItem: 20,
  websiteMaxChars: 2_048,
  textValueMaxBytes: 65_536,
  fileValueMaxBytes: 262_144,
  referenceMaxChars: 300,
  execEnvMaxBytes: 262_144,
  execValueMaxBytes: 102_400,
  policyVaultIdsMax: 200,
  searchResultsMax: 50,
  providerReadsPerAttempt: 50,
  providerValueCacheMs: 60_000,
} as const;

/** Default names of lazily created hosted vaults (Q-06). */
export const DEFAULT_VAULT_NAMES = {
  user: "Private",
  workspace: "Shared",
  task: "Task",
} as const;

/** Default primary field per item type (§10B.2); passkeys have none. */
export const VAULT_DEFAULT_PRIMARY_FIELD: Readonly<Record<VaultItemType, string | null>> = {
  login: "password",
  api_key: "value",
  note: "note",
  file: "file",
  passkey: null,
};

/** Fixed passkey fields (D20). `privateKey` is concealed; the rest are text. */
export const PASSKEY_FIELD_NAMES = [
  "rpId",
  "credentialId",
  "userHandle",
  "userName",
  "privateKey",
] as const;

// Forbidden anywhere in a name: / { } # \ and C0/C1 control characters.
// oxlint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARACTERS = /[/{}#\\\u0000-\u001f\u007f-\u009f]/;

/**
 * Q-10: 1–120 characters, no `/ { } # \` or control characters, no leading
 * or trailing whitespace, and not starting with `id:` (reserved for the ID
 * reference form). Interior spaces and any other Unicode are allowed.
 */
export function isValidSecretName(name: string): boolean {
  if (typeof name !== "string") return false;
  const length = [...name].length;
  if (length < 1 || length > VAULT_LIMITS.nameMaxChars) return false;
  if (FORBIDDEN_NAME_CHARACTERS.test(name)) return false;
  if (name.trim() !== name) return false;
  if (name.toLowerCase().startsWith("id:")) return false;
  return true;
}

/** True when `name` is reserved as a field name (the `/otp` suffix). */
export function isReservedVaultFieldName(name: string): boolean {
  return name.normalize("NFC").trim().toLowerCase() === "otp";
}

export const VaultName = z
  .string()
  .min(1)
  .max(VAULT_LIMITS.nameMaxChars)
  .refine(isValidSecretName, "invalid_secret_name");
export const VaultFieldName = VaultName.refine(
  (name) => !isReservedVaultFieldName(name),
  "invalid_secret_name",
);

export const VaultPolicy = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({
      mode: z.literal("selected"),
      vaultIds: z.array(z.string().uuid()).max(VAULT_LIMITS.policyVaultIdsMax),
    })
    .strict(),
]);
export type VaultPolicy = z.infer<typeof VaultPolicy>;
export const VAULT_POLICY_ALL: VaultPolicy = Object.freeze({ mode: "all" }) as VaultPolicy;

/**
 * Intersect two policies. `all` is the identity; two selections keep the IDs
 * present in both (order of `a`).
 */
export function intersectVaultPolicies(a: VaultPolicy, b: VaultPolicy): VaultPolicy {
  if (a.mode === "all")
    return b.mode === "all" ? VAULT_POLICY_ALL : { mode: "selected", vaultIds: [...b.vaultIds] };
  if (b.mode === "all") return { mode: "selected", vaultIds: [...a.vaultIds] };
  const allowed = new Set(b.vaultIds);
  return { mode: "selected", vaultIds: a.vaultIds.filter((id) => allowed.has(id)) };
}

export const VaultAvailability = z
  .object({
    allowedWorkspaceIds: z.array(z.string().uuid()).max(500).nullable(), // null = every workspace
    allowPersonalWorkspaces: z.boolean(),
  })
  .strict();
export type VaultAvailability = z.infer<typeof VaultAvailability>;

export const VaultSummary = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  ownerKind: VaultOwnerKind,
  /** "Only me" | workspace name | organization name | "This task" */
  ownerLabel: z.string(),
  rootSessionId: z.string().uuid().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  source: VaultSource,
  mode: VaultMode,
  syncStatus: VaultSyncStatus,
  syncErrorCode: z.string().nullable(),
  syncErrorMessage: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  rateLimitedUntil: z.string().nullable(),
  providerConnectionId: z.string().uuid().nullable(),
  /** Organization vaults only. */
  availability: VaultAvailability.nullable(),
  isDefault: z.boolean(),
  itemCount: z.number().int(),
  canWrite: z.boolean(),
  canManage: z.boolean(),
  generation: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VaultSummary = z.infer<typeof VaultSummary>;

export const VaultItemReferences = z.object({
  primary: z.string().nullable(),
  otp: z.string().nullable(),
  byField: z.record(z.string(), z.string()),
});
export type VaultItemReferences = z.infer<typeof VaultItemReferences>;

export const VaultItemSummary = z.object({
  id: z.string().uuid(),
  vaultId: z.string().uuid(),
  type: VaultItemType,
  name: z.string(),
  websites: z.array(z.string()),
  /** Value of a text field named "username". */
  username: z.string().nullable(),
  hasTotp: z.boolean(),
  hasPasskey: z.boolean(),
  expiresAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  updatedAt: z.string(),
  references: VaultItemReferences,
});
export type VaultItemSummary = z.infer<typeof VaultItemSummary>;

export const VaultItemField = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: VaultFieldKind,
  position: z.number().int(),
  /** null for provider fields */
  currentVersion: z.number().int().nullable(),
  /** Plaintext ONLY for kind "text"; null otherwise. */
  value: z.string().nullable(),
  fileName: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  reference: z.string(),
  updatedAt: z.string(),
});
export type VaultItemField = z.infer<typeof VaultItemField>;

export const PasskeySummary = z.object({
  rpId: z.string(),
  userName: z.string().nullable(),
  /** Last 8 characters of the credential ID. */
  credentialIdSuffix: z.string(),
  signCount: z.number().int(),
  leasedUntil: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type PasskeySummary = z.infer<typeof PasskeySummary>;

export const VaultItem = VaultItemSummary.extend({
  fields: z.array(VaultItemField),
  passkey: PasskeySummary.nullable(),
  aliases: z.array(z.string()),
  primaryFieldId: z.string().uuid().nullable(),
  createdBySubjectId: z.string().nullable(),
  createdAt: z.string(),
  generation: z.number().int(),
});
export type VaultItem = z.infer<typeof VaultItem>;

export const VaultVersionCreatedByKind = z.enum([
  "human",
  "agent",
  "api_key",
  "migration",
  "provider",
  "system",
]);
export type VaultVersionCreatedByKind = z.infer<typeof VaultVersionCreatedByKind>;

export const VaultFieldVersionMeta = z.object({
  version: z.number().int(),
  current: z.boolean(),
  createdAt: z.string(),
  createdByKind: VaultVersionCreatedByKind,
  createdBySubjectId: z.string().nullable(),
});
export type VaultFieldVersionMeta = z.infer<typeof VaultFieldVersionMeta>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const CreateVaultRequest = z
  .object({
    name: VaultName,
    description: z.string().max(VAULT_LIMITS.descriptionMaxChars).optional(),
    ownerKind: z.enum(["user", "workspace", "organization"]),
    availability: VaultAvailability.optional(),
  })
  .strict();
export type CreateVaultRequest = z.infer<typeof CreateVaultRequest>;

export const UpdateVaultRequest = z
  .object({
    expectedGeneration: z.number().int(),
    name: VaultName.optional(),
    description: z.string().max(VAULT_LIMITS.descriptionMaxChars).nullable().optional(),
    availability: VaultAvailability.optional(),
  })
  .strict();
export type UpdateVaultRequest = z.infer<typeof UpdateVaultRequest>;

export const DeleteVaultRequest = z.object({ confirmName: z.string().min(1) }).strict();
export type DeleteVaultRequest = z.infer<typeof DeleteVaultRequest>;

const VALUE_SOURCE_KEYS = [
  "value",
  "generate",
  "fromReference",
  "fileBase64",
  "restoreVersion",
  "remove",
] as const;

/** Exactly one value source per field input. */
export function exactlyOneValueSource(
  input: Partial<Record<(typeof VALUE_SOURCE_KEYS)[number], unknown>>,
): boolean {
  return VALUE_SOURCE_KEYS.filter((key) => input[key] !== undefined).length === 1;
}

export const VaultFieldInput = z
  .object({
    fieldId: z.string().uuid().optional(),
    name: VaultFieldName,
    /** Default concealed; a field named "username" defaults to text. */
    kind: VaultFieldKind.optional(),
    value: z.string().optional(),
    generate: GeneratePasswordSpec.optional(),
    fromReference: z.string().max(VAULT_LIMITS.referenceMaxChars).optional(),
    fileBase64: z.string().optional(),
    fileName: z.string().max(255).optional(),
    restoreVersion: z.number().int().optional(),
    remove: z.literal(true).optional(),
  })
  .strict()
  .refine(
    exactlyOneValueSource,
    "exactly one of value|generate|fromReference|fileBase64|restoreVersion|remove",
  );
export type VaultFieldInput = z.infer<typeof VaultFieldInput>;

const CreateVaultItemShape = z
  .object({
    type: VaultItemType,
    name: VaultName,
    websites: z
      .array(z.string().max(VAULT_LIMITS.websiteMaxChars))
      .max(VAULT_LIMITS.websitesPerItem)
      .optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    fields: z.array(VaultFieldInput).max(VAULT_LIMITS.fieldsPerItem),
    primaryFieldName: z.string().optional(),
  })
  .strict();
export const CreateVaultItemRequest = CreateVaultItemShape;
export type CreateVaultItemRequest = z.infer<typeof CreateVaultItemRequest>;

export const UpdateVaultItemRequest = CreateVaultItemShape.partial()
  .extend({ expectedGeneration: z.number().int() })
  .strict();
export type UpdateVaultItemRequest = z.infer<typeof UpdateVaultItemRequest>;

export const MoveVaultItemRequest = z
  .object({
    targetVaultId: z.string().uuid(),
    mode: z.enum(["move", "copy"]),
    newName: VaultName.optional(),
  })
  .strict();
export type MoveVaultItemRequest = z.infer<typeof MoveVaultItemRequest>;

export const RevealVaultFieldRequest = z.object({ version: z.number().int().optional() }).strict();
export type RevealVaultFieldRequest = z.infer<typeof RevealVaultFieldRequest>;

export const RevealVaultFieldResponse = z.object({
  value: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  version: z.number().int().nullable(),
  totp: z
    .object({ code: z.string(), periodSeconds: z.number().int(), expiresAt: z.string() })
    .nullable(),
});
export type RevealVaultFieldResponse = z.infer<typeof RevealVaultFieldResponse>;

export const RestoreVaultFieldVersionRequest = z
  .object({ version: z.number().int().positive() })
  .strict();
export type RestoreVaultFieldVersionRequest = z.infer<typeof RestoreVaultFieldVersionRequest>;

const QueryBoolean = z.preprocess(
  (value) => (value === "true" ? true : value === "false" ? false : value),
  z.boolean(),
);
const QueryInt = z.preprocess(
  (value) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value),
  z.number().int().min(1).max(200),
);

/** Query strings are accepted as strings too ("true", "50"). */
export const ListVaultItemsQuery = z.object({
  q: z.string().max(200).optional(),
  type: VaultItemType.optional(),
  includeArchived: QueryBoolean.optional(),
  cursor: z.string().optional(),
  limit: QueryInt.optional(),
});
export type ListVaultItemsQuery = z.infer<typeof ListVaultItemsQuery>;

export const ListVaultsResponse = z.object({ vaults: z.array(VaultSummary) });
export type ListVaultsResponse = z.infer<typeof ListVaultsResponse>;
export const ListVaultItemsResponse = z.object({
  items: z.array(VaultItemSummary),
  nextCursor: z.string().nullable(),
});
export type ListVaultItemsResponse = z.infer<typeof ListVaultItemsResponse>;
export const ListVaultFieldVersionsResponse = z.object({
  versions: z.array(VaultFieldVersionMeta),
});
export type ListVaultFieldVersionsResponse = z.infer<typeof ListVaultFieldVersionsResponse>;

export const SetSessionVaultPolicyRequest = z.object({ policy: VaultPolicy }).strict();
export type SetSessionVaultPolicyRequest = z.infer<typeof SetSessionVaultPolicyRequest>;

export const SessionSecretsView = z.object({
  capabilityEnabled: z.boolean(),
  policy: VaultPolicy,
  effectiveVaultIds: z.array(z.string().uuid()),
  /** Nearest ancestor that narrowed, if any. */
  narrowedBySessionId: z.string().uuid().nullable(),
  taskVault: VaultSummary.nullable(),
  taskItems: z.array(VaultItemSummary),
  reachableVaults: z.array(VaultSummary.extend({ selected: z.boolean(), selectable: z.boolean() })),
});
export type SessionSecretsView = z.infer<typeof SessionSecretsView>;

export const InstallOnePasswordRequest = z
  .object({
    // Real service-account tokens are long; the dev fakes (ops_fake_healthy) are 16 chars.
    token: z.string().trim().min(16).max(4_096),
    ownership: z.enum(["user", "workspace", "organization"]),
    planTier: z.enum(["family", "teams", "business"]).default("teams"),
    label: z.string().max(120).optional(),
  })
  .strict();
export type InstallOnePasswordRequest = z.infer<typeof InstallOnePasswordRequest>;

export const ProviderVaultMeta = z.object({
  externalVaultId: z.string(),
  name: z.string(),
  itemCount: z.number().int().nullable(),
  linkedVaultId: z.string().uuid().nullable(),
});
export type ProviderVaultMeta = z.infer<typeof ProviderVaultMeta>;

export const InstallOnePasswordResponse = z.object({
  connectionId: z.string().uuid(),
  accountName: z.string().nullable(),
  vaults: z.array(ProviderVaultMeta),
});
export type InstallOnePasswordResponse = z.infer<typeof InstallOnePasswordResponse>;

export const LinkProviderVaultRequest = z
  .object({
    provider: z.enum(["onepassword", "host"]),
    /** Required for onepassword. */
    connectionId: z.string().uuid().optional(),
    externalVaultId: z.string(),
    ownerKind: z.enum(["user", "workspace", "organization"]),
    mode: VaultMode,
    name: VaultName.optional(),
    availability: VaultAvailability.optional(),
  })
  .strict();
export type LinkProviderVaultRequest = z.infer<typeof LinkProviderVaultRequest>;

export const CreateManagedProviderVaultRequest = z
  .object({
    name: VaultName,
    ownerKind: z.enum(["user", "workspace", "organization"]),
    groupId: z.string().optional(),
  })
  .strict();
export type CreateManagedProviderVaultRequest = z.infer<typeof CreateManagedProviderVaultRequest>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const VaultErrorCode = z.enum([
  "vault_not_found",
  "vault_item_not_found",
  "vault_field_not_found",
  "vault_name_conflict",
  "vault_item_name_conflict",
  "vault_limit_reached",
  "vault_read_only",
  "vault_generation_conflict",
  "vault_permission_denied",
  /** A session's vault policy reaches outside its parent's effective vaults (AX-2). */
  "vault_policy_outside_parent",
  "vault_reveal_requires_human",
  "encryption_key_missing",
  "provider_auth_invalid",
  "provider_auth_expired",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_conflict",
  "variable_sets_removed",
  "secret_save_forbidden",
  "invalid_secret_name",
  "secret_value_too_large",
  "human_auth_required",
]);
export type VaultErrorCode = z.infer<typeof VaultErrorCode>;

export const VaultApiError = z.object({
  error: VaultErrorCode,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type VaultApiError = z.infer<typeof VaultApiError>;

/** HTTP status for every vault error code (§10B.1.1). */
export const VAULT_ERROR_HTTP_STATUS: Readonly<Record<VaultErrorCode, number>> = {
  vault_not_found: 404,
  vault_item_not_found: 404,
  vault_field_not_found: 404,
  vault_name_conflict: 409,
  vault_item_name_conflict: 409,
  vault_generation_conflict: 409,
  provider_conflict: 409,
  vault_limit_reached: 422,
  invalid_secret_name: 422,
  secret_value_too_large: 422,
  secret_save_forbidden: 422,
  vault_policy_outside_parent: 422,
  vault_read_only: 403,
  vault_permission_denied: 403,
  vault_reveal_requires_human: 403,
  human_auth_required: 403,
  variable_sets_removed: 410,
  encryption_key_missing: 503,
  provider_unavailable: 503,
  provider_rate_limited: 429,
  provider_auth_invalid: 401,
  provider_auth_expired: 401,
};

// ---------------------------------------------------------------------------
// Agent tools (capability `secrets`)
// ---------------------------------------------------------------------------

export const SECRET_TOOL_NAMES = [
  "secret_search",
  "secret_save",
  "secret_get",
  "secret_move",
  "secret_delete",
] as const;
export type SecretToolName = (typeof SECRET_TOOL_NAMES)[number];

export const SECRET_SAVE_TO = z.enum(["user", "task", "workspace"]);
export type SecretSaveTo = z.infer<typeof SECRET_SAVE_TO>;

export const SecretSearchInput = z
  .object({
    query: z.string().max(200).optional(),
    website: z.string().max(VAULT_LIMITS.websiteMaxChars).optional(),
    type: VaultItemType.optional(),
    /** Vault name or ID. */
    vault: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(VAULT_LIMITS.searchResultsMax).default(20),
  })
  .strict();
export type SecretSearchInput = z.infer<typeof SecretSearchInput>;

export const SecretSearchResult = z.object({
  vault: z.object({
    id: z.string().uuid(),
    name: z.string(),
    ownerKind: VaultOwnerKind,
    source: VaultSource,
    mode: VaultMode,
  }),
  item: z.object({
    id: z.string().uuid(),
    name: z.string(),
    type: VaultItemType,
    websites: z.array(z.string()),
    username: z.string().nullable(),
    hasTotp: z.boolean(),
    hasPasskey: z.boolean(),
    expiresAt: z.string().nullable(),
  }),
  fields: z.array(z.object({ name: z.string(), kind: VaultFieldKind })),
  references: VaultItemReferences,
});
export type SecretSearchResult = z.infer<typeof SecretSearchResult>;
export const SecretSearchOutput = z.object({
  items: z.array(SecretSearchResult),
  truncated: z.boolean(),
});
export type SecretSearchOutput = z.infer<typeof SecretSearchOutput>;

export const SecretSaveFieldInput = z
  .object({
    name: VaultFieldName,
    kind: VaultFieldKind.optional(),
    value: z.string().optional(),
    generate: GeneratePasswordSpec.optional(),
    fromReference: z.string().max(VAULT_LIMITS.referenceMaxChars).optional(),
    restoreVersion: z.number().int().optional(),
  })
  .strict()
  .refine(exactlyOneValueSource, "exactly one of value|generate|fromReference|restoreVersion");
export type SecretSaveFieldInput = z.infer<typeof SecretSaveFieldInput>;

export const SecretSaveInput = z
  .object({
    item: VaultName,
    /** Vault name or ID; defaults to the saveTo scope's default vault. */
    vault: z.string().max(200).optional(),
    saveTo: SECRET_SAVE_TO.optional(),
    type: VaultItemType.default("login"),
    websites: z
      .array(z.string().max(VAULT_LIMITS.websiteMaxChars))
      .max(VAULT_LIMITS.websitesPerItem)
      .optional(),
    username: z.string().max(512).optional(),
    fields: z.array(SecretSaveFieldInput).max(VAULT_LIMITS.fieldsPerItem).optional(),
    mode: z.enum(["create", "update", "upsert"]).default("upsert"),
  })
  .strict();
export type SecretSaveInput = z.infer<typeof SecretSaveInput>;
export const SecretSaveOutput = z.object({
  item: VaultItemSummary,
  references: VaultItemReferences,
  generatedFields: z.array(z.string()),
});
export type SecretSaveOutput = z.infer<typeof SecretSaveOutput>;

export const SecretGetInput = z
  .object({
    reference: z.string().min(1).max(VAULT_LIMITS.referenceMaxChars),
    version: z.number().int().optional(),
  })
  .strict();
export type SecretGetInput = z.infer<typeof SecretGetInput>;
export const SecretGetOutput = RevealVaultFieldResponse;
export type SecretGetOutput = RevealVaultFieldResponse;

export const SecretMoveInput = z
  .object({
    reference: z.string().min(1).max(VAULT_LIMITS.referenceMaxChars),
    /** Vault name or ID. */
    toVault: z.string().min(1).max(200),
    mode: z.enum(["move", "copy"]).default("move"),
    newName: VaultName.optional(),
  })
  .strict();
export type SecretMoveInput = z.infer<typeof SecretMoveInput>;
export const SecretMoveOutput = z.object({
  item: VaultItemSummary,
  references: VaultItemReferences,
});
export type SecretMoveOutput = z.infer<typeof SecretMoveOutput>;

export const SecretDeleteInput = z
  .object({ reference: z.string().min(1).max(VAULT_LIMITS.referenceMaxChars) })
  .strict();
export type SecretDeleteInput = z.infer<typeof SecretDeleteInput>;
export const SecretDeleteOutput = z.object({ archived: z.literal(true), restoreHint: z.string() });
export type SecretDeleteOutput = z.infer<typeof SecretDeleteOutput>;

// ---------------------------------------------------------------------------
// Events, audit and metrics (§10B.1.9)
// ---------------------------------------------------------------------------

export const VAULT_POLICY_UPDATED_EVENT_TYPE = "session.vaultPolicy.updated" as const;

export const VAULT_AUDIT_ACTIONS = [
  "vault.created",
  "vault.updated",
  "vault.deleted",
  "vault.item.created",
  "vault.item.updated",
  "vault.item.archived",
  "vault.item.restored",
  "vault.item.deleted",
  "vault.item.moved",
  "vault.item.copied",
  "vault.field.set",
  "vault.field.revealed",
  "vault.secret.used",
  "vault.secret.read",
  "vault.secret.read.denied",
  "vault.reference.failed",
  "vault.provider.connected",
  "vault.provider.linked",
  "vault.provider.synced",
  "vault.provider.error",
  "vault.passkey.registered",
  "vault.passkey.asserted",
  "vault.policy.updated",
  "vault.migrated",
] as const;
export const VaultAuditAction = z.enum(VAULT_AUDIT_ACTIONS);
export type VaultAuditAction = z.infer<typeof VaultAuditAction>;
export const VAULT_AUDIT_TARGET_TYPES = ["vault", "vault_item"] as const;

export const VAULT_METRIC_NAMES = {
  resolutions: "opengeni_secret_resolutions_total",
  resolutionDuration: "opengeni_secret_resolution_duration_seconds",
  execEnvBytes: "opengeni_secret_exec_env_bytes",
  providerCalls: "opengeni_vault_provider_calls_total",
  providerRateLimited: "opengeni_vault_provider_rate_limited_total",
  passkeyAssertions: "opengeni_passkey_assertions_total",
} as const;
