import { SubscriptionAccountChangedError } from "./subscription-account-conflict";
import { subscriptionAccountShardIndex, selectSubscriptionAccount } from "@opengeni/config";
import { assignedConnectionDefault, connectionModelAllowed } from "./model-connection-access";
import { heartbeatSubscriptionCredentialLeaseUntil as heartbeatPoolCredentialLeaseUntil } from "./subscription-credential-leases";
import {
  WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1 as WORKSPACE_AUTHORITY_SNAPSHOT_V1,
  XaiProviderAccountAuthoritySnapshotV1 as SubscriptionAuthoritySnapshotV1,
  type XaiProviderAccountAuthoritySnapshotV1 as SubscriptionAuthoritySnapshot,
} from "@opengeni/contracts";
import { inArray, and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withWorkspaceSubjectRls, withRlsContext, setSubjectRlsContext } from "./database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import * as schema from "./schema";

import type { SubscriptionPoolTables } from "./subscription-pool-schema";

export type SubscriptionAccountCapacity = {
  available: boolean;
  resetsAt: Date | null;
};

/** Shared subscription account lifecycle, selection, leases, pins and wake writes. */
export function createSubscriptionAccountRepository<Secret, Settings>(options: {
  provider: "xai" | "claude";
  label: "xAI" | "Claude";
  displayName: "SuperGrok" | "Claude";
  isEnabled: (settings: Settings) => boolean;
  tables: SubscriptionPoolTables;
  leaseTable: Parameters<typeof heartbeatPoolCredentialLeaseUntil>[1];
  assertSecret: (secret: Secret) => void;
  parseSecret: (value: string) => Secret;
  accessToken: (secret: Secret) => string | undefined;
  refreshToken: (secret: Secret) => string | undefined;
  /** OAuth renewal can preserve the account generation; explicit replacement never does. */
  refreshIncrementsVersion?: boolean;
  metadataIncrementsVersion?: boolean;
  /** One provider-specific quota read for the already-authorized pool. Missing rows fail closed. */
  readCapacity?: (
    db: Database,
    input: {
      candidates: readonly { id: string; version: number; exhaustedUntil: Date | null }[];
      upstreamModelId: string;
      now: Date;
    },
  ) => Promise<ReadonlyMap<string, SubscriptionAccountCapacity>>;
}) {
  const { provider, label, tables } = options;
  type SubscriptionAccountAuthorityScope = "workspace" | "user" | "organization";
  type SubscriptionCredentialStatus = "active" | "needs_relogin" | "error" | "disabled";

  type SubscriptionCredentialSecret = Secret;

  type SubscriptionAccountMetadata = {
    allowedModelIds?: string[] | null;
    id: string;
    scope: SubscriptionAccountAuthorityScope;
    providerAccountId: string | null;
    label: string | null;
    accountEmail: string | null;
    planType: string | null;
    status: SubscriptionCredentialStatus;
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

  type SubscriptionCredentialForRun = SubscriptionAccountMetadata & {
    secret: SubscriptionCredentialSecret;
    authoritySnapshot: SubscriptionAuthoritySnapshot;
  };

  type SubscriptionCredentialLeaseResult = {
    credentialId: string | null;
    rotationEnabled: boolean;
    reused: boolean;
    holderId: string | null;
    generation: number | null;
    leasedUntil: Date | null;
    nextCheckAt?: Date | null;
    accounts: SubscriptionAccountMetadata[];
  };

  const CREDENTIAL_LEASE_TTL_MS = 5 * 60_000;

  /** Stable session sharding, matching Codex's cache-affinity contract. */
  const credentialShardIndex = subscriptionAccountShardIndex;

  type SubscriptionCredentialMetadataRow = Pick<
    typeof tables.credentials.$inferSelect,
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
    | "allowedModelIds"
    | "connectedBySubjectId"
  >;

  const credentialMetadataColumns = {
    allowedModelIds: tables.credentials.allowedModelIds,
    id: tables.credentials.id,
    authorityScope: tables.credentials.authorityScope,
    providerAccountId: tables.credentials.providerAccountId,
    label: tables.credentials.label,
    accountEmail: tables.credentials.accountEmail,
    planType: tables.credentials.planType,
    status: tables.credentials.status,
    allocatorEnabled: tables.credentials.allocatorEnabled,
    version: tables.credentials.version,
    allocatorVersion: tables.credentials.allocatorVersion,
    allocatorUpdatedAt: tables.credentials.allocatorUpdatedAt,
    expiresAt: tables.credentials.expiresAt,
    lastRefreshAt: tables.credentials.lastRefreshAt,
    lastError: tables.credentials.lastError,
    quotaUsedPercent: tables.credentials.quotaUsedPercent,
    quotaResetAt: tables.credentials.quotaResetAt,
    quotaCheckedAt: tables.credentials.quotaCheckedAt,
    exhaustedUntil: tables.credentials.exhaustedUntil,
    selectionCount: tables.credentials.selectionCount,
    lastSelectedAt: tables.credentials.lastSelectedAt,
    connectedBySubjectId: tables.credentials.connectedBySubjectId,
  } as const;

  const credentialAllocationColumns = {
    ...credentialMetadataColumns,
    accountId: tables.credentials.accountId,
    workspaceId: tables.credentials.workspaceId,
    ownerOrganizationMembershipId: tables.credentials.ownerOrganizationMembershipId,
    createdAt: tables.credentials.createdAt,
  } as const;

  const assertSecret = options.assertSecret;
  const parseSecret = options.parseSecret;

  function subscriptionAccountMetadataFromRow(
    row: SubscriptionCredentialMetadataRow,
  ): SubscriptionAccountMetadata {
    return {
      id: row.id,
      scope: row.authorityScope as SubscriptionAccountAuthorityScope,
      providerAccountId: row.providerAccountId,
      allowedModelIds: row.allowedModelIds,
      label: row.label,
      accountEmail: row.accountEmail,
      planType: row.planType,
      status: row.status as SubscriptionCredentialStatus,
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

  /**
   * A frozen user-scope subscription authority whose pool no longer resolves: the
   * owner disconnected it, reconnected under a new authority generation, or left
   * the organization. Callers that only ask whether the subscription is ready may treat
   * it as "not ready"; execution paths keep failing closed.
   */
  class SubscriptionAuthorityPoolInactiveError extends Error {
    constructor() {
      super(label + " user authority pool is no longer active");
      this.name =
        provider === "xai" ? "XaiAuthorityPoolInactiveError" : "ClaudeAuthorityPoolInactiveError";
    }
  }

  async function resolvePoolOwnerMembershipId(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
    },
  ): Promise<string | null> {
    if (input.authoritySnapshot.scope !== "user") return null;
    const rows = await rawRows<{ membership_id: string }>(
      db,
      sql`select organization_membership_id as membership_id
      from ${sql.identifier("resolve_xai_authority_pool".replace("xai", provider))}(
        current_setting('opengeni.account_id')::uuid,
        ${input.workspaceId}::uuid,
        ${input.subjectId},
        ${JSON.stringify(input.authoritySnapshot)}::jsonb
      )`,
    );
    const ownerMembershipId = rows[0]?.membership_id ?? null;
    if (!ownerMembershipId) {
      throw new SubscriptionAuthorityPoolInactiveError();
    }
    return ownerMembershipId;
  }

  async function assertTurnAuthoritySnapshot(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      turnId: string;
      sessionId?: string;
      executionGeneration?: number;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
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
        and ${sql.identifier(provider + "_provider_account_authority_snapshot")} =
          ${JSON.stringify(input.authoritySnapshot)}::jsonb
      for share`,
    );
    if (!rows[0]) {
      throw new Error(label + " logical turn authority snapshot is unavailable");
    }
  }

  async function assertCredentialInPool(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      credentialId: string;
      authorityScope: SubscriptionAccountAuthorityScope;
      ownerMembershipId: string | null;
    },
  ): Promise<void> {
    const [row] = await db
      .select({ id: tables.credentials.id })
      .from(tables.credentials)
      .where(
        and(
          eq(tables.credentials.accountId, input.accountId),
          subscriptionCredentialWorkspacePredicate(input.workspaceId),
          eq(tables.credentials.id, input.credentialId),
          eq(tables.credentials.authorityScope, input.authorityScope),
          input.ownerMembershipId === null
            ? isNull(tables.credentials.ownerOrganizationMembershipId)
            : eq(tables.credentials.ownerOrganizationMembershipId, input.ownerMembershipId),
        ),
      )
      .limit(1);
    if (!row) throw new Error(label + " credential is outside the authorized account pool");
  }

  async function createSubscriptionCredential(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      scope?: Exclude<SubscriptionAccountAuthorityScope, "organization">;
      encryptionKey: Uint8Array;
      secret: SubscriptionCredentialSecret;
      providerAccountId?: string | null;
      label?: string | null;
      accountEmail?: string | null;
      planType?: string | null;
      expiresAt?: Date | null;
    },
  ): Promise<{
    account: SubscriptionAccountMetadata;
    authoritySnapshot: SubscriptionAuthoritySnapshot;
  }> {
    assertSecret(input.secret);
    const scope = input.scope ?? "workspace";
    const encrypted = encryptEnvironmentValue(input.encryptionKey, JSON.stringify(input.secret));
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const rows = await rawRows<{
          credential_id: string;
          authority_generation: number | string | null;
        }>(
          scopedDb,
          sql`select * from ${sql.identifier("create_xai_subscription_credential".replace("xai", provider))}(
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
        if (!created) throw new Error(label + " credential lifecycle returned no row");
        const [row] = await scopedDb
          .select(credentialMetadataColumns)
          .from(tables.credentials)
          .where(eq(tables.credentials.id, created.credential_id))
          .limit(1);
        if (!row) throw new Error(label + " credential lifecycle result is not visible");
        const authoritySnapshot =
          scope === "workspace"
            ? WORKSPACE_AUTHORITY_SNAPSHOT_V1
            : SubscriptionAuthoritySnapshotV1.parse({
                version: 1,
                scope: "user",
                authorityGeneration: Number(created.authority_generation),
              });
        return { account: subscriptionAccountMetadataFromRow(row), authoritySnapshot };
      },
    );
  }

  async function upsertSubscriptionCredential(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      credentialId?: string | null;
      expectedCredentialVersion?: number;
      expectedProviderAccountId?: string | null;
      authoritySnapshot?: SubscriptionAuthoritySnapshot;
      scope?: Exclude<SubscriptionAccountAuthorityScope, "organization">;
      encryptionKey: Uint8Array;
      secret: SubscriptionCredentialSecret;
      providerAccountId?: string | null;
      label?: string | null;
      accountEmail?: string | null;
      planType?: string | null;
      expiresAt?: Date | null;
    },
  ): Promise<{
    account: SubscriptionAccountMetadata;
    authoritySnapshot: SubscriptionAuthoritySnapshot;
  }> {
    if (!input.credentialId) {
      if (input.providerAccountId) {
        const existing = await findCredentialByProviderIdentity(db, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          scope: input.scope ?? "workspace",
          providerAccountId: input.providerAccountId,
        });
        if (existing) {
          return await upsertSubscriptionCredential(db, {
            ...input,
            credentialId: existing.credentialId,
            authoritySnapshot: existing.authoritySnapshot,
          });
        }
      }
      try {
        return await createSubscriptionCredential(db, input);
      } catch (error) {
        // Two completed sign-ins can discover the same provider identity before
        // either insert commits. The unique owner/scope identity remains truth;
        // retry only that exact visible identity after the losing transaction rolls back.
        let cause: unknown = error;
        let uniqueConflict = false;
        for (let depth = 0; depth < 6 && cause instanceof Error; depth++) {
          if ("code" in cause && cause.code === "23505") uniqueConflict = true;
          cause = cause.cause;
        }
        if (!uniqueConflict || !input.providerAccountId) throw error;
        const existing = await findCredentialByProviderIdentity(db, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          scope: input.scope ?? "workspace",
          providerAccountId: input.providerAccountId,
        });
        if (!existing) throw error;
        return await upsertSubscriptionCredential(db, {
          ...input,
          credentialId: existing.credentialId,
          authoritySnapshot: existing.authoritySnapshot,
        });
      }
    }
    if (!input.authoritySnapshot) {
      throw new Error("Existing " + label + " credentials require their frozen authority snapshot");
    }
    const credentialId = input.credentialId;
    assertSecret(input.secret);
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    const encrypted = encryptEnvironmentValue(input.encryptionKey, JSON.stringify(input.secret));
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const authorized = await rawRows<{ id: string }>(
          scopedDb,
          sql`select id from ${sql.identifier("revalidate_xai_subscription_authority".replace("xai", provider))}(
        ${input.workspaceId}::uuid, ${input.subjectId}, ${credentialId}::uuid,
        ${JSON.stringify(snapshot)}::jsonb
      )`,
        );
        if (!authorized[0]) throw new SubscriptionAccountChangedError();
        const [row] = await scopedDb
          .update(tables.credentials)
          .set({
            credentialEncrypted: encrypted,
            providerAccountId: input.providerAccountId ?? null,
            label: input.label ?? null,
            accountEmail: input.accountEmail ?? null,
            planType: input.planType ?? null,
            ...(options.readCapacity
              ? {
                  exhaustedUntil: null,
                  quotaUsedPercent: null,
                  quotaResetAt: null,
                  quotaCheckedAt: null,
                }
              : {}),
            expiresAt: input.expiresAt ?? null,
            lastRefreshAt: new Date(),
            status: "active",
            lastError: null,
            version: sql`${tables.credentials.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tables.credentials.id, credentialId),
              ...(input.expectedCredentialVersion === undefined
                ? []
                : [eq(tables.credentials.version, input.expectedCredentialVersion)]),
              ...(input.expectedProviderAccountId === undefined
                ? []
                : [
                    input.expectedProviderAccountId === null
                      ? isNull(tables.credentials.providerAccountId)
                      : eq(tables.credentials.providerAccountId, input.expectedProviderAccountId),
                  ]),
            ),
          )
          .returning(credentialMetadataColumns);
        if (!row) throw new SubscriptionAccountChangedError();
        return {
          account: subscriptionAccountMetadataFromRow(row),
          authoritySnapshot: snapshot,
        };
      },
    );
  }

  async function findCredentialByProviderIdentity(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      scope: SubscriptionAccountAuthorityScope;
      providerAccountId: string;
    },
  ): Promise<{ credentialId: string; authoritySnapshot: SubscriptionAuthoritySnapshot } | null> {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const [row] = await scopedDb
          .select({
            id: tables.credentials.id,
            authorityScope: tables.credentials.authorityScope,
            authorityGeneration: tables.credentials.organizationUserResourceAuthorityGeneration,
          })
          .from(tables.credentials)
          .where(
            and(
              subscriptionCredentialWorkspacePredicate(input.workspaceId),
              eq(tables.credentials.authorityScope, input.scope),
              eq(tables.credentials.providerAccountId, input.providerAccountId),
            ),
          )
          .limit(1);
        if (!row) return null;
        return {
          credentialId: row.id,
          authoritySnapshot:
            row.authorityScope === "workspace"
              ? WORKSPACE_AUTHORITY_SNAPSHOT_V1
              : SubscriptionAuthoritySnapshotV1.parse({
                  version: 1,
                  scope: "user",
                  authorityGeneration: row.authorityGeneration,
                }),
        };
      },
    );
  }

  async function listSubscriptionAccountsMetadata(
    db: Database,
    input: { workspaceId: string; subjectId: string },
  ): Promise<SubscriptionAccountMetadata[]> {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const rows = await scopedDb
          .select(credentialMetadataColumns)
          .from(tables.credentials)
          .where(subscriptionCredentialWorkspacePredicate(input.workspaceId))
          .orderBy(asc(tables.credentials.createdAt), asc(tables.credentials.id));
        return rows.map(subscriptionAccountMetadataFromRow);
      },
    );
  }

  /** Metadata for one frozen pool; never substitutes another owner's pool. */
  async function listSubscriptionAccountsMetadataForAuthority(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
    },
  ): Promise<SubscriptionAccountMetadata[]> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
      const owner = await resolvePoolOwnerMembershipId(tx, {
        ...input,
        authoritySnapshot: snapshot,
      });
      const rows = await tx
        .select(credentialMetadataColumns)
        .from(tables.credentials)
        .where(
          and(
            subscriptionCredentialWorkspacePredicate(input.workspaceId),
            eq(tables.credentials.authorityScope, snapshot.scope),
            owner === null
              ? isNull(tables.credentials.ownerOrganizationMembershipId)
              : eq(tables.credentials.ownerOrganizationMembershipId, owner),
          ),
        )
        .orderBy(asc(tables.credentials.createdAt), asc(tables.credentials.id));
      return rows.map(subscriptionAccountMetadataFromRow);
    });
  }

  /**
   * Metadata-only readiness check for the subscription model catalog.
   *
   * Like Codex, allocator eligibility is runtime scheduling state, not connection
   * readiness. With rotation enabled any healthy account makes the rail ready;
   * with rotation disabled the explicit active account is authoritative.
   */
  async function workspaceSubscriptionActive(
    db: Database,
    settings: Settings,
    workspaceId: string,
    subjectId: string,
  ): Promise<boolean> {
    if (!options.isEnabled(settings)) return false;
    const authoritySnapshot =
      await resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance(db, {
        workspaceId,
        subjectId,
      });
    return await workspaceSubscriptionActiveForAuthority(db, settings, {
      workspaceId,
      subjectId,
      authoritySnapshot,
    });
  }

  /** Metadata-only readiness for the exact provider-account authority frozen on a turn. */
  async function workspaceSubscriptionActiveForAuthority(
    db: Database,
    settings: Settings,
    input: {
      workspaceId: string;
      subjectId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      modelId?: string;
      upstreamModelId?: string;
    },
  ): Promise<boolean> {
    if (!options.isEnabled(settings)) return false;
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const ownerMembershipId = await resolvePoolOwnerMembershipId(scopedDb, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authoritySnapshot: snapshot,
        });
        const ownerPredicate =
          ownerMembershipId === null
            ? isNull(tables.credentials.ownerOrganizationMembershipId)
            : eq(tables.credentials.ownerOrganizationMembershipId, ownerMembershipId);
        const [accounts, rotation] = await Promise.all([
          scopedDb
            .select(credentialMetadataColumns)
            .from(tables.credentials)
            .where(
              and(
                subscriptionCredentialWorkspacePredicate(input.workspaceId),
                eq(tables.credentials.authorityScope, snapshot.scope),
                ownerPredicate,
              ),
            ),
          scopedDb
            .select()
            .from(tables.rotationSettings)
            .where(
              and(
                subscriptionRotationWorkspacePredicate(input.workspaceId),
                eq(tables.rotationSettings.authorityScope, snapshot.scope),
                ownerMembershipId === null
                  ? isNull(tables.rotationSettings.ownerOrganizationMembershipId)
                  : eq(tables.rotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null),
        ]);
        const activeCredentialId = rotation?.activeCredentialId ?? null;
        const now = new Date();
        const eligibleAccounts =
          options.readCapacity && !input.upstreamModelId
            ? accounts.filter((account) => account.status === "active" && account.allocatorEnabled)
            : await eligibleSubscriptionAccounts(scopedDb, accounts, { ...input, now });
        const eligible = (account: SubscriptionCredentialMetadataRow) =>
          eligibleAccounts.some((row) => row.id === account.id);
        if (rotation?.rotationEnabled !== false) {
          return accounts.some(eligible);
        }
        return accounts.some((account) => account.id === activeCredentialId && eligible(account));
      },
    );
  }

  async function getSubscriptionAccountMetadata(
    db: Database,
    input: { workspaceId: string; subjectId: string; credentialId: string },
  ): Promise<SubscriptionAccountMetadata | null> {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const [row] = await scopedDb
          .select(credentialMetadataColumns)
          .from(tables.credentials)
          .where(
            and(
              subscriptionCredentialWorkspacePredicate(input.workspaceId),
              eq(tables.credentials.id, input.credentialId),
            ),
          )
          .limit(1);
        return row ? subscriptionAccountMetadataFromRow(row) : null;
      },
    );
  }

  async function getSubscriptionAccountAuthoritySnapshot(
    db: Database,
    input: { workspaceId: string; subjectId: string; credentialId: string },
  ): Promise<SubscriptionAuthoritySnapshot | null> {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const [row] = await scopedDb
          .select({
            authorityScope: tables.credentials.authorityScope,
            authorityGeneration: tables.credentials.organizationUserResourceAuthorityGeneration,
          })
          .from(tables.credentials)
          .where(
            and(
              subscriptionCredentialWorkspacePredicate(input.workspaceId),
              eq(tables.credentials.id, input.credentialId),
            ),
          )
          .limit(1);
        if (!row) return null;
        if (row.authorityScope === "organization") return { version: 1, scope: "organization" };
        return row.authorityScope === "workspace"
          ? WORKSPACE_AUTHORITY_SNAPSHOT_V1
          : SubscriptionAuthoritySnapshotV1.parse({
              version: 1,
              scope: "user",
              authorityGeneration: row.authorityGeneration,
            });
      },
    );
  }

  /**
   * Resolve the provider-account authority frozen on a newly accepted human turn.
   * Workspace authority is the default. A caller's private pool becomes effective
   * only after that exact pool has an active credential pointer, which is set by
   * the caller's explicit private connection/activation action.
   */
  async function resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance(
    db: Database,
    input: { workspaceId: string; subjectId: string },
  ): Promise<SubscriptionAuthoritySnapshot> {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        return await resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptanceInTransaction(
          scopedDb,
          {
            workspaceId: input.workspaceId,
          },
        );
      },
    );
  }

  /** Transaction-local acceptance resolver. The caller must already have set the
   * exact authenticated subject GUC on this same transaction. */
  async function resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptanceInTransaction(
    db: Database,
    input: { workspaceId: string },
  ): Promise<SubscriptionAuthoritySnapshot> {
    const [row] = await db
      .select({
        authorityGeneration: tables.credentials.organizationUserResourceAuthorityGeneration,
      })
      .from(tables.rotationSettings)
      .innerJoin(
        tables.credentials,
        and(
          eq(tables.credentials.id, tables.rotationSettings.activeCredentialId),
          eq(tables.credentials.workspaceId, tables.rotationSettings.workspaceId),
          eq(tables.credentials.authorityScope, "user"),
          eq(tables.credentials.status, "active"),
        ),
      )
      .where(
        and(
          subscriptionRotationWorkspacePredicate(input.workspaceId),
          eq(tables.rotationSettings.authorityScope, "user"),
        ),
      )
      .limit(1);
    if (!row) {
      const [local] = await db
        .select({ id: tables.credentials.id })
        .from(tables.credentials)
        .where(
          and(
            eq(tables.credentials.workspaceId, input.workspaceId),
            eq(tables.credentials.authorityScope, "workspace"),
          ),
        )
        .limit(1);
      if (!local) {
        const [organization] = await db
          .select({ id: tables.rotationSettings.id })
          .from(tables.rotationSettings)
          .where(
            and(
              isNull(tables.rotationSettings.workspaceId),
              eq(tables.rotationSettings.authorityScope, "organization"),
              sql`${tables.rotationSettings.activeCredentialId} is not null`,
            ),
          )
          .limit(1);
        if (organization) return { version: 1, scope: "organization" };
      }
      return WORKSPACE_AUTHORITY_SNAPSHOT_V1;
    }
    return SubscriptionAuthoritySnapshotV1.parse({
      version: 1,
      scope: "user",
      authorityGeneration: row.authorityGeneration,
    });
  }

  async function updateSubscriptionAccountSettings(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      credentialId: string;
      expectedVersion: number;
      label?: string | null;
      allocatorEnabled?: boolean;
    },
  ): Promise<SubscriptionAccountMetadata> {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const [row] = await scopedDb
          .update(tables.credentials)
          .set({
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.allocatorEnabled !== undefined
              ? {
                  allocatorEnabled: input.allocatorEnabled,
                  allocatorVersion: sql`${tables.credentials.allocatorVersion} + 1`,
                }
              : {}),
            version: sql`${tables.credentials.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              subscriptionCredentialWorkspacePredicate(input.workspaceId),
              eq(tables.credentials.id, input.credentialId),
              eq(tables.credentials.version, input.expectedVersion),
            ),
          )
          .returning(credentialMetadataColumns);
        if (!row) throw new Error(label + " subscription account settings changed");
        return subscriptionAccountMetadataFromRow(row);
      },
    );
  }

  type SubscriptionAllocatorUpdateResult =
    | {
        kind: "updated" | "unchanged" | "conflict";
        allocatorEnabled: boolean;
        allocatorVersion: number;
        allocatorUpdatedAt: Date | null;
      }
    | { kind: "not_found" };

  async function updateSubscriptionAllocatorEligibility(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      credentialId: string;
      enabled: boolean;
      expectedVersion: number;
    },
  ): Promise<SubscriptionAllocatorUpdateResult> {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) =>
        await scopedDb.transaction(async (tx) => {
          const [row] = await tx
            .select({
              allocatorEnabled: tables.credentials.allocatorEnabled,
              allocatorVersion: tables.credentials.allocatorVersion,
              allocatorUpdatedAt: tables.credentials.allocatorUpdatedAt,
            })
            .from(tables.credentials)
            .where(
              and(
                subscriptionCredentialWorkspacePredicate(input.workspaceId),
                eq(tables.credentials.id, input.credentialId),
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
            .update(tables.credentials)
            .set({
              allocatorEnabled: input.enabled,
              allocatorVersion: sql`${tables.credentials.allocatorVersion} + 1`,
              allocatorUpdatedAt: changedAt,
            })
            .where(
              and(
                subscriptionCredentialWorkspacePredicate(input.workspaceId),
                eq(tables.credentials.id, input.credentialId),
                eq(tables.credentials.allocatorVersion, input.expectedVersion),
              ),
            )
            .returning({
              allocatorEnabled: tables.credentials.allocatorEnabled,
              allocatorVersion: tables.credentials.allocatorVersion,
              allocatorUpdatedAt: tables.credentials.allocatorUpdatedAt,
            });
          if (!updated) throw new Error(label + " allocator row changed while locked");
          return { kind: "updated", ...updated } as const;
        }),
    );
  }

  async function renameSubscriptionAccount(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      credentialId: string;
      label: string | null;
    },
  ): Promise<SubscriptionAccountMetadata | null> {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const [row] = await scopedDb
          .update(tables.credentials)
          .set({
            label: input.label,
            version:
              options.metadataIncrementsVersion === false
                ? tables.credentials.version
                : sql`${tables.credentials.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              subscriptionCredentialWorkspacePredicate(input.workspaceId),
              eq(tables.credentials.id, input.credentialId),
            ),
          )
          .returning(credentialMetadataColumns);
        return row ? subscriptionAccountMetadataFromRow(row) : null;
      },
    );
  }

  async function disconnectSubscriptionCredential(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      credentialId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
    },
  ): Promise<boolean> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const rows = await rawRows<{ disconnected: boolean }>(
          scopedDb,
          sql`select ${sql.identifier("disconnect_xai_subscription_credential".replace("xai", provider))}(
          ${input.accountId}::uuid, ${input.workspaceId}::uuid,
          ${input.subjectId}, ${input.credentialId}::uuid,
          ${JSON.stringify(snapshot)}::jsonb
        ) as disconnected`,
        );
        return rows[0]?.disconnected === true;
      },
    );
  }

  /** Recheck the exact accepted pool before reading a credential or its telemetry. */
  async function withAuthorizedSubscriptionCredential<T>(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      credentialId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      lock?: boolean;
    },
    use: (
      db: Database,
      row: SubscriptionCredentialMetadataRow & {
        accountId: string;
        credentialEncrypted: string;
      },
    ) => Promise<T>,
  ): Promise<T> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const authorized = await rawRows<{ id: string }>(
          scopedDb,
          sql`select id from ${sql.identifier("revalidate_xai_subscription_authority".replace("xai", provider))}(
          ${input.workspaceId}::uuid, ${input.subjectId}, ${input.credentialId}::uuid,
          ${JSON.stringify(snapshot)}::jsonb)`,
        );
        if (!authorized[0])
          throw new Error(label + " provider-account authority is no longer active");
        const query = scopedDb
          .select({
            ...credentialMetadataColumns,
            accountId: tables.credentials.accountId,
            credentialEncrypted: tables.credentials.credentialEncrypted,
          })
          .from(tables.credentials)
          .where(
            and(
              subscriptionCredentialWorkspacePredicate(input.workspaceId),
              eq(tables.credentials.id, input.credentialId),
              eq(tables.credentials.status, "active"),
            ),
          )
          .limit(1);
        const [row] = await (input.lock ? query.for("update") : query);
        if (!row) throw new Error(label + " credential is unavailable");
        return await use(scopedDb, row);
      },
    );
  }

  async function materializeSubscriptionCredentialForRun(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      credentialId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      encryptionKey: Uint8Array;
    },
  ): Promise<SubscriptionCredentialForRun> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withAuthorizedSubscriptionCredential(db, input, async (_db, row) => ({
      ...subscriptionAccountMetadataFromRow(row),
      secret: parseSecret(decryptEnvironmentValue(input.encryptionKey, row.credentialEncrypted)),
      authoritySnapshot: snapshot,
    }));
  }

  type SubscriptionSerializedCredentialRefreshResult = {
    credential: SubscriptionCredentialForRun;
    refreshed: boolean;
  };

  async function subscriptionAccountCapacity<Row extends SubscriptionCredentialMetadataRow>(
    db: Database,
    candidates: readonly Row[],
    input: { modelId?: string; upstreamModelId?: string; now: Date },
  ): Promise<{ eligible: Row[]; capacity: ReadonlyMap<string, SubscriptionAccountCapacity> }> {
    const allowed = candidates.filter(
      (candidate) =>
        (input.modelId === undefined ||
          connectionModelAllowed(candidate.allowedModelIds, input.modelId)) &&
        candidate.status === "active" &&
        candidate.allocatorEnabled,
    );
    let capacity: ReadonlyMap<string, SubscriptionAccountCapacity>;
    if (!options.readCapacity) {
      capacity = new Map(
        allowed.map((candidate) => [
          candidate.id,
          {
            available: !candidate.exhaustedUntil || candidate.exhaustedUntil <= input.now,
            resetsAt:
              candidate.exhaustedUntil && candidate.exhaustedUntil > input.now
                ? candidate.exhaustedUntil
                : null,
          },
        ]),
      );
    } else {
      if (!input.upstreamModelId?.trim())
        throw new Error(label + " quota selection requires an upstream model id");
      capacity =
        allowed.length === 0
          ? new Map()
          : await options.readCapacity(db, {
              candidates: allowed.map(({ id, version, exhaustedUntil }) => ({
                id,
                version,
                exhaustedUntil,
              })),
              upstreamModelId: input.upstreamModelId,
              now: input.now,
            });
    }
    return {
      eligible: allowed.filter((candidate) => capacity.get(candidate.id)?.available === true),
      capacity,
    };
  }

  async function eligibleSubscriptionAccounts<Row extends SubscriptionCredentialMetadataRow>(
    db: Database,
    candidates: readonly Row[],
    input: { modelId?: string; upstreamModelId?: string; now: Date },
  ): Promise<Row[]> {
    return (await subscriptionAccountCapacity(db, candidates, input)).eligible;
  }

  function nextCapacityCheckAt(input: {
    candidates: readonly { id: string }[];
    capacity: ReadonlyMap<string, SubscriptionAccountCapacity>;
    rotationEnabled: boolean;
    activeCredentialId: string | null;
    pinnedCredentialId?: string | null;
    pinSource?: "manual" | "policy" | null;
    now: Date;
  }): Date | null {
    const candidates =
      input.pinnedCredentialId && input.pinSource !== "policy"
        ? input.candidates.filter((candidate) => candidate.id === input.pinnedCredentialId)
        : input.rotationEnabled
          ? input.candidates
          : input.candidates.filter((candidate) => candidate.id === input.activeCredentialId);
    const deadlines = candidates
      .map((candidate) => input.capacity.get(candidate.id))
      .filter(
        (capacity) =>
          capacity?.available === false && capacity.resetsAt && capacity.resetsAt > input.now,
      )
      .map((capacity) => capacity!.resetsAt!.getTime());
    return deadlines.length ? new Date(Math.min(...deadlines)) : null;
  }

  /**
   * Refresh one connected account under a database row lock.
   *
   * OAuth refresh tokens may rotate. Multiple sessions are allowed to share the
   * same account, so an unlocked read-refresh-write sequence can make one
   * successful refresh invalidate every other in-flight refresh. This operation
   * re-reads the secret after acquiring the lock and skips the provider call when
   * another request already installed a newer token pair.
   */
  async function refreshSubscriptionCredentialSerialized(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      credentialId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      encryptionKey: Uint8Array;
      observedAccessToken: string | undefined;
      observedRefreshToken: string | undefined;
      refresh: (current: SubscriptionCredentialForRun) => Promise<{
        secret: SubscriptionCredentialSecret;
        expiresAt: Date | null;
      }>;
    },
  ): Promise<SubscriptionSerializedCredentialRefreshResult> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const authorized = await rawRows<{ id: string }>(
          scopedDb,
          sql`select id from ${sql.identifier("revalidate_xai_subscription_authority".replace("xai", provider))}(
        ${input.workspaceId}::uuid,
        ${input.subjectId},
        ${input.credentialId}::uuid,
        ${JSON.stringify(snapshot)}::jsonb
      )`,
        );
        if (!authorized[0])
          throw new Error(label + " provider-account authority is no longer active");

        return await refreshSubscriptionCredentialInTransaction(scopedDb, input, snapshot);
      },
    );
  }

  async function refreshSubscriptionCredentialInTransaction(
    scopedDb: Database,
    input: {
      accountId: string;
      workspaceId: string | null;
      subjectId: string;
      credentialId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      encryptionKey: Uint8Array;
      observedAccessToken: string | undefined;
      observedRefreshToken: string | undefined;
      refresh: (current: SubscriptionCredentialForRun) => Promise<{
        secret: SubscriptionCredentialSecret;
        expiresAt: Date | null;
      }>;
    },
    snapshot: SubscriptionAuthoritySnapshot,
  ): Promise<SubscriptionSerializedCredentialRefreshResult> {
    const [row] = await scopedDb
      .select({
        ...credentialMetadataColumns,
        credentialEncrypted: tables.credentials.credentialEncrypted,
      })
      .from(tables.credentials)
      .where(
        and(
          eq(tables.credentials.accountId, input.accountId),
          input.workspaceId === null
            ? and(
                isNull(tables.credentials.workspaceId),
                eq(tables.credentials.authorityScope, "organization"),
              )
            : subscriptionCredentialWorkspacePredicate(input.workspaceId),
          eq(tables.credentials.id, input.credentialId),
          eq(tables.credentials.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) throw new Error(label + " credential is unavailable");

    const currentSecret = parseSecret(
      decryptEnvironmentValue(input.encryptionKey, row.credentialEncrypted),
    );
    const current: SubscriptionCredentialForRun = {
      ...subscriptionAccountMetadataFromRow(row),
      secret: currentSecret,
      authoritySnapshot: snapshot,
    };
    if (
      options.accessToken(currentSecret) !== input.observedAccessToken ||
      options.refreshToken(currentSecret) !== input.observedRefreshToken
    ) {
      return { credential: current, refreshed: false };
    }

    const next = await input.refresh(current);
    assertSecret(next.secret);
    const credentialEncrypted = encryptEnvironmentValue(
      input.encryptionKey,
      JSON.stringify(next.secret),
    );
    const [updated] = await scopedDb
      .update(tables.credentials)
      .set({
        credentialEncrypted,
        expiresAt: next.expiresAt,
        lastRefreshAt: new Date(),
        status: "active",
        lastError: null,
        version:
          options.refreshIncrementsVersion === false
            ? row.version
            : sql`${tables.credentials.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tables.credentials.accountId, input.accountId),
          input.workspaceId === null
            ? and(
                isNull(tables.credentials.workspaceId),
                eq(tables.credentials.authorityScope, "organization"),
              )
            : subscriptionCredentialWorkspacePredicate(input.workspaceId),
          eq(tables.credentials.id, input.credentialId),
        ),
      )
      .returning(credentialMetadataColumns);
    if (!updated) throw new Error(label + " credential refresh lost its authority fence");
    return {
      credential: {
        ...subscriptionAccountMetadataFromRow(updated),
        secret: next.secret,
        authoritySnapshot: snapshot,
      },
      refreshed: true,
    };
  }

  /** Organization administration and live worker authority remain separate entry points. */
  async function refreshOrganizationSubscriptionCredentialSerialized(
    db: Database,
    input: {
      accountId: string;
      workspaceId: null;
      subjectId: string;
      credentialId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      encryptionKey: Uint8Array;
      observedAccessToken: string | undefined;
      observedRefreshToken: string | undefined;
      refresh: (current: SubscriptionCredentialForRun) => Promise<{
        secret: SubscriptionCredentialSecret;
        expiresAt: Date | null;
      }>;
    },
  ): Promise<SubscriptionSerializedCredentialRefreshResult> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    if (snapshot.scope !== "organization")
      throw new Error("Organization subscription authority is required");
    return withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      await tx.execute(
        sql`select get_organization_administration_overview(${input.accountId}::uuid,${input.subjectId})`,
      );
      return refreshSubscriptionCredentialInTransaction(tx, input, snapshot);
    });
  }

  async function acquireSubscriptionCredentialLease(
    db: Database,
    input: {
      modelId?: string;
      upstreamModelId?: string;
      accountId: string;
      workspaceId: string;
      subjectId: string;
      sessionId: string;
      turnId: string;
      holderId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      pinnedCredentialId?: string | null;
      pinSource?: "manual" | "policy" | null;
      now?: Date;
      leaseTtlMs?: number;
    },
  ): Promise<SubscriptionCredentialLeaseResult> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    const leaseTtlMs = input.leaseTtlMs ?? CREDENTIAL_LEASE_TTL_MS;
    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
      throw new Error(label + " credential lease TTL must be positive");
    }
    if (!input.holderId.trim()) {
      throw new Error(label + " credential lease holder id is required");
    }
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) =>
        await scopedDb.transaction(async (tx) => {
          await assertTurnAuthoritySnapshot(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            turnId: input.turnId,
            authoritySnapshot: snapshot,
          });
          const ownerMembershipId = await resolvePoolOwnerMembershipId(tx, {
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            authoritySnapshot: snapshot,
          });

          if (snapshot.scope !== "organization")
            await tx
              .insert(tables.rotationSettings)
              .values({
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                authorityScope: snapshot.scope,
                ownerOrganizationMembershipId: ownerMembershipId,
              })
              .onConflictDoNothing();
          const [settings] = await tx
            .select()
            .from(tables.rotationSettings)
            .where(
              and(
                subscriptionRotationWorkspacePredicate(input.workspaceId),
                eq(tables.rotationSettings.authorityScope, snapshot.scope),
                ownerMembershipId === null
                  ? isNull(tables.rotationSettings.ownerOrganizationMembershipId)
                  : eq(tables.rotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
              ),
            )
            .for("update")
            .limit(1);
          if (!settings) throw new Error(label + " rotation settings are unavailable");

          // Pool and retained-lease contention must not consume the new TTL or
          // let an expired holder keep its generation. Sample the DB clock
          // only after both locks; explicit clocks are deterministic test input.
          const [retained] = await tx
            .select()
            .from(tables.credentialLeases)
            .where(
              and(
                eq(tables.credentialLeases.workspaceId, input.workspaceId),
                eq(tables.credentialLeases.turnId, input.turnId),
              ),
            )
            .for("update")
            .limit(1);
          // Expired leases from other turns are housekeeping, never a reason
          // to wait while holding this turn's lease/pool locks.
          const cleanupNow = input.now ?? sql`clock_timestamp()`;
          await tx.delete(tables.credentialLeases).where(
            inArray(
              tables.credentialLeases.id,
              tx
                .select({ id: tables.credentialLeases.id })
                .from(tables.credentialLeases)
                .where(
                  and(
                    eq(tables.credentialLeases.workspaceId, input.workspaceId),
                    lte(tables.credentialLeases.leasedUntil, cleanupNow),
                  ),
                )
                .for("update", { skipLocked: true }),
            ),
          );
          const clock = input.now
            ? undefined
            : await tx.execute(sql`select clock_timestamp() as observed_at`);
          const now = input.now ?? new Date(clock![0]!.observed_at as string);
          const existing = retained && retained.leasedUntil > now ? retained : undefined;
          if (retained && !existing)
            await tx
              .delete(tables.credentialLeases)
              .where(eq(tables.credentialLeases.id, retained.id));
          const freshDeadline = input.now
            ? new Date(input.now.getTime() + leaseTtlMs)
            : sql`clock_timestamp() + (${leaseTtlMs} * interval '1 millisecond')`;

          const candidates = await tx
            .select(credentialAllocationColumns)
            .from(tables.credentials)
            .where(
              and(
                subscriptionCredentialWorkspacePredicate(input.workspaceId),
                eq(tables.credentials.accountId, input.accountId),
                eq(tables.credentials.authorityScope, snapshot.scope),
                ownerMembershipId === null
                  ? isNull(tables.credentials.ownerOrganizationMembershipId)
                  : eq(tables.credentials.ownerOrganizationMembershipId, ownerMembershipId),
              ),
            )
            .orderBy(asc(tables.credentials.createdAt), asc(tables.credentials.id));
          const { eligible, capacity } = await subscriptionAccountCapacity(tx, candidates, {
            ...input,
            now,
          });
          const activeCredentialId =
            snapshot.scope === "organization"
              ? assignedConnectionDefault(settings.activeCredentialId, candidates)
              : settings.activeCredentialId;
          const nextCheckAt = nextCapacityCheckAt({
            ...input,
            candidates,
            capacity,
            rotationEnabled: settings.rotationEnabled,
            activeCredentialId,
            now,
          });
          let mayReuse = Boolean(existing);
          if (existing && options.readCapacity) {
            const manualPinMatches =
              !input.pinnedCredentialId ||
              input.pinSource === "policy" ||
              input.pinnedCredentialId === existing.credentialId;
            const primaryMatches =
              settings.rotationEnabled ||
              activeCredentialId === existing.credentialId ||
              (input.pinnedCredentialId === existing.credentialId && input.pinSource !== "policy");
            mayReuse =
              eligible.some((candidate) => candidate.id === existing.credentialId) &&
              manualPinMatches &&
              primaryMatches;
            if (!mayReuse)
              await tx
                .delete(tables.credentialLeases)
                .where(
                  and(
                    eq(tables.credentialLeases.id, existing.id),
                    eq(tables.credentialLeases.holderId, existing.holderId),
                    eq(tables.credentialLeases.generation, existing.generation),
                  ),
                );
          }
          if (existing && mayReuse) {
            const [updated] = await tx
              .update(tables.credentialLeases)
              .set({
                holderId: input.holderId,
                generation:
                  existing.holderId === input.holderId
                    ? sql`CASE WHEN ${tables.credentialLeases.leasedUntil} > ${input.now ?? sql`clock_timestamp()`} THEN ${tables.credentialLeases.generation} ELSE ${tables.credentialLeases.generation} + 1 END`
                    : existing.generation + 1,
                leasedUntil: freshDeadline,
                updatedAt: now,
              })
              .where(eq(tables.credentialLeases.id, existing.id))
              .returning();

            return {
              credentialId: updated!.credentialId,
              rotationEnabled: settings.rotationEnabled,
              reused: true,
              holderId: updated!.holderId,
              generation: updated!.generation,
              leasedUntil: updated!.leasedUntil,
              nextCheckAt,
              accounts: candidates.map(subscriptionAccountMetadataFromRow),
            };
          }

          const selected = selectSubscriptionAccount({
            sessionId: input.sessionId,
            eligible,
            rotationEnabled: settings.rotationEnabled,
            activeCredentialId:
              snapshot.scope === "organization"
                ? assignedConnectionDefault(settings.activeCredentialId, candidates)
                : settings.activeCredentialId,
            pinnedCredentialId: input.pinnedCredentialId ?? null,
            pinSource: input.pinSource ?? null,
          });
          if (!selected) {
            return {
              credentialId: null,
              rotationEnabled: settings.rotationEnabled,
              reused: false,
              holderId: null,
              generation: null,
              leasedUntil: null,
              nextCheckAt,
              accounts: candidates.map(subscriptionAccountMetadataFromRow),
            };
          }
          await tx
            .update(tables.credentials)
            .set({
              selectionCount: sql`${tables.credentials.selectionCount} + 1`,
              lastSelectedAt: now,
              updatedAt: now,
            })
            .where(eq(tables.credentials.id, selected.id));
          // A session policy/manual home must never move the workspace-global
          // active pointer. A missing pointer is bootstrapped once for rotation-off
          // fallback and UI state, but healthy sharded turns never churn it.
          if (settings.activeCredentialId === null && snapshot.scope !== "organization") {
            await tx
              .update(tables.rotationSettings)
              .set({
                activeCredentialId: selected.id,
                version: sql`${tables.rotationSettings.version} + 1`,
                updatedAt: now,
              })
              .where(eq(tables.rotationSettings.id, settings.id));
          }
          const [lease] = await tx
            .insert(tables.credentialLeases)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              authorityScope: snapshot.scope,
              ownerOrganizationMembershipId: ownerMembershipId,
              credentialId: selected.id,
              turnId: input.turnId,
              holderId: input.holderId,
              generation: retained ? retained.generation + 1 : 1,
              leasedUntil: freshDeadline,
            })
            .returning();
          return {
            credentialId: selected.id,
            rotationEnabled: settings.rotationEnabled,
            reused: false,
            holderId: lease!.holderId,
            generation: lease!.generation,
            leasedUntil: lease!.leasedUntil,
            nextCheckAt,
            accounts: candidates.map(subscriptionAccountMetadataFromRow),
          };
        }),
    );
  }

  /**
   * Select an authorized connected account for a non-turn operation (voice,
   * transcription, media). Rotation uses the same stable session/request shard
   * as turns, but does not create a capacity lease: one account may serve many
   * concurrent upstream sessions just like Codex subscriptions.
   */
  async function selectSubscriptionCredentialForUse(
    db: Database,
    input: {
      modelId?: string;
      upstreamModelId?: string;
      accountId: string;
      workspaceId: string;
      subjectId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      shardKey: string;
      pinnedCredentialId?: string | null;
      pinSource?: "manual" | "policy" | null;
      now?: Date;
    },
  ): Promise<{
    credentialId: string | null;
    rotationEnabled: boolean;
    nextCheckAt?: Date | null;
    accounts: SubscriptionAccountMetadata[];
  }> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    const now = input.now ?? new Date();
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) =>
        await scopedDb.transaction(async (tx) => {
          const ownerMembershipId = await resolvePoolOwnerMembershipId(tx, {
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            authoritySnapshot: snapshot,
          });
          if (snapshot.scope !== "organization")
            await tx
              .insert(tables.rotationSettings)
              .values({
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                authorityScope: snapshot.scope,
                ownerOrganizationMembershipId: ownerMembershipId,
              })
              .onConflictDoNothing();
          const [settings] = await tx
            .select()
            .from(tables.rotationSettings)
            .where(
              and(
                subscriptionRotationWorkspacePredicate(input.workspaceId),
                eq(tables.rotationSettings.authorityScope, snapshot.scope),
                ownerMembershipId === null
                  ? isNull(tables.rotationSettings.ownerOrganizationMembershipId)
                  : eq(tables.rotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
              ),
            )
            .limit(1);
          if (!settings) throw new Error(label + " rotation settings are unavailable");
          const candidates = await tx
            .select(credentialAllocationColumns)
            .from(tables.credentials)
            .where(
              and(
                subscriptionCredentialWorkspacePredicate(input.workspaceId),
                eq(tables.credentials.accountId, input.accountId),
                eq(tables.credentials.authorityScope, snapshot.scope),
                ownerMembershipId === null
                  ? isNull(tables.credentials.ownerOrganizationMembershipId)
                  : eq(tables.credentials.ownerOrganizationMembershipId, ownerMembershipId),
              ),
            )
            .orderBy(asc(tables.credentials.createdAt), asc(tables.credentials.id));
          const { eligible, capacity } = await subscriptionAccountCapacity(tx, candidates, {
            ...input,
            now,
          });
          const activeCredentialId =
            snapshot.scope === "organization"
              ? assignedConnectionDefault(settings.activeCredentialId, candidates)
              : settings.activeCredentialId;
          const nextCheckAt = nextCapacityCheckAt({
            ...input,
            candidates,
            capacity,
            rotationEnabled: settings.rotationEnabled,
            activeCredentialId,
            now,
          });
          const selected = selectSubscriptionAccount({
            sessionId: input.shardKey,
            eligible,
            rotationEnabled: settings.rotationEnabled,
            activeCredentialId:
              snapshot.scope === "organization"
                ? assignedConnectionDefault(settings.activeCredentialId, candidates)
                : settings.activeCredentialId,
            pinnedCredentialId: input.pinnedCredentialId ?? null,
            pinSource: input.pinSource ?? null,
          });
          return {
            credentialId: selected?.id ?? null,
            rotationEnabled: settings.rotationEnabled,
            nextCheckAt,
            accounts: candidates.map(subscriptionAccountMetadataFromRow),
          };
        }),
    );
  }

  async function releaseSubscriptionCredentialLease(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      turnId: string;
      holderId: string;
      generation: number;
    },
  ): Promise<boolean> {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const deleted = await scopedDb
          .delete(tables.credentialLeases)
          .where(
            and(
              eq(tables.credentialLeases.workspaceId, input.workspaceId),
              eq(tables.credentialLeases.turnId, input.turnId),
              eq(tables.credentialLeases.holderId, input.holderId),
              eq(tables.credentialLeases.generation, input.generation),
            ),
          )
          .returning({ id: tables.credentialLeases.id });
        return deleted.length === 1;
      },
    );
  }

  async function heartbeatSubscriptionCredentialLeaseUntil(
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
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        return heartbeatPoolCredentialLeaseUntil(scopedDb, options.leaseTable, {
          ...input,
          ttlMs: input.leaseTtlMs ?? CREDENTIAL_LEASE_TTL_MS,
        });
      },
    );
  }

  async function getSubscriptionRotationSettings(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
    },
  ): Promise<typeof tables.rotationSettings.$inferSelect | null> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const ownerMembershipId = await resolvePoolOwnerMembershipId(scopedDb, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authoritySnapshot: snapshot,
        });
        const rows = await scopedDb
          .select()
          .from(tables.rotationSettings)
          .where(
            and(
              subscriptionRotationWorkspacePredicate(input.workspaceId),
              eq(tables.rotationSettings.authorityScope, snapshot.scope),
              ownerMembershipId === null
                ? isNull(tables.rotationSettings.ownerOrganizationMembershipId)
                : eq(tables.rotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
            ),
          );
        const row = rows[0];
        if (row && snapshot.scope === "organization") {
          const accounts = (await listSubscriptionAccountsMetadata(scopedDb, input)).filter(
            (account) => account.scope === "organization",
          );
          return {
            ...row,
            activeCredentialId: assignedConnectionDefault(row.activeCredentialId, accounts),
          };
        }
        return row ?? null;
      },
    );
  }

  async function ensureSubscriptionRotationSettings(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
    },
  ): Promise<typeof tables.rotationSettings.$inferSelect> {
    if (input.authoritySnapshot.scope === "organization") {
      const current = await getSubscriptionRotationSettings(db, input);
      if (!current)
        throw new Error("Organization " + options.displayName + " settings are unavailable");
      return current;
    }
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const ownerMembershipId = await resolvePoolOwnerMembershipId(scopedDb, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authoritySnapshot: snapshot,
        });
        const [row] = await scopedDb
          .insert(tables.rotationSettings)
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
          .from(tables.rotationSettings)
          .where(
            and(
              subscriptionRotationWorkspacePredicate(input.workspaceId),
              eq(tables.rotationSettings.authorityScope, snapshot.scope),
              ownerMembershipId === null
                ? isNull(tables.rotationSettings.ownerOrganizationMembershipId)
                : eq(tables.rotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
            ),
          )
          .limit(1);
        if (!current) throw new Error(label + " rotation settings are unavailable");
        return current;
      },
    );
  }

  async function setActiveSubscriptionCredential(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      credentialId: string;
    },
  ): Promise<boolean> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) =>
        await scopedDb.transaction(async (tx) => {
          const ownerMembershipId = await resolvePoolOwnerMembershipId(tx, {
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            authoritySnapshot: snapshot,
          });
          await assertCredentialInPool(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            credentialId: input.credentialId,
            authorityScope: snapshot.scope,
            ownerMembershipId,
          });
          const [credential] = await tx
            .select({ status: tables.credentials.status })
            .from(tables.credentials)
            .where(eq(tables.credentials.id, input.credentialId))
            .limit(1);
          if (!credential || credential.status !== "active") return false;
          if (snapshot.scope !== "organization")
            await tx
              .insert(tables.rotationSettings)
              .values({
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                authorityScope: snapshot.scope,
                ownerOrganizationMembershipId: ownerMembershipId,
                activeCredentialId: input.credentialId,
              })
              .onConflictDoUpdate({
                target: [
                  tables.rotationSettings.accountId,
                  tables.rotationSettings.workspaceId,
                  tables.rotationSettings.authorityScope,
                  tables.rotationSettings.ownerOrganizationMembershipId,
                ],
                set: {
                  activeCredentialId: input.credentialId,
                  version: sql`${tables.rotationSettings.version} + 1`,
                  updatedAt: new Date(),
                },
              });
          if (snapshot.scope === "workspace") {
            // Workspace is the deliberate default. Selecting a workspace account
            // also opts the current subject out of their private pool; FORCE RLS
            // limits this update to that subject's visible user-scoped row.
            await tx
              .update(tables.rotationSettings)
              .set({
                activeCredentialId: null,
                version: sql`${tables.rotationSettings.version} + 1`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  subscriptionRotationWorkspacePredicate(input.workspaceId),
                  eq(tables.rotationSettings.authorityScope, "user"),
                ),
              );
          }
          return true;
        }),
    );
  }

  async function setInitialActiveSubscriptionCredential(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      credentialId: string;
    },
  ): Promise<boolean> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) =>
        await scopedDb.transaction(async (tx) => {
          const ownerMembershipId = await resolvePoolOwnerMembershipId(tx, {
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            authoritySnapshot: snapshot,
          });
          await assertCredentialInPool(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            credentialId: input.credentialId,
            authorityScope: snapshot.scope,
            ownerMembershipId,
          });
          if (snapshot.scope !== "organization")
            await tx
              .insert(tables.rotationSettings)
              .values({
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                authorityScope: snapshot.scope,
                ownerOrganizationMembershipId: ownerMembershipId,
              })
              .onConflictDoNothing();
          const [updated] = await tx
            .update(tables.rotationSettings)
            .set({
              activeCredentialId: input.credentialId,
              version: sql`${tables.rotationSettings.version} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                subscriptionRotationWorkspacePredicate(input.workspaceId),
                eq(tables.rotationSettings.authorityScope, snapshot.scope),
                ownerMembershipId === null
                  ? isNull(tables.rotationSettings.ownerOrganizationMembershipId)
                  : eq(tables.rotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
                isNull(tables.rotationSettings.activeCredentialId),
              ),
            )
            .returning({ id: tables.rotationSettings.id });
          return updated !== undefined;
        }),
    );
  }

  async function disconnectSubscriptionCredentialAndRepick(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      credentialId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
    },
  ): Promise<{ disconnected: boolean; newActiveCredentialId: string | null }> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) =>
        await scopedDb.transaction(async (tx) => {
          const ownerMembershipId = await resolvePoolOwnerMembershipId(tx, {
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            authoritySnapshot: snapshot,
          });
          const disconnected = await disconnectSubscriptionCredential(tx, input);
          if (!disconnected) return { disconnected: false, newActiveCredentialId: null };
          const [settings] = await tx
            .select()
            .from(tables.rotationSettings)
            .where(
              and(
                subscriptionRotationWorkspacePredicate(input.workspaceId),
                eq(tables.rotationSettings.authorityScope, snapshot.scope),
                ownerMembershipId === null
                  ? isNull(tables.rotationSettings.ownerOrganizationMembershipId)
                  : eq(tables.rotationSettings.ownerOrganizationMembershipId, ownerMembershipId),
              ),
            )
            .for("update")
            .limit(1);
          if (!settings) return { disconnected: true, newActiveCredentialId: null };
          if (settings.activeCredentialId !== null) {
            return { disconnected: true, newActiveCredentialId: settings.activeCredentialId };
          }
          const [replacement] = await tx
            .select({ id: tables.credentials.id })
            .from(tables.credentials)
            .where(
              and(
                eq(tables.credentials.accountId, input.accountId),
                subscriptionCredentialWorkspacePredicate(input.workspaceId),
                eq(tables.credentials.authorityScope, snapshot.scope),
                ownerMembershipId === null
                  ? isNull(tables.credentials.ownerOrganizationMembershipId)
                  : eq(tables.credentials.ownerOrganizationMembershipId, ownerMembershipId),
                eq(tables.credentials.status, "active"),
              ),
            )
            .orderBy(asc(tables.credentials.createdAt), asc(tables.credentials.id))
            .limit(1);
          await tx
            .update(tables.rotationSettings)
            .set({
              activeCredentialId: replacement?.id ?? null,
              version: sql`${tables.rotationSettings.version} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(tables.rotationSettings.id, settings.id));
          return { disconnected: true, newActiveCredentialId: replacement?.id ?? null };
        }),
    );
  }

  async function updateSubscriptionRotationSettings(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      expectedVersion: number;
      rotationEnabled: boolean;
    },
  ): Promise<typeof tables.rotationSettings.$inferSelect> {
    const current = await getSubscriptionRotationSettings(db, input);
    if (!current || current.version !== input.expectedVersion) {
      throw new Error(label + " rotation settings changed");
    }
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const [row] = await scopedDb
          .update(tables.rotationSettings)
          .set({
            rotationEnabled: input.rotationEnabled,
            version: sql`${tables.rotationSettings.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tables.rotationSettings.id, current.id),
              eq(tables.rotationSettings.version, input.expectedVersion),
            ),
          )
          .returning();
        if (!row) throw new Error(label + " rotation settings changed");
        return row;
      },
    );
  }

  async function setSubscriptionSessionAccountPin(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      sessionId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      credentialId: string | null;
      pinSource: "manual" | "policy" | null;
      /** undefined = unconditional human write; null = row must not exist. */
      expectedVersion?: number | null;
    },
  ): Promise<typeof tables.sessionAccountPins.$inferSelect> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const ownerMembershipId = await resolvePoolOwnerMembershipId(scopedDb, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authoritySnapshot: snapshot,
        });
        if (input.credentialId) {
          await assertCredentialInPool(scopedDb, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            credentialId: input.credentialId,
            authorityScope: snapshot.scope,
            ownerMembershipId,
          });
        }
        const [row] = await scopedDb
          .insert(tables.sessionAccountPins)
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
              tables.sessionAccountPins.workspaceId,
              tables.sessionAccountPins.sessionId,
              tables.sessionAccountPins.authorityScope,
              tables.sessionAccountPins.ownerOrganizationMembershipId,
            ],
            set: {
              pinnedCredentialId: input.credentialId,
              pinSource: input.credentialId ? input.pinSource : null,
              version: sql`${tables.sessionAccountPins.version} + 1`,
              updatedAt: new Date(),
            },
            ...(input.expectedVersion !== undefined
              ? {
                  setWhere:
                    input.expectedVersion === null
                      ? sql`false`
                      : eq(tables.sessionAccountPins.version, input.expectedVersion),
                }
              : {}),
          })
          .returning();
        if (!row) throw new Error(label + " session pin changed");
        return row;
      },
    );
  }

  async function getSubscriptionSessionAccountPin(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      sessionId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
    },
  ): Promise<typeof tables.sessionAccountPins.$inferSelect | null> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const ownerMembershipId = await resolvePoolOwnerMembershipId(scopedDb, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authoritySnapshot: snapshot,
        });
        const [row] = await scopedDb
          .select()
          .from(tables.sessionAccountPins)
          .where(
            and(
              eq(tables.sessionAccountPins.workspaceId, input.workspaceId),
              eq(tables.sessionAccountPins.sessionId, input.sessionId),
              eq(tables.sessionAccountPins.authorityScope, snapshot.scope),
              ownerMembershipId === null
                ? isNull(tables.sessionAccountPins.ownerOrganizationMembershipId)
                : eq(tables.sessionAccountPins.ownerOrganizationMembershipId, ownerMembershipId),
            ),
          )
          .limit(1);
        return row ?? null;
      },
    );
  }

  async function recordSubscriptionSessionLastAccount(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      sessionId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      credentialId: string;
    },
  ): Promise<typeof tables.sessionAccountPins.$inferSelect> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const ownerMembershipId = await resolvePoolOwnerMembershipId(scopedDb, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authoritySnapshot: snapshot,
        });
        await assertCredentialInPool(scopedDb, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          credentialId: input.credentialId,
          authorityScope: snapshot.scope,
          ownerMembershipId,
        });
        const [row] = await scopedDb
          .insert(tables.sessionAccountPins)
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
              tables.sessionAccountPins.workspaceId,
              tables.sessionAccountPins.sessionId,
              tables.sessionAccountPins.authorityScope,
              tables.sessionAccountPins.ownerOrganizationMembershipId,
            ],
            set: {
              lastCredentialId: input.credentialId,
              version: sql`${tables.sessionAccountPins.version} + 1`,
              updatedAt: new Date(),
            },
          })
          .returning();
        return row!;
      },
    );
  }

  async function updateSubscriptionQuotaMetadata(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      credentialId: string;
      quotaUsedPercent: number | null;
      quotaResetAt: Date | null;
      quotaCheckedAt: Date;
      exhaustedUntil: Date | null;
      expectedExhaustedUntil?: Date | null;
      expectedQuotaCheckedAt?: Date | null;
    },
  ): Promise<boolean> {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const updated = await scopedDb
          .update(tables.credentials)
          .set({
            quotaUsedPercent: input.quotaUsedPercent,
            quotaResetAt: input.quotaResetAt,
            quotaCheckedAt: input.quotaCheckedAt,
            exhaustedUntil: input.exhaustedUntil,
            updatedAt: input.quotaCheckedAt,
          })
          .where(
            and(
              subscriptionCredentialWorkspacePredicate(input.workspaceId),
              eq(tables.credentials.id, input.credentialId),
              ...(input.expectedExhaustedUntil === undefined
                ? []
                : [
                    sql`${tables.credentials.exhaustedUntil} IS NOT DISTINCT FROM ${input.expectedExhaustedUntil?.toISOString() ?? null}::timestamptz`,
                    sql`${tables.credentials.quotaCheckedAt} IS NOT DISTINCT FROM ${input.expectedQuotaCheckedAt?.toISOString() ?? null}::timestamptz`,
                  ]),
            ),
          )
          .returning({ id: tables.credentials.id });
        return updated.length === 1;
      },
    );
  }

  async function wakeSubscriptionCapacityWaiters(
    db: Database,
    input: {
      workspaceId: string;
      subjectId: string;
      authoritySnapshot: SubscriptionAuthoritySnapshot;
      reason: string;
      now?: Date;
    },
  ): Promise<number> {
    const snapshot = SubscriptionAuthoritySnapshotV1.parse(input.authoritySnapshot);
    const now = input.now ?? new Date();
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        const ownerMembershipId = await resolvePoolOwnerMembershipId(scopedDb, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authoritySnapshot: snapshot,
        });
        const rows = await scopedDb
          .update(tables.capacityWaiters)
          .set({
            wakeRevision: sql`${tables.capacityWaiters.wakeRevision} + 1`,
            lastWakeReason: input.reason,
            nextCheckAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(tables.capacityWaiters.workspaceId, input.workspaceId),
              eq(tables.capacityWaiters.status, "waiting"),
              eq(tables.capacityWaiters.authorityScope, snapshot.scope),
              ownerMembershipId === null
                ? isNull(tables.capacityWaiters.ownerOrganizationMembershipId)
                : eq(tables.capacityWaiters.ownerOrganizationMembershipId, ownerMembershipId),
            ),
          )
          .returning({
            id: tables.capacityWaiters.id,
            accountId: tables.capacityWaiters.accountId,
            sessionId: tables.capacityWaiters.sessionId,
            workflowId: tables.capacityWaiters.workflowId,
          });
        for (const row of rows) {
          await scopedDb
            .insert(schema.sessionWorkflowWakeOutbox)
            .values({
              accountId: row.accountId,
              workspaceId: input.workspaceId,
              sessionId: row.sessionId,
              temporalWorkflowId: row.workflowId,
              reason: provider + "_capacity",
              nextAttemptAt: now,
            })
            .onConflictDoUpdate({
              target: schema.sessionWorkflowWakeOutbox.sessionId,
              set: {
                temporalWorkflowId: row.workflowId,
                wakeRevision: sql`${schema.sessionWorkflowWakeOutbox.wakeRevision} + 1`,
                reason: provider + "_capacity",
                attempts: 0,
                nextAttemptAt: sql`least(${schema.sessionWorkflowWakeOutbox.nextAttemptAt}, ${now.toISOString()}::timestamptz)`,
                lastError: null,
                updatedAt: now,
              },
            });
        }
        return rows.length;
      },
    );
  }

  /** Workspace runtime can read its local pools and the same organization's shared pool.
   * Account RLS remains authoritative; callers additionally filter exact frozen scope. */
  function subscriptionCredentialWorkspacePredicate(workspaceId: string) {
    return or(
      eq(tables.credentials.workspaceId, workspaceId),
      and(
        isNull(tables.credentials.workspaceId),
        eq(tables.credentials.authorityScope, "organization"),
      ),
    );
  }
  function subscriptionRotationWorkspacePredicate(workspaceId: string) {
    return or(
      eq(tables.rotationSettings.workspaceId, workspaceId),
      and(
        isNull(tables.rotationSettings.workspaceId),
        eq(tables.rotationSettings.authorityScope, "organization"),
      ),
    );
  }

  return {
    credentialMetadataColumns,
    credentialShardIndex,
    CREDENTIAL_LEASE_TTL_MS,
    SubscriptionAuthorityPoolInactiveError,
    subscriptionAccountMetadataFromRow,
    createSubscriptionCredential,
    upsertSubscriptionCredential,
    listSubscriptionAccountsMetadata,
    listSubscriptionAccountsMetadataForAuthority,
    workspaceSubscriptionActive,
    workspaceSubscriptionActiveForAuthority,
    getSubscriptionAccountMetadata,
    getSubscriptionAccountAuthoritySnapshot,
    resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance,
    resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptanceInTransaction,
    updateSubscriptionAccountSettings,
    updateSubscriptionAllocatorEligibility,
    renameSubscriptionAccount,
    disconnectSubscriptionCredential,
    withAuthorizedSubscriptionCredential,
    materializeSubscriptionCredentialForRun,
    refreshSubscriptionCredentialSerialized,
    refreshOrganizationSubscriptionCredentialSerialized,
    acquireSubscriptionCredentialLease,
    selectSubscriptionCredentialForUse,
    releaseSubscriptionCredentialLease,
    heartbeatSubscriptionCredentialLeaseUntil,
    getSubscriptionRotationSettings,
    ensureSubscriptionRotationSettings,
    setActiveSubscriptionCredential,
    setInitialActiveSubscriptionCredential,
    disconnectSubscriptionCredentialAndRepick,
    updateSubscriptionRotationSettings,
    setSubscriptionSessionAccountPin,
    getSubscriptionSessionAccountPin,
    recordSubscriptionSessionLastAccount,
    updateSubscriptionQuotaMetadata,
    wakeSubscriptionCapacityWaiters,
    subscriptionCredentialWorkspacePredicate,
    subscriptionRotationWorkspacePredicate,
  };
}
