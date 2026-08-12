import {
  WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
  XaiProviderAccountAuthoritySnapshotV1,
  type XaiProviderAccountAuthoritySnapshotV1 as XaiAuthoritySnapshot,
} from "@opengeni/contracts";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withWorkspaceSubjectRls } from "./database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import * as schema from "./schema";

export type XaiAccountAuthorityScope = "workspace" | "user";
export type XaiCredentialStatus = "active" | "needs_relogin" | "error" | "disabled";

export type XaiCredentialSecretV1 = {
  version: 1;
  accessToken?: string;
  refreshToken?: string;
  sessionToken?: string;
  cookie?: string;
};

export type XaiSubscriptionAccountMetadata = {
  id: string;
  scope: XaiAccountAuthorityScope;
  providerAccountId: string | null;
  label: string | null;
  accountEmail: string | null;
  planType: string | null;
  status: XaiCredentialStatus;
  allocatorEnabled: boolean;
  version: number;
  allocatorVersion: number;
  allocatorUpdatedAt: Date | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  lastError: string | null;
  quotaUsedPercent: number | null;
  quotaResetAt: Date | null;
  quotaCheckedAt: Date | null;
  exhaustedUntil: Date | null;
  selectionCount: number;
  lastSelectedAt: Date | null;
  connectedBySubjectId: string | null;
};

export type XaiCredentialForRun = XaiSubscriptionAccountMetadata & {
  secret: XaiCredentialSecretV1;
  authoritySnapshot: XaiAuthoritySnapshot;
};

export type XaiCredentialLeaseResult = {
  credentialId: string | null;
  reused: boolean;
  holderId: string | null;
  generation: number | null;
  leasedUntil: Date | null;
  accounts: XaiSubscriptionAccountMetadata[];
};

export const XAI_CREDENTIAL_LEASE_TTL_MS = 5 * 60_000;

type XaiCredentialMetadataRow = Pick<
  typeof schema.xaiSubscriptionCredentials.$inferSelect,
  | "id"
  | "authorityScope"
  | "providerAccountId"
  | "label"
  | "accountEmail"
  | "planType"
  | "status"
  | "allocatorEnabled"
  | "version"
  | "allocatorVersion"
  | "allocatorUpdatedAt"
  | "expiresAt"
  | "lastRefreshAt"
  | "lastError"
  | "quotaUsedPercent"
  | "quotaResetAt"
  | "quotaCheckedAt"
  | "exhaustedUntil"
  | "selectionCount"
  | "lastSelectedAt"
  | "connectedBySubjectId"
>;

const xaiCredentialMetadataColumns = {
  id: schema.xaiSubscriptionCredentials.id,
  authorityScope: schema.xaiSubscriptionCredentials.authorityScope,
  providerAccountId: schema.xaiSubscriptionCredentials.providerAccountId,
  label: schema.xaiSubscriptionCredentials.label,
  accountEmail: schema.xaiSubscriptionCredentials.accountEmail,
  planType: schema.xaiSubscriptionCredentials.planType,
  status: schema.xaiSubscriptionCredentials.status,
  allocatorEnabled: schema.xaiSubscriptionCredentials.allocatorEnabled,
  version: schema.xaiSubscriptionCredentials.version,
  allocatorVersion: schema.xaiSubscriptionCredentials.allocatorVersion,
  allocatorUpdatedAt: schema.xaiSubscriptionCredentials.allocatorUpdatedAt,
  expiresAt: schema.xaiSubscriptionCredentials.expiresAt,
  lastRefreshAt: schema.xaiSubscriptionCredentials.lastRefreshAt,
  lastError: schema.xaiSubscriptionCredentials.lastError,
  quotaUsedPercent: schema.xaiSubscriptionCredentials.quotaUsedPercent,
  quotaResetAt: schema.xaiSubscriptionCredentials.quotaResetAt,
  quotaCheckedAt: schema.xaiSubscriptionCredentials.quotaCheckedAt,
  exhaustedUntil: schema.xaiSubscriptionCredentials.exhaustedUntil,
  selectionCount: schema.xaiSubscriptionCredentials.selectionCount,
  lastSelectedAt: schema.xaiSubscriptionCredentials.lastSelectedAt,
  connectedBySubjectId: schema.xaiSubscriptionCredentials.connectedBySubjectId,
} as const;

const xaiCredentialAllocationColumns = {
  ...xaiCredentialMetadataColumns,
  accountId: schema.xaiSubscriptionCredentials.accountId,
  workspaceId: schema.xaiSubscriptionCredentials.workspaceId,
  ownerOrganizationMembershipId: schema.xaiSubscriptionCredentials.ownerOrganizationMembershipId,
  createdAt: schema.xaiSubscriptionCredentials.createdAt,
} as const;

function assertSecret(secret: XaiCredentialSecretV1): void {
  if (secret.version !== 1) throw new Error("Unsupported xAI credential secret version");
  const values = [secret.accessToken, secret.refreshToken, secret.sessionToken, secret.cookie];
  if (!values.some((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("An xAI credential must contain at least one secret value");
  }
}

function parseSecret(value: string): XaiCredentialSecretV1 {
  const parsed = JSON.parse(value) as Partial<XaiCredentialSecretV1>;
  const secret: XaiCredentialSecretV1 = {
    version: 1,
    ...(typeof parsed.accessToken === "string" ? { accessToken: parsed.accessToken } : {}),
    ...(typeof parsed.refreshToken === "string" ? { refreshToken: parsed.refreshToken } : {}),
    ...(typeof parsed.sessionToken === "string" ? { sessionToken: parsed.sessionToken } : {}),
    ...(typeof parsed.cookie === "string" ? { cookie: parsed.cookie } : {}),
  };
  assertSecret(secret);
  return secret;
}

function metadataFromRow(row: XaiCredentialMetadataRow): XaiSubscriptionAccountMetadata {
  return {
    id: row.id,
    scope: row.authorityScope as XaiAccountAuthorityScope,
    providerAccountId: row.providerAccountId,
    label: row.label,
    accountEmail: row.accountEmail,
    planType: row.planType,
    status: row.status as XaiCredentialStatus,
    allocatorEnabled: row.allocatorEnabled,
    version: row.version,
    allocatorVersion: row.allocatorVersion,
    allocatorUpdatedAt: row.allocatorUpdatedAt,
    expiresAt: row.expiresAt,
    lastRefreshAt: row.lastRefreshAt,
    lastError: row.lastError,
    quotaUsedPercent: row.quotaUsedPercent,
    quotaResetAt: row.quotaResetAt,
    quotaCheckedAt: row.quotaCheckedAt,
    exhaustedUntil: row.exhaustedUntil,
    selectionCount: row.selectionCount,
    lastSelectedAt: row.lastSelectedAt,
    connectedBySubjectId: row.connectedBySubjectId,
  };
}

async function resolveXaiPoolOwnerMembershipId(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
  },
): Promise<string | null> {
  if (input.authoritySnapshot.scope === "workspace") return null;
  const rows = await rawRows<{ membership_id: string }>(
    db,
    sql`select organization_membership_id as membership_id
      from resolve_xai_authority_pool(
        current_setting('opengeni.account_id')::uuid,
        ${input.workspaceId}::uuid,
        ${input.subjectId},
        ${JSON.stringify(input.authoritySnapshot)}::jsonb
      )`,
  );
  const ownerMembershipId = rows[0]?.membership_id ?? null;
  if (!ownerMembershipId) {
    throw new Error("xAI user authority pool is no longer active");
  }
  return ownerMembershipId;
}

async function assertXaiTurnAuthoritySnapshot(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    turnId: string;
    sessionId?: string;
    executionGeneration?: number;
    authoritySnapshot: XaiAuthoritySnapshot;
  },
): Promise<void> {
  const rows = await rawRows<{ id: string }>(
    db,
    sql`select id
      from session_turns
      where account_id = ${input.accountId}::uuid
        and workspace_id = ${input.workspaceId}::uuid
        and id = ${input.turnId}::uuid
        ${input.sessionId ? sql`and session_id = ${input.sessionId}::uuid` : sql``}
        ${input.executionGeneration !== undefined ? sql`and execution_generation = ${input.executionGeneration}` : sql``}
        and xai_provider_account_authority_snapshot =
          ${JSON.stringify(input.authoritySnapshot)}::jsonb
      for share`,
  );
  if (!rows[0]) {
    throw new Error("xAI logical turn authority snapshot is unavailable");
  }
}

async function assertXaiCredentialInPool(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    credentialId: string;
    authorityScope: XaiAccountAuthorityScope;
    ownerMembershipId: string | null;
  },
): Promise<void> {
  const [row] = await db
    .select({ id: schema.xaiSubscriptionCredentials.id })
    .from(schema.xaiSubscriptionCredentials)
    .where(
      and(
        eq(schema.xaiSubscriptionCredentials.accountId, input.accountId),
        eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
        eq(schema.xaiSubscriptionCredentials.id, input.credentialId),
        eq(schema.xaiSubscriptionCredentials.authorityScope, input.authorityScope),
        input.ownerMembershipId === null
          ? isNull(schema.xaiSubscriptionCredentials.ownerOrganizationMembershipId)
          : eq(
              schema.xaiSubscriptionCredentials.ownerOrganizationMembershipId,
              input.ownerMembershipId,
            ),
      ),
    )
    .limit(1);
  if (!row) throw new Error("xAI credential is outside the authorized account pool");
}

export async function createXaiSubscriptionCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    scope?: XaiAccountAuthorityScope;
    encryptionKey: Uint8Array;
    secret: XaiCredentialSecretV1;
    providerAccountId?: string | null;
    label?: string | null;
    accountEmail?: string | null;
    planType?: string | null;
    expiresAt?: Date | null;
  },
): Promise<{ account: XaiSubscriptionAccountMetadata; authoritySnapshot: XaiAuthoritySnapshot }> {
  assertSecret(input.secret);
  const scope = input.scope ?? "workspace";
  const encrypted = encryptEnvironmentValue(input.encryptionKey, JSON.stringify(input.secret));
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const rows = await rawRows<{
      credential_id: string;
      authority_generation: number | string | null;
    }>(
      scopedDb,
      sql`select * from create_xai_subscription_credential(
          ${input.accountId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.subjectId},
          ${scope},
          ${encrypted},
          ${input.providerAccountId ?? null},
          ${input.label ?? null},
          ${input.accountEmail ?? null},
          ${input.planType ?? null},
          ${input.expiresAt?.toISOString() ?? null}::timestamptz
        )`,
    );
    const created = rows[0];
    if (!created) throw new Error("xAI credential lifecycle returned no row");
    const [row] = await scopedDb
      .select(xaiCredentialMetadataColumns)
      .from(schema.xaiSubscriptionCredentials)
      .where(eq(schema.xaiSubscriptionCredentials.id, created.credential_id))
      .limit(1);
    if (!row) throw new Error("xAI credential lifecycle result is not visible");
    const authoritySnapshot =
      scope === "workspace"
        ? WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1
        : XaiProviderAccountAuthoritySnapshotV1.parse({
            version: 1,
            scope: "user",
            authorityGeneration: Number(created.authority_generation),
          });
    return { account: metadataFromRow(row), authoritySnapshot };
  });
}

export async function upsertXaiSubscriptionCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    credentialId?: string | null;
    authoritySnapshot?: XaiAuthoritySnapshot;
    scope?: XaiAccountAuthorityScope;
    encryptionKey: Uint8Array;
    secret: XaiCredentialSecretV1;
    providerAccountId?: string | null;
    label?: string | null;
    accountEmail?: string | null;
    planType?: string | null;
    expiresAt?: Date | null;
  },
): Promise<{ account: XaiSubscriptionAccountMetadata; authoritySnapshot: XaiAuthoritySnapshot }> {
  if (!input.credentialId) {
    if (input.providerAccountId) {
      const existing = await findXaiCredentialByProviderIdentity(db, {
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        scope: input.scope ?? "workspace",
        providerAccountId: input.providerAccountId,
      });
      if (existing) {
        return await upsertXaiSubscriptionCredential(db, {
          ...input,
          credentialId: existing.credentialId,
          authoritySnapshot: existing.authoritySnapshot,
        });
      }
    }
    return await createXaiSubscriptionCredential(db, input);
  }
  if (!input.authoritySnapshot) {
    throw new Error("Existing xAI credentials require their frozen authority snapshot");
  }
  const credentialId = input.credentialId;
  assertSecret(input.secret);
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  const encrypted = encryptEnvironmentValue(input.encryptionKey, JSON.stringify(input.secret));
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const authorized = await rawRows<{ id: string }>(
      scopedDb,
      sql`select id from revalidate_xai_subscription_authority(
        ${input.workspaceId}::uuid, ${input.subjectId}, ${credentialId}::uuid,
        ${JSON.stringify(snapshot)}::jsonb
      )`,
    );
    if (!authorized[0]) throw new Error("xAI provider-account authority is no longer active");
    const [row] = await scopedDb
      .update(schema.xaiSubscriptionCredentials)
      .set({
        credentialEncrypted: encrypted,
        providerAccountId: input.providerAccountId ?? null,
        label: input.label ?? null,
        accountEmail: input.accountEmail ?? null,
        planType: input.planType ?? null,
        expiresAt: input.expiresAt ?? null,
        lastRefreshAt: new Date(),
        status: "active",
        lastError: null,
        version: sql`${schema.xaiSubscriptionCredentials.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.xaiSubscriptionCredentials.id, credentialId))
      .returning(xaiCredentialMetadataColumns);
    if (!row) throw new Error("xAI credential update lost its authority fence");
    return { account: metadataFromRow(row), authoritySnapshot: snapshot };
  });
}

async function findXaiCredentialByProviderIdentity(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    scope: XaiAccountAuthorityScope;
    providerAccountId: string;
  },
): Promise<{ credentialId: string; authoritySnapshot: XaiAuthoritySnapshot } | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        id: schema.xaiSubscriptionCredentials.id,
        authorityScope: schema.xaiSubscriptionCredentials.authorityScope,
        authorityGeneration:
          schema.xaiSubscriptionCredentials.organizationUserResourceAuthorityGeneration,
      })
      .from(schema.xaiSubscriptionCredentials)
      .where(
        and(
          eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
          eq(schema.xaiSubscriptionCredentials.authorityScope, input.scope),
          eq(schema.xaiSubscriptionCredentials.providerAccountId, input.providerAccountId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      credentialId: row.id,
      authoritySnapshot:
        row.authorityScope === "workspace"
          ? WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1
          : XaiProviderAccountAuthoritySnapshotV1.parse({
              version: 1,
              scope: "user",
              authorityGeneration: row.authorityGeneration,
            }),
    };
  });
}

export async function listXaiSubscriptionAccountsMetadata(
  db: Database,
  input: { workspaceId: string; subjectId: string },
): Promise<XaiSubscriptionAccountMetadata[]> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const rows = await scopedDb
      .select(xaiCredentialMetadataColumns)
      .from(schema.xaiSubscriptionCredentials)
      .where(eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId))
      .orderBy(
        asc(schema.xaiSubscriptionCredentials.createdAt),
        asc(schema.xaiSubscriptionCredentials.id),
      );
    return rows.map(metadataFromRow);
  });
}

export async function getXaiSubscriptionAccountMetadata(
  db: Database,
  input: { workspaceId: string; subjectId: string; credentialId: string },
): Promise<XaiSubscriptionAccountMetadata | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .select(xaiCredentialMetadataColumns)
      .from(schema.xaiSubscriptionCredentials)
      .where(
        and(
          eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
          eq(schema.xaiSubscriptionCredentials.id, input.credentialId),
        ),
      )
      .limit(1);
    return row ? metadataFromRow(row) : null;
  });
}

export async function getXaiSubscriptionAccountAuthoritySnapshot(
  db: Database,
  input: { workspaceId: string; subjectId: string; credentialId: string },
): Promise<XaiAuthoritySnapshot | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        authorityScope: schema.xaiSubscriptionCredentials.authorityScope,
        authorityGeneration:
          schema.xaiSubscriptionCredentials.organizationUserResourceAuthorityGeneration,
      })
      .from(schema.xaiSubscriptionCredentials)
      .where(
        and(
          eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
          eq(schema.xaiSubscriptionCredentials.id, input.credentialId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return row.authorityScope === "workspace"
      ? WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1
      : XaiProviderAccountAuthoritySnapshotV1.parse({
          version: 1,
          scope: "user",
          authorityGeneration: row.authorityGeneration,
        });
  });
}

/**
 * Resolve the provider-account authority frozen on a newly accepted human turn.
 * Workspace authority is the default. A caller's private pool becomes effective
 * only after that exact pool has an active credential pointer, which is set by
 * the caller's explicit private connection/activation action.
 */
export async function resolveXaiProviderAccountAuthoritySnapshotForAcceptance(
  db: Database,
  input: { workspaceId: string; subjectId: string },
): Promise<XaiAuthoritySnapshot> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    return await resolveXaiProviderAccountAuthoritySnapshotForAcceptanceInTransaction(scopedDb, {
      workspaceId: input.workspaceId,
    });
  });
}

/** Transaction-local acceptance resolver. The caller must already have set the
 * exact authenticated subject GUC on this same transaction. */
export async function resolveXaiProviderAccountAuthoritySnapshotForAcceptanceInTransaction(
  db: Database,
  input: { workspaceId: string },
): Promise<XaiAuthoritySnapshot> {
  const [row] = await db
    .select({
      authorityGeneration:
        schema.xaiSubscriptionCredentials.organizationUserResourceAuthorityGeneration,
    })
    .from(schema.xaiRotationSettings)
    .innerJoin(
      schema.xaiSubscriptionCredentials,
      and(
        eq(schema.xaiSubscriptionCredentials.id, schema.xaiRotationSettings.activeCredentialId),
        eq(schema.xaiSubscriptionCredentials.workspaceId, schema.xaiRotationSettings.workspaceId),
        eq(schema.xaiSubscriptionCredentials.authorityScope, "user"),
        eq(schema.xaiSubscriptionCredentials.status, "active"),
      ),
    )
    .where(
      and(
        eq(schema.xaiRotationSettings.workspaceId, input.workspaceId),
        eq(schema.xaiRotationSettings.authorityScope, "user"),
      ),
    )
    .limit(1);
  if (!row) return WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1;
  return XaiProviderAccountAuthoritySnapshotV1.parse({
    version: 1,
    scope: "user",
    authorityGeneration: row.authorityGeneration,
  });
}

export async function updateXaiSubscriptionAccountSettings(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    credentialId: string;
    expectedVersion: number;
    label?: string | null;
    allocatorEnabled?: boolean;
  },
): Promise<XaiSubscriptionAccountMetadata> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.xaiSubscriptionCredentials)
      .set({
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.allocatorEnabled !== undefined
          ? {
              allocatorEnabled: input.allocatorEnabled,
              allocatorVersion: sql`${schema.xaiSubscriptionCredentials.allocatorVersion} + 1`,
            }
          : {}),
        version: sql`${schema.xaiSubscriptionCredentials.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
          eq(schema.xaiSubscriptionCredentials.id, input.credentialId),
          eq(schema.xaiSubscriptionCredentials.version, input.expectedVersion),
        ),
      )
      .returning(xaiCredentialMetadataColumns);
    if (!row) throw new Error("xAI subscription account settings changed");
    return metadataFromRow(row);
  });
}

export type XaiAllocatorUpdateResult =
  | {
      kind: "updated" | "unchanged" | "conflict";
      allocatorEnabled: boolean;
      allocatorVersion: number;
      allocatorUpdatedAt: Date | null;
    }
  | { kind: "not_found" };

export async function updateXaiAllocatorEligibility(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    credentialId: string;
    enabled: boolean;
    expectedVersion: number;
  },
): Promise<XaiAllocatorUpdateResult> {
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [row] = await tx
          .select({
            allocatorEnabled: schema.xaiSubscriptionCredentials.allocatorEnabled,
            allocatorVersion: schema.xaiSubscriptionCredentials.allocatorVersion,
            allocatorUpdatedAt: schema.xaiSubscriptionCredentials.allocatorUpdatedAt,
          })
          .from(schema.xaiSubscriptionCredentials)
          .where(
            and(
              eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
              eq(schema.xaiSubscriptionCredentials.id, input.credentialId),
            ),
          )
          .for("update")
          .limit(1);
        if (!row) return { kind: "not_found" } as const;
        const current = {
          allocatorEnabled: row.allocatorEnabled,
          allocatorVersion: row.allocatorVersion,
          allocatorUpdatedAt: row.allocatorUpdatedAt,
        };
        if (row.allocatorEnabled === input.enabled) {
          return { kind: "unchanged", ...current } as const;
        }
        if (row.allocatorVersion !== input.expectedVersion) {
          return { kind: "conflict", ...current } as const;
        }
        const changedAt = new Date();
        const [updated] = await tx
          .update(schema.xaiSubscriptionCredentials)
          .set({
            allocatorEnabled: input.enabled,
            allocatorVersion: sql`${schema.xaiSubscriptionCredentials.allocatorVersion} + 1`,
            allocatorUpdatedAt: changedAt,
          })
          .where(
            and(
              eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
              eq(schema.xaiSubscriptionCredentials.id, input.credentialId),
              eq(schema.xaiSubscriptionCredentials.allocatorVersion, input.expectedVersion),
            ),
          )
          .returning({
            allocatorEnabled: schema.xaiSubscriptionCredentials.allocatorEnabled,
            allocatorVersion: schema.xaiSubscriptionCredentials.allocatorVersion,
            allocatorUpdatedAt: schema.xaiSubscriptionCredentials.allocatorUpdatedAt,
          });
        if (!updated) throw new Error("xAI allocator row changed while locked");
        return { kind: "updated", ...updated } as const;
      }),
  );
}

export async function renameXaiSubscriptionAccount(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    credentialId: string;
    label: string | null;
  },
): Promise<XaiSubscriptionAccountMetadata | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.xaiSubscriptionCredentials)
      .set({
        label: input.label,
        version: sql`${schema.xaiSubscriptionCredentials.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
          eq(schema.xaiSubscriptionCredentials.id, input.credentialId),
        ),
      )
      .returning(xaiCredentialMetadataColumns);
    return row ? metadataFromRow(row) : null;
  });
}

export async function refreshXaiSubscriptionCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    credentialId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
    encryptionKey: Uint8Array;
    secret: XaiCredentialSecretV1;
    providerAccountId?: string | null;
    label?: string | null;
    accountEmail?: string | null;
    planType?: string | null;
    expiresAt?: Date | null;
  },
): Promise<XaiCredentialForRun> {
  const updated = await upsertXaiSubscriptionCredential(db, input);
  return await materializeXaiCredentialForRun(db, {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    credentialId: updated.account.id,
    authoritySnapshot: updated.authoritySnapshot,
    encryptionKey: input.encryptionKey,
  });
}

export async function disconnectXaiSubscriptionCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    credentialId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
  },
): Promise<boolean> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const rows = await rawRows<{ disconnected: boolean }>(
      scopedDb,
      sql`select disconnect_xai_subscription_credential(
          ${input.accountId}::uuid, ${input.workspaceId}::uuid,
          ${input.subjectId}, ${input.credentialId}::uuid,
          ${JSON.stringify(snapshot)}::jsonb
        ) as disconnected`,
    );
    return rows[0]?.disconnected === true;
  });
}

export async function materializeXaiCredentialForRun(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    credentialId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
    encryptionKey: Uint8Array;
  },
): Promise<XaiCredentialForRun> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const rows = await rawRows<{ id: string }>(
      scopedDb,
      sql`select id from revalidate_xai_subscription_authority(
        ${input.workspaceId}::uuid,
        ${input.subjectId},
        ${input.credentialId}::uuid,
        ${JSON.stringify(snapshot)}::jsonb
      )`,
    );
    if (!rows[0]) throw new Error("xAI provider-account authority is no longer active");
    const [row] = await scopedDb
      .select({
        ...xaiCredentialMetadataColumns,
        credentialEncrypted: schema.xaiSubscriptionCredentials.credentialEncrypted,
      })
      .from(schema.xaiSubscriptionCredentials)
      .where(
        and(
          eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
          eq(schema.xaiSubscriptionCredentials.id, input.credentialId),
          eq(schema.xaiSubscriptionCredentials.status, "active"),
        ),
      )
      .limit(1);
    if (!row) throw new Error("xAI credential is unavailable");
    return {
      ...metadataFromRow(row),
      secret: parseSecret(decryptEnvironmentValue(input.encryptionKey, row.credentialEncrypted)),
      authoritySnapshot: snapshot,
    };
  });
}

export async function acquireXaiCredentialLease(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    turnId: string;
    holderId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
    pinnedCredentialId?: string | null;
    now?: Date;
    leaseTtlMs?: number;
  },
): Promise<XaiCredentialLeaseResult> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  const now = input.now ?? new Date();
  const leaseTtlMs = input.leaseTtlMs ?? XAI_CREDENTIAL_LEASE_TTL_MS;
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error("xAI credential lease TTL must be positive");
  }
  if (!input.holderId.trim()) {
    throw new Error("xAI credential lease holder id is required");
  }
  const leasedUntil = new Date(now.getTime() + leaseTtlMs);
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await assertXaiTurnAuthoritySnapshot(tx, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          turnId: input.turnId,
          authoritySnapshot: snapshot,
        });
        const ownerMembershipId = await resolveXaiPoolOwnerMembershipId(tx, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authoritySnapshot: snapshot,
        });

        await tx
          .insert(schema.xaiRotationSettings)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            authorityScope: snapshot.scope,
            ownerOrganizationMembershipId: ownerMembershipId,
          })
          .onConflictDoNothing();
        const [settings] = await tx
          .select()
          .from(schema.xaiRotationSettings)
          .where(
            and(
              eq(schema.xaiRotationSettings.workspaceId, input.workspaceId),
              eq(schema.xaiRotationSettings.authorityScope, snapshot.scope),
              ownerMembershipId === null
                ? isNull(schema.xaiRotationSettings.ownerOrganizationMembershipId)
                : eq(schema.xaiRotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
            ),
          )
          .for("update")
          .limit(1);
        if (!settings) throw new Error("xAI rotation settings are unavailable");

        await tx
          .delete(schema.xaiCredentialLeases)
          .where(
            and(
              eq(schema.xaiCredentialLeases.workspaceId, input.workspaceId),
              lte(schema.xaiCredentialLeases.leasedUntil, now),
            ),
          );

        const [existing] = await tx
          .select()
          .from(schema.xaiCredentialLeases)
          .where(
            and(
              eq(schema.xaiCredentialLeases.workspaceId, input.workspaceId),
              eq(schema.xaiCredentialLeases.turnId, input.turnId),
              gt(schema.xaiCredentialLeases.leasedUntil, now),
            ),
          )
          .for("update")
          .limit(1);
        if (existing) {
          const [updated] = await tx
            .update(schema.xaiCredentialLeases)
            .set({
              holderId: input.holderId,
              generation:
                existing.holderId === input.holderId
                  ? existing.generation
                  : existing.generation + 1,
              leasedUntil,
              updatedAt: now,
            })
            .where(eq(schema.xaiCredentialLeases.id, existing.id))
            .returning();
          const accounts = await tx
            .select(xaiCredentialMetadataColumns)
            .from(schema.xaiSubscriptionCredentials)
            .where(eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId));
          return {
            credentialId: updated!.credentialId,
            reused: true,
            holderId: updated!.holderId,
            generation: updated!.generation,
            leasedUntil: updated!.leasedUntil,
            accounts: accounts.map(metadataFromRow),
          };
        }

        const candidates = await tx
          .select(xaiCredentialAllocationColumns)
          .from(schema.xaiSubscriptionCredentials)
          .where(
            and(
              eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
              eq(schema.xaiSubscriptionCredentials.accountId, input.accountId),
              eq(schema.xaiSubscriptionCredentials.authorityScope, snapshot.scope),
              ownerMembershipId === null
                ? isNull(schema.xaiSubscriptionCredentials.ownerOrganizationMembershipId)
                : eq(
                    schema.xaiSubscriptionCredentials.ownerOrganizationMembershipId,
                    ownerMembershipId,
                  ),
            ),
          )
          .orderBy(
            asc(schema.xaiSubscriptionCredentials.selectionCount),
            asc(schema.xaiSubscriptionCredentials.lastSelectedAt),
            asc(schema.xaiSubscriptionCredentials.createdAt),
            asc(schema.xaiSubscriptionCredentials.id),
          );
        const activeLeaseRows = await tx
          .select({ credentialId: schema.xaiCredentialLeases.credentialId })
          .from(schema.xaiCredentialLeases)
          .where(
            and(
              eq(schema.xaiCredentialLeases.workspaceId, input.workspaceId),
              gt(schema.xaiCredentialLeases.leasedUntil, now),
            ),
          );
        const activelyLeasedCredentialIds = new Set(
          activeLeaseRows.map((lease) => lease.credentialId),
        );
        const eligible = candidates.filter(
          (candidate) =>
            candidate.status === "active" &&
            candidate.allocatorEnabled &&
            (!candidate.exhaustedUntil || candidate.exhaustedUntil <= now) &&
            !activelyLeasedCredentialIds.has(candidate.id),
        );
        const selected = input.pinnedCredentialId
          ? eligible.find((candidate) => candidate.id === input.pinnedCredentialId)
          : settings.rotationEnabled || settings.activeCredentialId === null
            ? eligible[0]
            : eligible.find((candidate) => candidate.id === settings.activeCredentialId);
        if (!selected) {
          return {
            credentialId: null,
            reused: false,
            holderId: null,
            generation: null,
            leasedUntil: null,
            accounts: candidates.map(metadataFromRow),
          };
        }
        const [lease] = await tx
          .insert(schema.xaiCredentialLeases)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            authorityScope: snapshot.scope,
            ownerOrganizationMembershipId: ownerMembershipId,
            credentialId: selected.id,
            turnId: input.turnId,
            holderId: input.holderId,
            leasedUntil,
          })
          .returning();
        await tx
          .update(schema.xaiSubscriptionCredentials)
          .set({
            selectionCount: sql`${schema.xaiSubscriptionCredentials.selectionCount} + 1`,
            lastSelectedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.xaiSubscriptionCredentials.id, selected.id));
        await tx
          .update(schema.xaiRotationSettings)
          .set({
            activeCredentialId: selected.id,
            fairnessCursor: sql`${schema.xaiRotationSettings.fairnessCursor} + 1`,
            version: sql`${schema.xaiRotationSettings.version} + 1`,
            updatedAt: now,
          })
          .where(eq(schema.xaiRotationSettings.id, settings.id));
        return {
          credentialId: selected.id,
          reused: false,
          holderId: lease!.holderId,
          generation: lease!.generation,
          leasedUntil: lease!.leasedUntil,
          accounts: candidates.map(metadataFromRow),
        };
      }),
  );
}

export async function releaseXaiCredentialLease(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    turnId: string;
    holderId: string;
    generation: number;
  },
): Promise<boolean> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const [lease] = await tx
        .select()
        .from(schema.xaiCredentialLeases)
        .where(
          and(
            eq(schema.xaiCredentialLeases.workspaceId, input.workspaceId),
            eq(schema.xaiCredentialLeases.turnId, input.turnId),
            eq(schema.xaiCredentialLeases.holderId, input.holderId),
            eq(schema.xaiCredentialLeases.generation, input.generation),
          ),
        )
        .for("update")
        .limit(1);
      if (!lease) return false;
      const deleted = await tx
        .delete(schema.xaiCredentialLeases)
        .where(eq(schema.xaiCredentialLeases.id, lease.id))
        .returning({ id: schema.xaiCredentialLeases.id });
      if (deleted.length !== 1) return false;
      const now = new Date();
      const waiters = await tx
        .update(schema.xaiCapacityWaiters)
        .set({
          wakeRevision: sql`${schema.xaiCapacityWaiters.wakeRevision} + 1`,
          lastWakeReason: "xai_credential_lease_released",
          nextCheckAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.xaiCapacityWaiters.workspaceId, input.workspaceId),
            eq(schema.xaiCapacityWaiters.status, "waiting"),
            eq(schema.xaiCapacityWaiters.authorityScope, lease.authorityScope),
            lease.ownerOrganizationMembershipId === null
              ? isNull(schema.xaiCapacityWaiters.ownerOrganizationMembershipId)
              : eq(
                  schema.xaiCapacityWaiters.ownerOrganizationMembershipId,
                  lease.ownerOrganizationMembershipId,
                ),
          ),
        )
        .returning({
          accountId: schema.xaiCapacityWaiters.accountId,
          sessionId: schema.xaiCapacityWaiters.sessionId,
          workflowId: schema.xaiCapacityWaiters.workflowId,
        });
      for (const waiter of waiters) {
        await tx
          .insert(schema.sessionWorkflowWakeOutbox)
          .values({
            accountId: waiter.accountId,
            workspaceId: input.workspaceId,
            sessionId: waiter.sessionId,
            temporalWorkflowId: waiter.workflowId,
            reason: "xai_capacity",
            nextAttemptAt: now,
          })
          .onConflictDoUpdate({
            target: schema.sessionWorkflowWakeOutbox.sessionId,
            set: {
              temporalWorkflowId: waiter.workflowId,
              wakeRevision: sql`${schema.sessionWorkflowWakeOutbox.wakeRevision} + 1`,
              reason: "xai_capacity",
              attempts: 0,
              nextAttemptAt: sql`least(${schema.sessionWorkflowWakeOutbox.nextAttemptAt}, ${now.toISOString()}::timestamptz)`,
              lastError: null,
              updatedAt: now,
            },
          });
      }
      return true;
    });
  });
}

export async function heartbeatXaiCredentialLeaseUntil(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    turnId: string;
    holderId: string;
    generation: number;
    leaseTtlMs?: number;
    now?: Date;
  },
): Promise<Date | null> {
  const now = input.now ?? new Date();
  const leaseTtlMs = input.leaseTtlMs ?? XAI_CREDENTIAL_LEASE_TTL_MS;
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error("xAI credential lease TTL must be positive");
  }
  const leasedUntil = new Date(now.getTime() + leaseTtlMs);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.xaiCredentialLeases)
      .set({ leasedUntil, updatedAt: now })
      .where(
        and(
          eq(schema.xaiCredentialLeases.workspaceId, input.workspaceId),
          eq(schema.xaiCredentialLeases.turnId, input.turnId),
          eq(schema.xaiCredentialLeases.holderId, input.holderId),
          eq(schema.xaiCredentialLeases.generation, input.generation),
          gt(schema.xaiCredentialLeases.leasedUntil, now),
        ),
      )
      .returning({ leasedUntil: schema.xaiCredentialLeases.leasedUntil });
    return row?.leasedUntil ?? null;
  });
}

export async function getXaiRotationSettings(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
  },
): Promise<typeof schema.xaiRotationSettings.$inferSelect | null> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const ownerMembershipId = await resolveXaiPoolOwnerMembershipId(scopedDb, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      authoritySnapshot: snapshot,
    });
    const rows = await scopedDb
      .select()
      .from(schema.xaiRotationSettings)
      .where(
        and(
          eq(schema.xaiRotationSettings.workspaceId, input.workspaceId),
          eq(schema.xaiRotationSettings.authorityScope, snapshot.scope),
          ownerMembershipId === null
            ? isNull(schema.xaiRotationSettings.ownerOrganizationMembershipId)
            : eq(schema.xaiRotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
        ),
      );
    return rows[0] ?? null;
  });
}

export async function ensureXaiRotationSettings(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
  },
): Promise<typeof schema.xaiRotationSettings.$inferSelect> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const ownerMembershipId = await resolveXaiPoolOwnerMembershipId(scopedDb, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      authoritySnapshot: snapshot,
    });
    const [row] = await scopedDb
      .insert(schema.xaiRotationSettings)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        authorityScope: snapshot.scope,
        ownerOrganizationMembershipId: ownerMembershipId,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const [current] = await scopedDb
      .select()
      .from(schema.xaiRotationSettings)
      .where(
        and(
          eq(schema.xaiRotationSettings.workspaceId, input.workspaceId),
          eq(schema.xaiRotationSettings.authorityScope, snapshot.scope),
          ownerMembershipId === null
            ? isNull(schema.xaiRotationSettings.ownerOrganizationMembershipId)
            : eq(schema.xaiRotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
        ),
      )
      .limit(1);
    if (!current) throw new Error("xAI rotation settings are unavailable");
    return current;
  });
}

export async function setActiveXaiCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
    credentialId: string;
  },
): Promise<boolean> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const ownerMembershipId = await resolveXaiPoolOwnerMembershipId(tx, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authoritySnapshot: snapshot,
        });
        await assertXaiCredentialInPool(tx, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          credentialId: input.credentialId,
          authorityScope: snapshot.scope,
          ownerMembershipId,
        });
        const [credential] = await tx
          .select({ status: schema.xaiSubscriptionCredentials.status })
          .from(schema.xaiSubscriptionCredentials)
          .where(eq(schema.xaiSubscriptionCredentials.id, input.credentialId))
          .limit(1);
        if (!credential || credential.status !== "active") return false;
        await tx
          .insert(schema.xaiRotationSettings)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            authorityScope: snapshot.scope,
            ownerOrganizationMembershipId: ownerMembershipId,
            activeCredentialId: input.credentialId,
          })
          .onConflictDoUpdate({
            target: [
              schema.xaiRotationSettings.workspaceId,
              schema.xaiRotationSettings.authorityScope,
              schema.xaiRotationSettings.ownerOrganizationMembershipId,
            ],
            set: {
              activeCredentialId: input.credentialId,
              version: sql`${schema.xaiRotationSettings.version} + 1`,
              updatedAt: new Date(),
            },
          });
        if (snapshot.scope === "workspace") {
          // Workspace is the deliberate default. Selecting a workspace account
          // also opts the current subject out of their private pool; FORCE RLS
          // limits this update to that subject's visible user-scoped row.
          await tx
            .update(schema.xaiRotationSettings)
            .set({
              activeCredentialId: null,
              version: sql`${schema.xaiRotationSettings.version} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.xaiRotationSettings.workspaceId, input.workspaceId),
                eq(schema.xaiRotationSettings.authorityScope, "user"),
              ),
            );
        }
        return true;
      }),
  );
}

export async function setInitialActiveXaiCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
    credentialId: string;
  },
): Promise<boolean> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const ownerMembershipId = await resolveXaiPoolOwnerMembershipId(tx, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authoritySnapshot: snapshot,
        });
        await assertXaiCredentialInPool(tx, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          credentialId: input.credentialId,
          authorityScope: snapshot.scope,
          ownerMembershipId,
        });
        await tx
          .insert(schema.xaiRotationSettings)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            authorityScope: snapshot.scope,
            ownerOrganizationMembershipId: ownerMembershipId,
          })
          .onConflictDoNothing();
        const [updated] = await tx
          .update(schema.xaiRotationSettings)
          .set({
            activeCredentialId: input.credentialId,
            version: sql`${schema.xaiRotationSettings.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.xaiRotationSettings.workspaceId, input.workspaceId),
              eq(schema.xaiRotationSettings.authorityScope, snapshot.scope),
              ownerMembershipId === null
                ? isNull(schema.xaiRotationSettings.ownerOrganizationMembershipId)
                : eq(schema.xaiRotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
              isNull(schema.xaiRotationSettings.activeCredentialId),
            ),
          )
          .returning({ id: schema.xaiRotationSettings.id });
        return updated !== undefined;
      }),
  );
}

export async function disconnectXaiSubscriptionCredentialAndRepick(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    credentialId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
  },
): Promise<{ disconnected: boolean; newActiveCredentialId: string | null }> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const ownerMembershipId = await resolveXaiPoolOwnerMembershipId(tx, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authoritySnapshot: snapshot,
        });
        const disconnected = await disconnectXaiSubscriptionCredential(tx, input);
        if (!disconnected) return { disconnected: false, newActiveCredentialId: null };
        const [settings] = await tx
          .select()
          .from(schema.xaiRotationSettings)
          .where(
            and(
              eq(schema.xaiRotationSettings.workspaceId, input.workspaceId),
              eq(schema.xaiRotationSettings.authorityScope, snapshot.scope),
              ownerMembershipId === null
                ? isNull(schema.xaiRotationSettings.ownerOrganizationMembershipId)
                : eq(schema.xaiRotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
            ),
          )
          .for("update")
          .limit(1);
        if (!settings) return { disconnected: true, newActiveCredentialId: null };
        if (settings.activeCredentialId !== null) {
          return { disconnected: true, newActiveCredentialId: settings.activeCredentialId };
        }
        const [replacement] = await tx
          .select({ id: schema.xaiSubscriptionCredentials.id })
          .from(schema.xaiSubscriptionCredentials)
          .where(
            and(
              eq(schema.xaiSubscriptionCredentials.accountId, input.accountId),
              eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
              eq(schema.xaiSubscriptionCredentials.authorityScope, snapshot.scope),
              ownerMembershipId === null
                ? isNull(schema.xaiSubscriptionCredentials.ownerOrganizationMembershipId)
                : eq(
                    schema.xaiSubscriptionCredentials.ownerOrganizationMembershipId,
                    ownerMembershipId,
                  ),
              eq(schema.xaiSubscriptionCredentials.status, "active"),
            ),
          )
          .orderBy(
            asc(schema.xaiSubscriptionCredentials.createdAt),
            asc(schema.xaiSubscriptionCredentials.id),
          )
          .limit(1);
        await tx
          .update(schema.xaiRotationSettings)
          .set({
            activeCredentialId: replacement?.id ?? null,
            version: sql`${schema.xaiRotationSettings.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(schema.xaiRotationSettings.id, settings.id));
        return { disconnected: true, newActiveCredentialId: replacement?.id ?? null };
      }),
  );
}

export async function updateXaiRotationSettings(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
    expectedVersion: number;
    rotationEnabled: boolean;
  },
): Promise<typeof schema.xaiRotationSettings.$inferSelect> {
  const current = await getXaiRotationSettings(db, input);
  if (!current || current.version !== input.expectedVersion) {
    throw new Error("xAI rotation settings changed");
  }
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.xaiRotationSettings)
      .set({
        rotationEnabled: input.rotationEnabled,
        version: sql`${schema.xaiRotationSettings.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.xaiRotationSettings.id, current.id),
          eq(schema.xaiRotationSettings.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!row) throw new Error("xAI rotation settings changed");
    return row;
  });
}

export async function setXaiSessionAccountPin(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    sessionId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
    credentialId: string | null;
    pinSource: "manual" | "policy" | null;
    expectedVersion?: number;
  },
): Promise<typeof schema.xaiSessionAccountPins.$inferSelect> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const ownerMembershipId = await resolveXaiPoolOwnerMembershipId(scopedDb, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      authoritySnapshot: snapshot,
    });
    if (input.credentialId) {
      await assertXaiCredentialInPool(scopedDb, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        credentialId: input.credentialId,
        authorityScope: snapshot.scope,
        ownerMembershipId,
      });
    }
    const [current] = await scopedDb
      .select()
      .from(schema.xaiSessionAccountPins)
      .where(
        and(
          eq(schema.xaiSessionAccountPins.workspaceId, input.workspaceId),
          eq(schema.xaiSessionAccountPins.sessionId, input.sessionId),
          eq(schema.xaiSessionAccountPins.authorityScope, snapshot.scope),
          ownerMembershipId === null
            ? isNull(schema.xaiSessionAccountPins.ownerOrganizationMembershipId)
            : eq(schema.xaiSessionAccountPins.ownerOrganizationMembershipId, ownerMembershipId),
        ),
      )
      .limit(1);
    if (
      current &&
      input.expectedVersion !== undefined &&
      current.version !== input.expectedVersion
    ) {
      throw new Error("xAI session pin changed");
    }
    const [row] = await scopedDb
      .insert(schema.xaiSessionAccountPins)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        authorityScope: snapshot.scope,
        ownerOrganizationMembershipId: ownerMembershipId,
        pinnedCredentialId: input.credentialId,
        pinSource: input.credentialId ? input.pinSource : null,
      })
      .onConflictDoUpdate({
        target: [
          schema.xaiSessionAccountPins.workspaceId,
          schema.xaiSessionAccountPins.sessionId,
          schema.xaiSessionAccountPins.authorityScope,
          schema.xaiSessionAccountPins.ownerOrganizationMembershipId,
        ],
        set: {
          pinnedCredentialId: input.credentialId,
          pinSource: input.credentialId ? input.pinSource : null,
          version: sql`${schema.xaiSessionAccountPins.version} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  });
}

export async function getXaiSessionAccountPin(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    sessionId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
  },
): Promise<typeof schema.xaiSessionAccountPins.$inferSelect | null> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const ownerMembershipId = await resolveXaiPoolOwnerMembershipId(scopedDb, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      authoritySnapshot: snapshot,
    });
    const [row] = await scopedDb
      .select()
      .from(schema.xaiSessionAccountPins)
      .where(
        and(
          eq(schema.xaiSessionAccountPins.workspaceId, input.workspaceId),
          eq(schema.xaiSessionAccountPins.sessionId, input.sessionId),
          eq(schema.xaiSessionAccountPins.authorityScope, snapshot.scope),
          ownerMembershipId === null
            ? isNull(schema.xaiSessionAccountPins.ownerOrganizationMembershipId)
            : eq(schema.xaiSessionAccountPins.ownerOrganizationMembershipId, ownerMembershipId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function recordXaiSessionLastAccount(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    sessionId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
    credentialId: string;
  },
): Promise<typeof schema.xaiSessionAccountPins.$inferSelect> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const ownerMembershipId = await resolveXaiPoolOwnerMembershipId(scopedDb, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      authoritySnapshot: snapshot,
    });
    await assertXaiCredentialInPool(scopedDb, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      credentialId: input.credentialId,
      authorityScope: snapshot.scope,
      ownerMembershipId,
    });
    const [row] = await scopedDb
      .insert(schema.xaiSessionAccountPins)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        authorityScope: snapshot.scope,
        ownerOrganizationMembershipId: ownerMembershipId,
        lastCredentialId: input.credentialId,
      })
      .onConflictDoUpdate({
        target: [
          schema.xaiSessionAccountPins.workspaceId,
          schema.xaiSessionAccountPins.sessionId,
          schema.xaiSessionAccountPins.authorityScope,
          schema.xaiSessionAccountPins.ownerOrganizationMembershipId,
        ],
        set: {
          lastCredentialId: input.credentialId,
          version: sql`${schema.xaiSessionAccountPins.version} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  });
}

export async function updateXaiQuotaMetadata(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    credentialId: string;
    quotaUsedPercent: number | null;
    quotaResetAt: Date | null;
    quotaCheckedAt: Date;
    exhaustedUntil: Date | null;
  },
): Promise<boolean> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const updated = await scopedDb
      .update(schema.xaiSubscriptionCredentials)
      .set({
        quotaUsedPercent: input.quotaUsedPercent,
        quotaResetAt: input.quotaResetAt,
        quotaCheckedAt: input.quotaCheckedAt,
        exhaustedUntil: input.exhaustedUntil,
        updatedAt: input.quotaCheckedAt,
      })
      .where(
        and(
          eq(schema.xaiSubscriptionCredentials.workspaceId, input.workspaceId),
          eq(schema.xaiSubscriptionCredentials.id, input.credentialId),
        ),
      )
      .returning({ id: schema.xaiSubscriptionCredentials.id });
    return updated.length === 1;
  });
}

export async function wakeXaiCapacityWaiters(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
    reason: string;
    now?: Date;
  },
): Promise<number> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  const now = input.now ?? new Date();
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const ownerMembershipId = await resolveXaiPoolOwnerMembershipId(scopedDb, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      authoritySnapshot: snapshot,
    });
    const rows = await scopedDb
      .update(schema.xaiCapacityWaiters)
      .set({
        wakeRevision: sql`${schema.xaiCapacityWaiters.wakeRevision} + 1`,
        lastWakeReason: input.reason,
        nextCheckAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.xaiCapacityWaiters.workspaceId, input.workspaceId),
          eq(schema.xaiCapacityWaiters.status, "waiting"),
          eq(schema.xaiCapacityWaiters.authorityScope, snapshot.scope),
          ownerMembershipId === null
            ? isNull(schema.xaiCapacityWaiters.ownerOrganizationMembershipId)
            : eq(schema.xaiCapacityWaiters.ownerOrganizationMembershipId, ownerMembershipId),
        ),
      )
      .returning({
        id: schema.xaiCapacityWaiters.id,
        accountId: schema.xaiCapacityWaiters.accountId,
        sessionId: schema.xaiCapacityWaiters.sessionId,
        workflowId: schema.xaiCapacityWaiters.workflowId,
      });
    for (const row of rows) {
      await scopedDb
        .insert(schema.sessionWorkflowWakeOutbox)
        .values({
          accountId: row.accountId,
          workspaceId: input.workspaceId,
          sessionId: row.sessionId,
          temporalWorkflowId: row.workflowId,
          reason: "xai_capacity",
          nextAttemptAt: now,
        })
        .onConflictDoUpdate({
          target: schema.sessionWorkflowWakeOutbox.sessionId,
          set: {
            temporalWorkflowId: row.workflowId,
            wakeRevision: sql`${schema.sessionWorkflowWakeOutbox.wakeRevision} + 1`,
            reason: "xai_capacity",
            attempts: 0,
            nextAttemptAt: sql`least(${schema.sessionWorkflowWakeOutbox.nextAttemptAt}, ${now.toISOString()}::timestamptz)`,
            lastError: null,
            updatedAt: now,
          },
        });
    }
    return rows.length;
  });
}
