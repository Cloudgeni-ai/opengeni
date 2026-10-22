/**
 * Vault storage (migration 0739). Every vault table is reachable only through
 * the SECURITY DEFINER routines of that migration; each function here calls
 * exactly one of them inside `withRlsContext` (plus the subject GUC for
 * people). Values stay encrypted at this layer: callers encrypt before writes
 * and decrypt after reads with `environment-crypto`.
 */
import { sql } from "drizzle-orm";
import {
  VaultErrorCode,
  type SecretPrincipal,
  type VaultFieldKind,
  type VaultItemType,
  type VaultMode,
  type VaultOwnerKind,
  type VaultPolicy,
  type VaultProviderOperations,
  type VaultSource,
  type VaultSyncStatus,
  type VaultVersionCreatedByKind,
} from "@opengeni/contracts";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";

export type VaultDbContext =
  | { kind: "subject"; accountId: string; workspaceId: string; subjectId: string }
  | { kind: "principal"; principal: SecretPrincipal };

/** A vault routine refused the call; `code` is the API error code. */
export class VaultError extends Error {
  override readonly name = "VaultError";
  constructor(
    readonly code: VaultErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function isVaultError(error: unknown): error is VaultError {
  return error instanceof VaultError;
}

const VAULT_ERROR_HINT = "opengeni.vault_error";

/** Map a database error raised by a vault routine to VaultError; null otherwise. */
export function vaultErrorFromDatabase(error: unknown): VaultError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { hint?: unknown; message?: unknown; detail?: unknown };
    if (candidate.hint === VAULT_ERROR_HINT && typeof candidate.message === "string") {
      const separator = candidate.message.indexOf(": ");
      const parsedCode = VaultErrorCode.safeParse(
        separator > 0 ? candidate.message.slice(0, separator) : candidate.message,
      );
      let details: Record<string, unknown> | undefined;
      if (typeof candidate.detail === "string" && candidate.detail.length > 0) {
        try {
          const parsed: unknown = JSON.parse(candidate.detail);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            details = parsed as Record<string, unknown>;
          }
        } catch {
          details = undefined;
        }
      }
      return new VaultError(
        parsedCode.success ? parsedCode.data : "vault_permission_denied",
        separator > 0 ? candidate.message.slice(separator + 2) : candidate.message,
        details && Object.keys(details).length > 0 ? details : undefined,
      );
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function contextScope(context: VaultDbContext): {
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  principal: string | null;
} {
  if (context.kind === "subject") {
    return {
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      subjectId: context.subjectId,
      principal: null,
    };
  }
  const principal = context.principal;
  return {
    accountId: principal.accountId,
    workspaceId: principal.workspaceId,
    subjectId: principal.kind === "attempt" ? null : principal.subjectId,
    principal: JSON.stringify(principal),
  };
}

async function inVaultContext<T>(
  db: Database,
  context: VaultDbContext,
  fn: (scoped: Database, principal: string | null) => Promise<T>,
): Promise<T> {
  const scope = contextScope(context);
  try {
    return await withRlsContext(
      db,
      { accountId: scope.accountId, workspaceId: scope.workspaceId },
      async (scoped) => {
        if (scope.subjectId) await setSubjectRlsContext(scoped, scope.subjectId);
        return await fn(scoped, scope.principal);
      },
    );
  } catch (error) {
    throw vaultErrorFromDatabase(error) ?? error;
  }
}

async function one<T>(scoped: Database, query: ReturnType<typeof sql>): Promise<T> {
  const rows = await rawRows<{ value: T }>(scoped, query);
  if (rows.length !== 1) throw new Error("vault routine returned no row");
  return rows[0]!.value;
}

async function many<T>(scoped: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  const rows = await rawRows<{ value: T }>(scoped, query);
  return rows.map((row) => row.value);
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Row shapes (as the routines return them; values encrypted)
// ---------------------------------------------------------------------------

/**
 * What a provider (or its bridge) said about its own upstream freshness at
 * the last successful check (0789). Opengeni's own check time is
 * `lastSyncedAt`; it never stands in for `sourceSyncedAt`.
 */
export type StoredProviderFreshness = {
  source: "live" | "cache" | "unknown";
  sourceSyncedAt: string | null;
};

export type VaultRow = {
  id: string;
  workspaceId: string;
  ownerKind: VaultOwnerKind;
  ownerLabel: string | null;
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
  providerVaultRef: string | null;
  /** Effective operations the provider last reported (0789); null before the first check. */
  providerOperations?: VaultProviderOperations | null;
  /** The provider's own freshness observation from the last successful check (0789). */
  providerFreshness?: StoredProviderFreshness | null;
  /**
   * Durable value-cache epoch (0789, bigint as text). Every complete mirror
   * replacement advances it; provider value caches compare it before reuse.
   */
  providerCacheEpoch?: string;
  availability: { allowedWorkspaceIds: string[] | null; allowPersonalWorkspaces: boolean } | null;
  isDefault: boolean;
  itemCount: number;
  /** A user vault owned by the caller's membership. */
  ownedByCaller: boolean;
  generation: number;
  createdBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Lookup tier: 0 task, 1 Only me, 2 workspace, 3 organization. */
  tier: number;
};

export type VaultFieldRow = {
  id: string;
  name: string;
  kind: VaultFieldKind;
  position: number;
  currentVersion: number | null;
  providerFieldRef: string | null;
  fileName: string | null;
  fileSize: number | null;
  updatedAt: string;
  /** Current ciphertext for text fields only (all text fields on item reads; username/rpId/credentialId on lists). */
  valueEncrypted: string | null;
};

export type VaultItemRow = {
  id: string;
  vaultId: string;
  vaultName: string;
  vaultOwnerKind: VaultOwnerKind;
  vaultSource: VaultSource;
  vaultMode: VaultMode;
  type: VaultItemType;
  name: string;
  nameKey: string;
  websites: string[];
  expiresAt: string | null;
  archivedAt: string | null;
  lastUsedAt: string | null;
  updatedAt: string;
  createdAt: string;
  createdBySubjectId: string | null;
  generation: number;
  primaryFieldId: string | null;
  passkeySignCount: number | null;
  passkeyLeasedUntil: string | null;
  aliases: string[];
  fields: VaultFieldRow[];
};

export type VaultFieldCiphertext = {
  valueEncrypted: string | null;
  version: number | null;
  currentVersion: number | null;
  kind: VaultFieldKind;
  fieldId: string;
  fieldName: string;
  fileName: string | null;
  itemId: string;
  itemName: string;
  itemType: VaultItemType;
  vaultId: string;
  vaultName: string;
  vaultOwnerKind: VaultOwnerKind;
  source: VaultSource;
  providerConnectionId: string | null;
  providerVaultRef: string | null;
  /** The vault's value-cache epoch (0789). */
  providerCacheEpoch?: string;
  providerItemRef: string | null;
  providerFieldRef: string | null;
};

export type VaultFieldVersionRow = {
  version: number;
  current: boolean;
  createdAt: string;
  createdByKind: VaultVersionCreatedByKind;
  createdBySubjectId: string | null;
};

/** A parsed reference target as the lookup routine takes it. */
export type SecretReferenceLookup = {
  index: number;
  form: "path" | "id";
  segments?: string[];
  itemId?: string;
  field?: string | null;
  otp: boolean;
  previous: boolean;
};

export type SecretReferenceCandidateInterpretation =
  | "item"
  | "item_field"
  | "vault_item"
  | "vault_item_field"
  | "id";

export type SecretReferenceCandidate = {
  refIndex: number;
  interpretation: SecretReferenceCandidateInterpretation;
  tier: number;
  matchedBy: "name" | "alias" | "id";
  vaultId: string;
  vaultName: string;
  vaultOwnerKind: VaultOwnerKind;
  source: VaultSource;
  providerConnectionId: string | null;
  providerVaultRef: string | null;
  /** The vault's value-cache epoch (0789). */
  providerCacheEpoch?: string;
  itemId: string;
  itemName: string;
  itemType: VaultItemType;
  archived: boolean;
  providerItemRef: string | null;
  fieldId: string | null;
  fieldName: string | null;
  fieldKind: VaultFieldKind | null;
  fileName: string | null;
  providerFieldRef: string | null;
  currentVersion: number | null;
  version: number | null;
  valueEncrypted: string | null;
  /** Why no value: the named field, the TOTP field, the primary field, the previous version or the value is absent. */
  missing: "field" | "totp_field" | "primary_field" | "previous_version" | "value" | null;
};

export type SecretResolutionMeta = {
  kind: SecretPrincipal["kind"] | "subject";
  subjectId: string | null;
  humanExpected: boolean;
  humanValid: boolean;
  hasSecretsUse: boolean;
  agentAllowed: boolean;
  includeUser: boolean;
  includeShared: boolean;
  policyVaultIds: string[] | null;
  reachableVaultCount: number;
};

export type SessionSecretsViewRow = {
  policy: VaultPolicy;
  effectiveVaultIds: string[];
  narrowedBySessionId: string | null;
  taskVault: VaultRow | null;
  taskItems: VaultItemRow[];
  reachableVaults: Array<VaultRow & { selected: boolean; selectable: boolean }>;
};

export type VaultFieldWrite = {
  fieldId?: string;
  name: string;
  newName?: string;
  kind?: VaultFieldKind;
  valueEncrypted?: string;
  /** Plaintext size in bytes, checked against the text and file limits. */
  valueSize?: number;
  restoreVersion?: number;
  remove?: true;
  fileName?: string;
};

export type VaultItemWrite = {
  name?: string;
  type?: VaultItemType;
  websites?: string[];
  expiresAt?: string | null;
  primaryFieldName?: string;
  expectedGeneration?: number;
  createdByKind?: VaultVersionCreatedByKind;
  passkeySignCount?: number;
  fields?: VaultFieldWrite[];
};

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

export async function listVaultsForSubject(
  db: Database,
  context: VaultDbContext,
  input: { workspaceId: string },
): Promise<VaultRow[]> {
  return await inVaultContext(db, context, (scoped, principal) =>
    many<VaultRow>(
      scoped,
      sql`select value from list_vaults_for_subject(${input.workspaceId}::uuid, ${principal}::jsonb) value`,
    ),
  );
}

export async function getVault(
  db: Database,
  context: VaultDbContext,
  input: { vaultId: string },
): Promise<VaultRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultRow>(
      scoped,
      sql`select get_vault_for_subject(${input.vaultId}::uuid, ${principal}::jsonb) as value`,
    ),
  );
}

export async function createVault(
  db: Database,
  context: VaultDbContext,
  input: {
    name: string;
    description?: string | null;
    ownerKind: "user" | "workspace" | "organization";
    availability?: { allowedWorkspaceIds: string[] | null; allowPersonalWorkspaces: boolean };
    /** The caller holds account:admin. */
    allowOrganization?: boolean;
  },
): Promise<VaultRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultRow>(
      scoped,
      sql`select create_vault(${json(input)}::jsonb, ${principal}::jsonb) as value`,
    ),
  );
}

export async function updateVault(
  db: Database,
  context: VaultDbContext,
  input: {
    vaultId: string;
    expectedGeneration: number;
    name?: string;
    description?: string | null;
    availability?: { allowedWorkspaceIds: string[] | null; allowPersonalWorkspaces: boolean };
    allowOrganization?: boolean;
  },
): Promise<VaultRow> {
  const { vaultId, expectedGeneration, ...changes } = input;
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultRow>(
      scoped,
      sql`select update_vault(${vaultId}::uuid, ${expectedGeneration}::bigint,
        ${JSON.stringify(changes)}::jsonb, ${principal}::jsonb) as value`,
    ),
  );
}

export async function deleteVault(
  db: Database,
  context: VaultDbContext,
  input: { vaultId: string; confirmName: string; allowOrganization?: boolean },
): Promise<void> {
  await inVaultContext(db, context, async (scoped, principal) => {
    await scoped.execute(
      sql`select delete_vault(${input.vaultId}::uuid, ${input.confirmName},
        ${input.allowOrganization === true}, ${principal}::jsonb)`,
    );
  });
}

export async function ensureDefaultVault(
  db: Database,
  context: VaultDbContext,
  input: { workspaceId: string; ownerKind: "user" | "workspace" },
): Promise<VaultRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultRow>(
      scoped,
      sql`select ensure_default_vault(${input.workspaceId}::uuid, ${input.ownerKind},
        ${principal}::jsonb) as value`,
    ),
  );
}

export async function ensureTaskVault(
  db: Database,
  context: VaultDbContext,
  input: { workspaceId: string; sessionId: string },
): Promise<VaultRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultRow>(
      scoped,
      sql`select ensure_task_vault(${input.workspaceId}::uuid, ${input.sessionId}::uuid,
        ${principal}::jsonb) as value`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function vaultItemCursor(item: Pick<VaultItemRow, "nameKey" | "id">): string {
  return `${item.nameKey}|${item.id}`;
}

export async function listVaultItems(
  db: Database,
  context: VaultDbContext,
  input: {
    vaultId: string;
    q?: string;
    type?: VaultItemType;
    includeArchived?: boolean;
    cursor?: string;
    limit?: number;
  },
): Promise<{ items: VaultItemRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await inVaultContext(db, context, (scoped, principal) =>
    many<VaultItemRow>(
      scoped,
      sql`select value from list_vault_items(${input.vaultId}::uuid, ${input.q ?? null},
        ${input.type ?? null}, ${input.includeArchived === true}, ${input.cursor ?? null},
        ${limit}::integer, ${principal}::jsonb) value`,
    ),
  );
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit && items.length > 0 ? vaultItemCursor(items.at(-1)!) : null,
  };
}

export async function getVaultItem(
  db: Database,
  context: VaultDbContext,
  input: { itemId: string },
): Promise<VaultItemRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultItemRow>(
      scoped,
      sql`select get_vault_item(${input.itemId}::uuid, ${principal}::jsonb) as value`,
    ),
  );
}

/**
 * Create (`vaultId`), upsert by name (`vaultId` + `mode: "upsert"`) or update
 * (`itemId`) one hosted item in one transaction.
 */
export async function upsertVaultItem(
  db: Database,
  context: VaultDbContext,
  input: VaultItemWrite & ({ itemId: string } | { vaultId: string; mode?: "create" | "upsert" }),
): Promise<VaultItemRow & { created: boolean }> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultItemRow & { created: boolean }>(
      scoped,
      sql`select upsert_vault_item(${JSON.stringify(input)}::jsonb, ${principal}::jsonb) as value`,
    ),
  );
}

export async function archiveVaultItem(
  db: Database,
  context: VaultDbContext,
  input: { itemId: string },
): Promise<VaultItemRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultItemRow>(
      scoped,
      sql`select archive_vault_item(${input.itemId}::uuid, ${principal}::jsonb) as value`,
    ),
  );
}

export async function restoreVaultItem(
  db: Database,
  context: VaultDbContext,
  input: { itemId: string },
): Promise<VaultItemRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultItemRow>(
      scoped,
      sql`select restore_vault_item(${input.itemId}::uuid, ${principal}::jsonb) as value`,
    ),
  );
}

export async function deleteVaultItemPermanently(
  db: Database,
  context: VaultDbContext,
  input: { itemId: string },
): Promise<void> {
  await inVaultContext(db, context, async (scoped, principal) => {
    await scoped.execute(
      sql`select delete_vault_item_permanently(${input.itemId}::uuid, ${principal}::jsonb)`,
    );
  });
}

export async function moveVaultItem(
  db: Database,
  context: VaultDbContext,
  input: { itemId: string; targetVaultId: string; mode: "move" | "copy"; newName?: string },
): Promise<VaultItemRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultItemRow>(
      scoped,
      sql`select move_vault_item(${input.itemId}::uuid, ${input.targetVaultId}::uuid, ${input.mode},
        ${input.newName ?? null}, ${principal}::jsonb) as value`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * One field value with its audit row in the same statement. Purposes:
 * `reveal` (human reveal, `vault.field.revealed`), `agent_read` (`secret_get`,
 * `vault.secret.read`) and `internal` (service-side copies; not audited).
 */
export async function readVaultFieldCiphertext(
  db: Database,
  context: VaultDbContext,
  input: {
    fieldId: string;
    version?: number;
    purpose: "reveal" | "agent_read" | "internal";
    metadata?: Record<string, unknown>;
  },
): Promise<VaultFieldCiphertext> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultFieldCiphertext>(
      scoped,
      sql`select read_vault_field_ciphertext(${input.fieldId}::uuid, ${input.version ?? null}::integer,
        ${input.purpose}, ${principal}::jsonb, ${json(input.metadata)}::jsonb) as value`,
    ),
  );
}

export async function listVaultFieldVersions(
  db: Database,
  context: VaultDbContext,
  input: { fieldId: string },
): Promise<VaultFieldVersionRow[]> {
  return await inVaultContext(db, context, (scoped, principal) =>
    many<VaultFieldVersionRow>(
      scoped,
      sql`select value from list_vault_field_versions(${input.fieldId}::uuid, ${principal}::jsonb) value`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** One roundtrip: principal facts plus every candidate for every reference. */
export async function resolveSecretReferenceCandidates(
  db: Database,
  context: VaultDbContext,
  input: { refs: SecretReferenceLookup[] },
): Promise<{ meta: SecretResolutionMeta; candidates: SecretReferenceCandidate[] }> {
  const principalJson =
    context.kind === "principal"
      ? JSON.stringify(context.principal)
      : JSON.stringify({
          kind: "human",
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          subjectId: context.subjectId,
          verifiedHuman: true,
          viaApiKey: false,
        });
  const rows = await inVaultContext(db, context, (scoped) =>
    many<Record<string, unknown>>(
      scoped,
      sql`select value from resolve_secret_reference_candidates(${principalJson}::jsonb,
        ${JSON.stringify(input.refs)}::jsonb) value`,
    ),
  );
  const [meta, ...candidates] = rows;
  if (!meta || meta.meta !== true) throw new Error("secret resolution returned no principal row");
  const { meta: _marker, ...facts } = meta;
  return {
    meta: facts as unknown as SecretResolutionMeta,
    candidates: candidates as unknown as SecretReferenceCandidate[],
  };
}

export async function recordVaultSecretUse(
  db: Database,
  context: VaultDbContext,
  input: {
    use: {
      surface: string;
      toolName: string;
      operationId?: string;
      sourceCallId?: string;
    };
    items: Array<{
      itemId: string;
      vaultId: string;
      fieldId: string | null;
      fieldName: string | null;
      reference: string;
    }>;
  },
): Promise<void> {
  const principalJson = context.kind === "principal" ? JSON.stringify(context.principal) : null;
  await inVaultContext(db, context, async (scoped) => {
    await scoped.execute(
      sql`select record_vault_secret_use(${principalJson}::jsonb, ${JSON.stringify(input.use)}::jsonb,
        ${JSON.stringify(input.items)}::jsonb)`,
    );
  });
}

// ---------------------------------------------------------------------------
// Session policy
// ---------------------------------------------------------------------------

export async function setSessionVaultPolicy(
  db: Database,
  context: VaultDbContext,
  input: { sessionId: string; policy: VaultPolicy },
): Promise<SessionSecretsViewRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<SessionSecretsViewRow>(
      scoped,
      sql`select set_session_vault_policy(${input.sessionId}::uuid, ${JSON.stringify(input.policy)}::jsonb,
        ${principal}::jsonb) as value`,
    ),
  );
}

export async function getSessionSecretsView(
  db: Database,
  context: VaultDbContext,
  input: { sessionId: string },
): Promise<SessionSecretsViewRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<SessionSecretsViewRow>(
      scoped,
      sql`select session_secrets_view(${input.sessionId}::uuid, ${principal}::jsonb) as value`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------

export async function updatePasskeySignCount(
  db: Database,
  context: VaultDbContext,
  input: { itemId: string; count: number },
): Promise<void> {
  await inVaultContext(db, context, async (scoped, principal) => {
    await scoped.execute(
      sql`select update_passkey_sign_count(${input.itemId}::uuid, ${input.count}::bigint, ${principal}::jsonb)`,
    );
  });
}

export async function leaseVaultPasskeys(
  db: Database,
  context: VaultDbContext,
  input: { holder: string; ttlSeconds: number },
): Promise<string[]> {
  const principalJson = context.kind === "principal" ? JSON.stringify(context.principal) : null;
  return await inVaultContext(db, context, (scoped) =>
    many<string>(
      scoped,
      sql`select value::text as value from lease_vault_passkeys(${principalJson}::jsonb, ${input.holder},
        ${input.ttlSeconds}::integer) value`,
    ),
  );
}

export async function releaseVaultPasskeyLeases(
  db: Database,
  context: VaultDbContext,
  input: { holder: string },
): Promise<void> {
  await inVaultContext(db, context, async (scoped, principal) => {
    await scoped.execute(
      sql`select release_vault_passkey_leases(${input.holder}, ${principal}::jsonb)`,
    );
  });
}

// ---------------------------------------------------------------------------
// Provider mirror
// ---------------------------------------------------------------------------

export type ProviderVaultItemMirror = {
  providerItemRef: string;
  providerVersion?: string | null;
  type: Exclude<VaultItemType, "passkey">;
  name: string;
  websites?: string[];
  primaryFieldRef?: string | null;
  fields: Array<{ providerFieldRef: string; name: string; kind: VaultFieldKind }>;
};

/**
 * Replace a connected vault's metadata mirror with one complete inventory
 * (at most `VAULT_LIMITS.itemsPerVault` items; more is refused with
 * `provider_inventory_incomplete` and the old mirror kept). Items missing
 * from `items` are removed, and the vault's cache epoch advances (0789).
 */
export async function upsertProviderVaultItems(
  db: Database,
  context: VaultDbContext,
  input: { vaultId: string; contentVersion: string | null; items: ProviderVaultItemMirror[] },
): Promise<void> {
  await inVaultContext(db, context, async (scoped, principal) => {
    await scoped.execute(
      sql`select upsert_provider_vault_items(${input.vaultId}::uuid, ${input.contentVersion},
        ${JSON.stringify(input.items)}::jsonb, ${principal}::jsonb)`,
    );
  });
}

/**
 * Record a connected vault's sync state. `operations` and `freshness` are
 * optional (0789): absent keeps the stored value, null clears it. The optional
 * mirror and status settle atomically, comparing `expectedCacheEpoch` under
 * the vault lock; a mismatch raises provider_conflict with superseded=true.
 * Every applied settlement advances the epoch, even unchanged or failed checks.
 */
export async function setVaultSyncStatus(
  db: Database,
  context: VaultDbContext,
  input: {
    vaultId: string;
    status: VaultSyncStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    rateLimitedUntil?: string | null;
    /** The provider's effective operations for this vault. */
    operations?: VaultProviderOperations | null;
    /** The provider's own upstream freshness observation (never Opengeni's check time). */
    freshness?: StoredProviderFreshness | null;
    /** Reject a late refresh when another settlement advanced this epoch. */
    expectedCacheEpoch?: string;
    /** Complete inventory committed atomically with this successful status. */
    mirror?: { contentVersion: string | null; items: ProviderVaultItemMirror[] };
  },
): Promise<void> {
  const { vaultId, ...status } = input;
  await inVaultContext(db, context, async (scoped, principal) => {
    await scoped.execute(
      sql`select set_vault_sync_status(${vaultId}::uuid, ${JSON.stringify(status)}::jsonb, ${principal}::jsonb)`,
    );
  });
}

/**
 * Link a connected vault (W5, 0789). Every source but `host` needs an active
 * `api_key` connection in the caller's workspace whose provider identity
 * matches (`1password.com` with the 1Password service-account role, or
 * `vault:<source>` with the `external_vault_provider` role and
 * `metadata.vaultProvider.provider = source`, version 1, not pending
 * verification) and whose ownership matches `ownerKind`: a personal
 * connection backs only its owner's Only-me vaults. The mirror is filled by
 * the first sync.
 */
export async function linkProviderVault(
  db: Database,
  context: VaultDbContext,
  input: {
    ownerKind: "user" | "workspace" | "organization";
    name: string;
    description?: string | null;
    source: Exclude<VaultSource, "opengeni">;
    providerConnectionId?: string | null;
    providerVaultRef: string;
    mode: VaultMode;
    availability?: { allowedWorkspaceIds: string[] | null; allowPersonalWorkspaces: boolean };
    /** The caller holds account:admin. */
    allowOrganization?: boolean;
  },
): Promise<VaultRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<VaultRow>(
      scoped,
      sql`select link_provider_vault(${json(input)}::jsonb, ${principal}::jsonb) as value`,
    ),
  );
}

/**
 * Exercise the exact link policy before an irreversible provider create. The
 * temporary link, personal authority and audit rows are all rolled back. This
 * is a preflight, not a reservation: a race after it must return the confirmed
 * upstream identity so the caller can link that vault instead of creating again.
 * No database transaction is held open across provider I/O.
 */
export async function preflightProviderVaultLink(
  db: Database,
  context: VaultDbContext,
  input: Omit<Parameters<typeof linkProviderVault>[2], "providerVaultRef">,
): Promise<void> {
  const passed = new Error("vault link preflight passed");
  try {
    await db.transaction(async (tx) => {
      await linkProviderVault(tx as unknown as Database, context, {
        ...input,
        providerVaultRef: `preflight:${crypto.randomUUID()}`,
      });
      throw passed;
    });
  } catch (error) {
    if (error !== passed) throw error;
  }
}

export type ProviderVaultSyncTargetRow = {
  vaultId: string;
  workspaceId: string;
  source: Exclude<VaultSource, "opengeni">;
  mode: VaultMode;
  providerConnectionId: string | null;
  providerVaultRef: string;
  providerContentVersion: string | null;
  rateLimitedUntil: string | null;
  /** The vault's value-cache epoch (0789). */
  providerCacheEpoch?: string;
};

/** The provider refs and mirror version of one reachable connected vault. */
export async function getProviderVaultSyncTarget(
  db: Database,
  context: VaultDbContext,
  vaultId: string,
): Promise<ProviderVaultSyncTargetRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<ProviderVaultSyncTargetRow>(
      scoped,
      sql`select provider_vault_sync_target(${vaultId}::uuid, ${principal}::jsonb) as value`,
    ),
  );
}

export type ProviderVaultItemRefRow = {
  itemId: string;
  providerItemRef: string;
  providerVersion: string | null;
  generation: number;
};

/** A mirrored item's provider refs, looked up by item id or by provider item ref. */
export async function getProviderVaultItemRef(
  db: Database,
  context: VaultDbContext,
  input: { vaultId: string; itemId?: string; providerItemRef?: string },
): Promise<ProviderVaultItemRefRow> {
  return await inVaultContext(db, context, (scoped, principal) =>
    one<ProviderVaultItemRefRow>(
      scoped,
      sql`select provider_vault_item_ref(${input.vaultId}::uuid, ${input.itemId ?? null}::uuid,
        ${input.providerItemRef ?? null}, ${principal}::jsonb) as value`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Ask-card answers
// ---------------------------------------------------------------------------

export type SecretAnswerWrite = {
  questionId: string;
  saveTo?: "user" | "task" | "workspace";
  vaultId?: string;
  item: VaultItemWrite & { name: string };
};

/**
 * Write secret ask-card answers inside the caller's transaction (the
 * human-input accept transaction). `tx` may already be a transaction; the
 * vault scope is applied in a savepoint and the parent scope restored.
 */
export async function applySecretAnswersInTransaction(
  tx: Database,
  context: VaultDbContext,
  input: { sessionId: string; turnId: string; answers: SecretAnswerWrite[] },
): Promise<Array<{ questionId: string; created: boolean; item: VaultItemRow }>> {
  return await inVaultContext(tx, context, (scoped, principal) =>
    one<Array<{ questionId: string; created: boolean; item: VaultItemRow }>>(
      scoped,
      sql`select apply_secret_answers(${input.sessionId}::uuid, ${input.turnId}::uuid,
        ${JSON.stringify(input.answers)}::jsonb, ${principal}::jsonb) as value`,
    ),
  );
}
