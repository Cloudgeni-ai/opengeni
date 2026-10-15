import { defineSchema } from "./define-schema";
/**
 * Vaults: the Opengeni secrets model (replaces variable sets).
 *
 * A vault holds a flat list of items; an item holds named fields; hosted
 * fields keep encrypted versions. Every type here is `z.infer` of its schema.
 *
 * This module must not import runtime values from `./index` (the index
 * re-exports it); only types cross that edge.
 */
import { z } from "zod";
import { GeneratePasswordSpec } from "./secret-generator";

export const VaultOwnerKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["user", "workspace", "organization", "task"]),
);
export type VaultOwnerKind = z.infer<typeof VaultOwnerKind>;
export const VaultSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["opengeni", "onepassword", "host", "external", "protonpass", "keeper", "bitwarden"]),
);
export type VaultSource = z.infer<typeof VaultSource>;
export const VaultMode = /* @__PURE__ */ defineSchema(() => z.enum(["read_write", "read_only"]));
export type VaultMode = z.infer<typeof VaultMode>;
export const VaultSyncStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["ok", "syncing", "error", "auth_expired", "rate_limited"]),
);
export type VaultSyncStatus = z.infer<typeof VaultSyncStatus>;
export const VaultItemType = /* @__PURE__ */ defineSchema(() =>
  z.enum(["login", "api_key", "note", "file", "passkey"]),
);
export type VaultItemType = z.infer<typeof VaultItemType>;
export const VaultFieldKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["text", "concealed", "totp", "file"]),
);
export type VaultFieldKind = z.infer<typeof VaultFieldKind>;

/** Effective operations, not a promise that upstream permissions cannot change. */
export const VaultProviderOperations = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      createItemTypes: z.array(VaultItemType).max(5),
      updateItem: z.boolean(),
      removeField: z.boolean(),
      archiveItem: z.boolean(),
      archiveKind: z.enum(["archive", "trash", "none"]),
      /** Permanent provider deletion is deliberately not exposed. */
      deleteItem: z.literal(false),
      restoreItem: z.boolean(),
      readFiles: z.boolean(),
      writeFiles: z.boolean(),
      createTotp: z.boolean(),
      updateTotp: z.boolean(),
      createVault: z.boolean(),
      restoreFieldHistory: z.boolean(),
    })
    .strict(),
);
export type VaultProviderOperations = z.infer<typeof VaultProviderOperations>;

/** A successful mirror check does not prove a customer's upstream cache is current. */
export const VaultProviderFreshness = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      state: z.enum(["current", "stale", "refreshing", "unavailable"]),
      lastCheckedAt: z.string().datetime().nullable(),
      sourceSyncedAt: z.string().datetime().nullable(),
      source: z.enum(["live", "cache", "unknown"]),
      errorCode: z.string().max(100).nullable(),
      retryAt: z.string().datetime().nullable(),
    })
    .strict(),
);
export type VaultProviderFreshness = z.infer<typeof VaultProviderFreshness>;
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
  /** Items one agent search call examines before it returns a cursor. */
  searchScanMax: 1_000,
  searchCursorMaxChars: 1_024,
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

export const VaultName = /* @__PURE__ */ defineSchema(() =>
  z.string().min(1).max(VAULT_LIMITS.nameMaxChars).refine(isValidSecretName, "invalid_secret_name"),
);
export const VaultFieldName = /* @__PURE__ */ defineSchema(() =>
  VaultName.refine((name) => !isReservedVaultFieldName(name), "invalid_secret_name"),
);

export const VaultPolicy = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("all") }).strict(),
    z
      .object({
        mode: z.literal("selected"),
        vaultIds: z.array(z.string().uuid()).max(VAULT_LIMITS.policyVaultIdsMax),
      })
      .strict(),
  ]),
);
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

export const VaultAvailability = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      allowedWorkspaceIds: z.array(z.string().uuid()).max(500).nullable(), // null = every workspace
      allowPersonalWorkspaces: z.boolean(),
    })
    .strict(),
);
export type VaultAvailability = z.infer<typeof VaultAvailability>;

export const VaultSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
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
    providerOperations: VaultProviderOperations.optional(),
    freshness: VaultProviderFreshness.optional(),
    /** Organization and Only-me vaults; null for workspace and task vaults. */
    availability: VaultAvailability.nullable(),
    isDefault: z.boolean(),
    itemCount: z.number().int(),
    canWrite: z.boolean(),
    canManage: z.boolean(),
    generation: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type VaultSummary = z.infer<typeof VaultSummary>;

export const VaultItemReferences = /* @__PURE__ */ defineSchema(() =>
  z.object({
    primary: z.string().nullable(),
    otp: z.string().nullable(),
    byField: z.record(z.string(), z.string()),
  }),
);
export type VaultItemReferences = z.infer<typeof VaultItemReferences>;

export const VaultItemSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
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
  }),
);
export type VaultItemSummary = z.infer<typeof VaultItemSummary>;

export const VaultItemField = /* @__PURE__ */ defineSchema(() =>
  z.object({
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
  }),
);
export type VaultItemField = z.infer<typeof VaultItemField>;

export const PasskeySummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    rpId: z.string(),
    userName: z.string().nullable(),
    /** Last 8 characters of the credential ID. */
    credentialIdSuffix: z.string(),
    signCount: z.number().int(),
    leasedUntil: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
  }),
);
export type PasskeySummary = z.infer<typeof PasskeySummary>;

export const VaultItem = /* @__PURE__ */ defineSchema(() =>
  VaultItemSummary.extend({
    fields: z.array(VaultItemField),
    passkey: PasskeySummary.nullable(),
    aliases: z.array(z.string()),
    primaryFieldId: z.string().uuid().nullable(),
    createdBySubjectId: z.string().nullable(),
    createdAt: z.string(),
    generation: z.number().int(),
  }),
);
export type VaultItem = z.infer<typeof VaultItem>;

export const VaultVersionCreatedByKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["human", "agent", "api_key", "migration", "provider", "system"]),
);
export type VaultVersionCreatedByKind = z.infer<typeof VaultVersionCreatedByKind>;

export const VaultFieldVersionMeta = /* @__PURE__ */ defineSchema(() =>
  z.object({
    version: z.number().int(),
    current: z.boolean(),
    createdAt: z.string(),
    createdByKind: VaultVersionCreatedByKind,
    createdBySubjectId: z.string().nullable(),
  }),
);
export type VaultFieldVersionMeta = z.infer<typeof VaultFieldVersionMeta>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const CreateVaultRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: VaultName,
      description: z.string().max(VAULT_LIMITS.descriptionMaxChars).optional(),
      ownerKind: z.enum(["user", "workspace", "organization"]),
      availability: VaultAvailability.optional(),
    })
    .strict(),
);
export type CreateVaultRequest = z.infer<typeof CreateVaultRequest>;

export const UpdateVaultRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedGeneration: z.number().int(),
      name: VaultName.optional(),
      description: z.string().max(VAULT_LIMITS.descriptionMaxChars).nullable().optional(),
      availability: VaultAvailability.optional(),
    })
    .strict(),
);
export type UpdateVaultRequest = z.infer<typeof UpdateVaultRequest>;

export const DeleteVaultRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ confirmName: z.string().min(1) }).strict(),
);
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

export const VaultFieldInput = /* @__PURE__ */ defineSchema(() =>
  z
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
    ),
);
export type VaultFieldInput = z.infer<typeof VaultFieldInput>;

const CreateVaultItemShape = /* @__PURE__ */ defineSchema(() =>
  z
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
    .strict(),
);
export const CreateVaultItemRequest = CreateVaultItemShape;
export type CreateVaultItemRequest = z.infer<typeof CreateVaultItemRequest>;

export const UpdateVaultItemRequest = /* @__PURE__ */ defineSchema(() =>
  CreateVaultItemShape.partial().extend({ expectedGeneration: z.number().int() }).strict(),
);
export type UpdateVaultItemRequest = z.infer<typeof UpdateVaultItemRequest>;

export const MoveVaultItemRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      targetVaultId: z.string().uuid(),
      mode: z.enum(["move", "copy"]),
      newName: VaultName.optional(),
    })
    .strict(),
);
export type MoveVaultItemRequest = z.infer<typeof MoveVaultItemRequest>;

export const RevealVaultFieldRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ version: z.number().int().optional() }).strict(),
);
export type RevealVaultFieldRequest = z.infer<typeof RevealVaultFieldRequest>;

export const RevealVaultFieldResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    value: z.string(),
    encoding: z.enum(["utf8", "base64"]),
    version: z.number().int().nullable(),
    totp: z
      .object({ code: z.string(), periodSeconds: z.number().int(), expiresAt: z.string() })
      .nullable(),
  }),
);
export type RevealVaultFieldResponse = z.infer<typeof RevealVaultFieldResponse>;

export const RestoreVaultFieldVersionRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ version: z.number().int().positive() }).strict(),
);
export type RestoreVaultFieldVersionRequest = z.infer<typeof RestoreVaultFieldVersionRequest>;

const QueryBoolean = /* @__PURE__ */ defineSchema(() =>
  z.preprocess(
    (value) => (value === "true" ? true : value === "false" ? false : value),
    z.boolean(),
  ),
);
const QueryInt = /* @__PURE__ */ defineSchema(() =>
  z.preprocess(
    (value) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value),
    z.number().int().min(1).max(200),
  ),
);

/** Query strings are accepted as strings too ("true", "50"). */
export const ListVaultItemsQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    q: z.string().max(200).optional(),
    type: VaultItemType.optional(),
    includeArchived: QueryBoolean.optional(),
    cursor: z.string().optional(),
    limit: QueryInt.optional(),
  }),
);
export type ListVaultItemsQuery = z.infer<typeof ListVaultItemsQuery>;

export const ListVaultsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ vaults: z.array(VaultSummary) }),
);
export type ListVaultsResponse = z.infer<typeof ListVaultsResponse>;
export const ListVaultItemsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    items: z.array(VaultItemSummary),
    nextCursor: z.string().nullable(),
  }),
);
export type ListVaultItemsResponse = z.infer<typeof ListVaultItemsResponse>;
export const ListVaultFieldVersionsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    versions: z.array(VaultFieldVersionMeta),
  }),
);
export type ListVaultFieldVersionsResponse = z.infer<typeof ListVaultFieldVersionsResponse>;

export const SetSessionVaultPolicyRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ policy: VaultPolicy }).strict(),
);
export type SetSessionVaultPolicyRequest = z.infer<typeof SetSessionVaultPolicyRequest>;

export const SessionSecretsView = /* @__PURE__ */ defineSchema(() =>
  z.object({
    capabilityEnabled: z.boolean(),
    policy: VaultPolicy,
    effectiveVaultIds: z.array(z.string().uuid()),
    /** Nearest ancestor that narrowed, if any. */
    narrowedBySessionId: z.string().uuid().nullable(),
    taskVault: VaultSummary.nullable(),
    taskItems: z.array(VaultItemSummary),
    reachableVaults: z.array(
      VaultSummary.extend({ selected: z.boolean(), selectable: z.boolean() }),
    ),
  }),
);
export type SessionSecretsView = z.infer<typeof SessionSecretsView>;

export const InstallOnePasswordRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      // Real service-account tokens are long; the dev fakes (ops_fake_healthy) are 16 chars.
      token: z.string().trim().min(16).max(4_096),
      ownership: z.enum(["user", "workspace", "organization"]),
      planTier: z.enum(["family", "teams", "business"]).default("teams"),
      label: z.string().max(120).optional(),
    })
    .strict(),
);
export type InstallOnePasswordRequest = z.infer<typeof InstallOnePasswordRequest>;

export const ProviderVaultMeta = /* @__PURE__ */ defineSchema(() =>
  z.object({
    externalVaultId: z.string(),
    name: z.string(),
    itemCount: z.number().int().nullable(),
    linkedVaultId: z.string().uuid().nullable(),
    /** Unknown means the provider does not expose the grant; writes still check upstream. */
    writeAccess: z.enum(["read_only", "read_write", "unknown"]).optional(),
    operations: VaultProviderOperations.optional(),
  }),
);
export type ProviderVaultMeta = z.infer<typeof ProviderVaultMeta>;

export const InstallOnePasswordResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    connectionId: z.string().uuid(),
    accountName: z.string().nullable(),
    vaults: z.array(ProviderVaultMeta),
  }),
);
export type InstallOnePasswordResponse = z.infer<typeof InstallOnePasswordResponse>;

/** A 1Password service account connected in a workspace. Never carries the token. */
export const OnePasswordConnectionSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    /** Who can use the vaults linked through it. */
    ownership: z.enum(["user", "workspace", "organization"]),
    /** Sign-in host from the token, for example "my.1password.com". */
    accountName: z.string().nullable(),
    label: z.string().nullable(),
    planTier: z.enum(["family", "teams", "business"]),
    /** When the current token was last checked against 1Password. */
    verifiedAt: z.string(),
    createdAt: z.string(),
    createdBySubjectId: z.string().nullable(),
    /** The caller can link vaults, replace the token and disconnect it. */
    canManage: z.boolean(),
  }),
);
export type OnePasswordConnectionSummary = z.infer<typeof OnePasswordConnectionSummary>;

export const ListOnePasswordConnectionsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    connections: z.array(OnePasswordConnectionSummary),
  }),
);
export type ListOnePasswordConnectionsResponse = z.infer<typeof ListOnePasswordConnectionsResponse>;

/** A new token for an existing connection; its linked vaults keep working. */
export const ReplaceOnePasswordTokenRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      token: z.string().trim().min(16).max(4_096),
      planTier: z.enum(["family", "teams", "business"]).optional(),
    })
    .strict(),
);
export type ReplaceOnePasswordTokenRequest = z.infer<typeof ReplaceOnePasswordTokenRequest>;

export const DisconnectOnePasswordResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** The Opengeni vaults that were unlinked. Nothing is deleted in 1Password. */
    unlinkedVaultIds: z.array(z.string().uuid()),
  }),
);
export type DisconnectOnePasswordResponse = z.infer<typeof DisconnectOnePasswordResponse>;

/** Providers installed through the generic connection lifecycle. */
export const ExternalVaultProviderKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["external", "protonpass", "keeper", "bitwarden"]),
);
export type ExternalVaultProviderKind = z.infer<typeof ExternalVaultProviderKind>;

/** Write-only setup material. Never included in connection summaries or logs. */
export const VaultProviderCredentials = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("provider", [
    z
      .object({
        provider: z.literal("external"),
        endpoint: z.string().url().max(2_048),
        signingSecret: z.string().min(32).max(4_096),
      })
      .strict(),
    z
      .object({
        provider: z.literal("bitwarden"),
        endpoint: z.string().url().max(2_048),
        signingSecret: z.string().min(32).max(4_096),
      })
      .strict(),
    z
      .object({
        provider: z.literal("protonpass"),
        token: z.string().min(16).max(4_096),
      })
      .strict(),
    z
      .object({
        provider: z.literal("keeper"),
        oneTimeToken: z.string().min(16).max(4_096),
        /** Optional region host for tokens that do not encode one. */
        hostname: z.string().max(253).optional(),
      })
      .strict(),
  ]),
);
export type VaultProviderCredentials = z.infer<typeof VaultProviderCredentials>;

export const InstallVaultProviderRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      credentials: VaultProviderCredentials,
      ownership: z.enum(["user", "workspace", "organization"]),
      label: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
);
export type InstallVaultProviderRequest = z.infer<typeof InstallVaultProviderRequest>;

export const ReplaceVaultProviderCredentialsRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ credentials: VaultProviderCredentials }).strict(),
);
export type ReplaceVaultProviderCredentialsRequest = z.infer<
  typeof ReplaceVaultProviderCredentialsRequest
>;

/** Includes legacy 1Password connections; existing 1Password routes remain supported. */
export const VaultProviderConnectionSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    provider: z.enum(["onepassword", "external", "protonpass", "keeper", "bitwarden"]),
    ownership: z.enum(["user", "workspace", "organization"]),
    accountName: z.string().nullable(),
    label: z.string().nullable(),
    verifiedAt: z.string(),
    createdAt: z.string(),
    createdBySubjectId: z.string().nullable(),
    canManage: z.boolean(),
    operations: VaultProviderOperations,
    /** Only 1Password uses a plan tier. */
    planTier: z.enum(["family", "teams", "business"]).optional(),
    /** Unavailable means this deployment cannot run the adapter, not bad credentials. */
    available: z.boolean(),
    /** Setup material is saved, but provider verification has not completed. */
    verificationStatus: z.enum(["ready", "pending"]).optional(),
  }),
);
export type VaultProviderConnectionSummary = z.infer<typeof VaultProviderConnectionSummary>;

export const ListVaultProviderConnectionsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ connections: z.array(VaultProviderConnectionSummary) }),
);
export type ListVaultProviderConnectionsResponse = z.infer<
  typeof ListVaultProviderConnectionsResponse
>;

export const InstallVaultProviderResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    connectionId: z.string().uuid(),
    accountName: z.string().nullable(),
    provider: ExternalVaultProviderKind,
    operations: VaultProviderOperations,
    vaults: z.array(ProviderVaultMeta),
    /** Retry verification on this connection; never replay a consumed bootstrap token. */
    discoveryPending: z.boolean().optional(),
    errorCode: z.string().max(100).optional(),
  }),
);
export type InstallVaultProviderResponse = z.infer<typeof InstallVaultProviderResponse>;

export const DisconnectVaultProviderResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ unlinkedVaultIds: z.array(z.string().uuid()) }),
);
export type DisconnectVaultProviderResponse = z.infer<typeof DisconnectVaultProviderResponse>;

export const LinkProviderVaultRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      provider: z.enum(["onepassword", "host", "external", "protonpass", "keeper", "bitwarden"]),
      /** Required except for an in-process host provider. */
      connectionId: z.string().uuid().optional(),
      externalVaultId: z.string(),
      ownerKind: z.enum(["user", "workspace", "organization"]),
      mode: VaultMode,
      name: VaultName.optional(),
      availability: VaultAvailability.optional(),
    })
    .strict(),
);
export type LinkProviderVaultRequest = z.infer<typeof LinkProviderVaultRequest>;

export const CreateManagedProviderVaultRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: VaultName,
      ownerKind: z.enum(["user", "workspace", "organization"]),
      groupId: z.string().optional(),
    })
    .strict(),
);
export type CreateManagedProviderVaultRequest = z.infer<typeof CreateManagedProviderVaultRequest>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const VaultErrorCode = /* @__PURE__ */ defineSchema(() =>
  z.enum([
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
    "provider_locked",
    "provider_inventory_incomplete",
    "provider_outcome_unknown",
    "variable_sets_removed",
    "secret_save_forbidden",
    "invalid_secret_name",
    "secret_value_too_large",
    "human_auth_required",
    "secret_search_cursor_invalid",
  ]),
);
export type VaultErrorCode = z.infer<typeof VaultErrorCode>;

export const VaultApiError = /* @__PURE__ */ defineSchema(() =>
  z.object({
    error: VaultErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
);
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
  secret_search_cursor_invalid: 422,
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
  provider_locked: 423,
  provider_inventory_incomplete: 503,
  provider_outcome_unknown: 503,
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

export const SECRET_SAVE_TO = /* @__PURE__ */ defineSchema(() =>
  z.enum(["user", "task", "workspace"]),
);
export type SecretSaveTo = z.infer<typeof SECRET_SAVE_TO>;

export const SecretSearchInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      query: z.string().max(200).optional(),
      website: z.string().max(VAULT_LIMITS.websiteMaxChars).optional(),
      type: VaultItemType.optional(),
      /** Vault name or ID. */
      vault: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(VAULT_LIMITS.searchResultsMax).default(20),
      /** `nextCursor` from the previous call with the same filters. */
      cursor: z.string().max(VAULT_LIMITS.searchCursorMaxChars).optional(),
      /** Refresh provider metadata and subsequent value reads; never bypass rate limits. */
      refresh: z.boolean().optional(),
    })
    .strict(),
);
export type SecretSearchInput = z.infer<typeof SecretSearchInput>;

export const SecretSearchResult = /* @__PURE__ */ defineSchema(() =>
  z.object({
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
  }),
);
export type SecretSearchResult = z.infer<typeof SecretSearchResult>;
export const SecretSearchVault = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    ownerKind: VaultOwnerKind,
    source: VaultSource,
    mode: VaultMode,
    itemCount: z.number().int().nonnegative(),
    freshness: VaultProviderFreshness.optional(),
  }),
);
export type SecretSearchVault = z.infer<typeof SecretSearchVault>;
export const SecretSearchOutput = /* @__PURE__ */ defineSchema(() =>
  z.object({
    items: z.array(SecretSearchResult),
    /** True when more matches remain; pass `nextCursor` to continue. */
    truncated: z.boolean(),
    nextCursor: z.string().nullable(),
    /** Every vault the caller can reach, on the first page only. */
    vaults: z.array(SecretSearchVault).optional(),
    /** False when a reachable provider could not be checked; empty items are not proof of absence. */
    complete: z.boolean().optional(),
    /** Included on every page so failures are not lost after page one. */
    sources: z
      .array(
        z.object({
          vaultId: z.string().uuid(),
          freshness: VaultProviderFreshness,
        }),
      )
      .optional(),
  }),
);
export type SecretSearchOutput = z.infer<typeof SecretSearchOutput>;

export const SecretSaveFieldInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: VaultFieldName,
      kind: VaultFieldKind.optional(),
      value: z.string().optional(),
      generate: GeneratePasswordSpec.optional(),
      fromReference: z.string().max(VAULT_LIMITS.referenceMaxChars).optional(),
      restoreVersion: z.number().int().optional(),
    })
    .strict()
    .refine(exactlyOneValueSource, "exactly one of value|generate|fromReference|restoreVersion"),
);
export type SecretSaveFieldInput = z.infer<typeof SecretSaveFieldInput>;

export const SecretSaveInput = /* @__PURE__ */ defineSchema(() =>
  z
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
    .strict(),
);
export type SecretSaveInput = z.infer<typeof SecretSaveInput>;
export const SecretSaveOutput = /* @__PURE__ */ defineSchema(() =>
  z.object({
    item: VaultItemSummary,
    references: VaultItemReferences,
    generatedFields: z.array(z.string()),
  }),
);
export type SecretSaveOutput = z.infer<typeof SecretSaveOutput>;

export const SecretGetInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      reference: z.string().min(1).max(VAULT_LIMITS.referenceMaxChars),
      version: z.number().int().optional(),
    })
    .strict(),
);
export type SecretGetInput = z.infer<typeof SecretGetInput>;
export const SecretGetOutput = RevealVaultFieldResponse;
export type SecretGetOutput = RevealVaultFieldResponse;

export const SecretMoveInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      reference: z.string().min(1).max(VAULT_LIMITS.referenceMaxChars),
      /** Vault name or ID. */
      toVault: z.string().min(1).max(200),
      mode: z.enum(["move", "copy"]).default("move"),
      newName: VaultName.optional(),
    })
    .strict(),
);
export type SecretMoveInput = z.infer<typeof SecretMoveInput>;
export const SecretMoveOutput = /* @__PURE__ */ defineSchema(() =>
  z.object({
    item: VaultItemSummary,
    references: VaultItemReferences,
  }),
);
export type SecretMoveOutput = z.infer<typeof SecretMoveOutput>;

export const SecretDeleteInput = /* @__PURE__ */ defineSchema(() =>
  z.object({ reference: z.string().min(1).max(VAULT_LIMITS.referenceMaxChars) }).strict(),
);
export type SecretDeleteInput = z.infer<typeof SecretDeleteInput>;
export const SecretDeleteOutput = /* @__PURE__ */ defineSchema(() =>
  z.object({ archived: z.literal(true), restoreHint: z.string() }),
);
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
export const VaultAuditAction = /* @__PURE__ */ defineSchema(() => z.enum(VAULT_AUDIT_ACTIONS));
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
