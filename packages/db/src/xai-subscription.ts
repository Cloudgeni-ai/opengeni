import {
  WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
  XaiProviderAccountAuthoritySnapshotV1,
  type XaiProviderAccountAuthoritySnapshotV1 as XaiAuthoritySnapshot,
} from "@opengeni/contracts";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
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
  label: string | null;
  accountEmail: string | null;
  planType: string | null;
  status: XaiCredentialStatus;
  allocatorEnabled: boolean;
  version: number;
  allocatorVersion: number;
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

function metadataFromRow(
  row: typeof schema.xaiSubscriptionCredentials.$inferSelect,
): XaiSubscriptionAccountMetadata {
  return {
    id: row.id,
    scope: row.authorityScope as XaiAccountAuthorityScope,
    label: row.label,
    accountEmail: row.accountEmail,
    planType: row.planType,
    status: row.status as XaiCredentialStatus,
    allocatorEnabled: row.allocatorEnabled,
    version: row.version,
    allocatorVersion: row.allocatorVersion,
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
          ${input.expiresAt ?? null}
        )`,
      );
      const created = rows[0];
      if (!created) throw new Error("xAI credential lifecycle returned no row");
      const [row] = await scopedDb
        .select()
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
    },
  );
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
  if (!input.credentialId) return await createXaiSubscriptionCredential(db, input);
  if (!input.authoritySnapshot) {
    throw new Error("Existing xAI credentials require their frozen authority snapshot");
  }
  assertSecret(input.secret);
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  const encrypted = encryptEnvironmentValue(input.encryptionKey, JSON.stringify(input.secret));
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const authorized = await rawRows<{ id: string }>(
      scopedDb,
      sql`select id from revalidate_xai_subscription_authority(
        ${input.workspaceId}::uuid, ${input.subjectId}, ${input.credentialId}::uuid,
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
      .where(eq(schema.xaiSubscriptionCredentials.id, input.credentialId))
      .returning();
    if (!row) throw new Error("xAI credential update lost its authority fence");
    return { account: metadataFromRow(row), authoritySnapshot: snapshot };
  });
}

export async function listXaiSubscriptionAccountsMetadata(
  db: Database,
  input: { workspaceId: string; subjectId: string },
): Promise<XaiSubscriptionAccountMetadata[]> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
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
      .select()
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
      .returning();
    if (!row) throw new Error("xAI subscription account settings changed");
    return metadataFromRow(row);
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
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) => {
      const rows = await rawRows<{ disconnected: boolean }>(
        scopedDb,
        sql`select disconnect_xai_subscription_credential(
          ${input.accountId}::uuid, ${input.workspaceId}::uuid,
          ${input.subjectId}, ${input.credentialId}::uuid,
          ${JSON.stringify(snapshot)}::jsonb
        ) as disconnected`,
      );
      return rows[0]?.disconnected === true;
    },
  );
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
      .select()
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
  const leasedUntil = new Date(now.getTime() + (input.leaseTtlMs ?? XAI_CREDENTIAL_LEASE_TTL_MS));
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const ownerRows =
          snapshot.scope === "user"
            ? await rawRows<{ membership_id: string }>(
                tx,
                sql`select organization_membership_id as membership_id
                from resolve_xai_authority_pool(
                  ${input.accountId}::uuid, ${input.workspaceId}::uuid,
                  ${input.subjectId}, ${JSON.stringify(snapshot)}::jsonb
                )`,
              )
            : [];
        const ownerMembershipId = ownerRows[0]?.membership_id ?? null;
        if (snapshot.scope === "user" && !ownerMembershipId) {
          throw new Error("xAI user authority pool is no longer active");
        }

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

        const [existing] = await tx
          .select()
          .from(schema.xaiCredentialLeases)
          .where(
            and(
              eq(schema.xaiCredentialLeases.workspaceId, input.workspaceId),
              eq(schema.xaiCredentialLeases.turnId, input.turnId),
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
            .select()
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
          .select()
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
        const eligible = candidates.filter(
          (candidate) =>
            candidate.status === "active" &&
            candidate.allocatorEnabled &&
            (!candidate.expiresAt || candidate.expiresAt > now) &&
            (!candidate.exhaustedUntil || candidate.exhaustedUntil <= now),
        );
        const selected = input.pinnedCredentialId
          ? eligible.find((candidate) => candidate.id === input.pinnedCredentialId)
          : eligible[0];
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
    const deleted = await scopedDb
      .delete(schema.xaiCredentialLeases)
      .where(
        and(
          eq(schema.xaiCredentialLeases.workspaceId, input.workspaceId),
          eq(schema.xaiCredentialLeases.turnId, input.turnId),
          eq(schema.xaiCredentialLeases.holderId, input.holderId),
          eq(schema.xaiCredentialLeases.generation, input.generation),
        ),
      )
      .returning({ id: schema.xaiCredentialLeases.id });
    return deleted.length === 1;
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
    const rows = await scopedDb
      .select()
      .from(schema.xaiRotationSettings)
      .where(
        and(
          eq(schema.xaiRotationSettings.workspaceId, input.workspaceId),
          eq(schema.xaiRotationSettings.authorityScope, snapshot.scope),
        ),
      );
    if (snapshot.scope === "workspace") {
      return rows.find((row) => row.ownerOrganizationMembershipId === null) ?? null;
    }
    return rows[0] ?? null;
  });
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
    const ownerRows =
      snapshot.scope === "user"
        ? await rawRows<{ membership_id: string }>(
            scopedDb,
            sql`select organization_membership_id as membership_id
              from resolve_xai_authority_pool(
                ${input.accountId}::uuid, ${input.workspaceId}::uuid,
                ${input.subjectId}, ${JSON.stringify(snapshot)}::jsonb
              )`,
          )
        : [];
    const ownerMembershipId = ownerRows[0]?.membership_id ?? null;
    if (snapshot.scope === "user" && !ownerMembershipId) {
      throw new Error("xAI user authority pool is no longer active");
    }
    const [current] = await scopedDb
      .select()
      .from(schema.xaiSessionAccountPins)
      .where(
        and(
          eq(schema.xaiSessionAccountPins.workspaceId, input.workspaceId),
          eq(schema.xaiSessionAccountPins.sessionId, input.sessionId),
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
        target: [schema.xaiSessionAccountPins.workspaceId, schema.xaiSessionAccountPins.sessionId],
        set: {
          authorityScope: snapshot.scope,
          ownerOrganizationMembershipId: ownerMembershipId,
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
  input: { workspaceId: string; subjectId: string; sessionId: string },
): Promise<typeof schema.xaiSessionAccountPins.$inferSelect | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.xaiSessionAccountPins)
      .where(
        and(
          eq(schema.xaiSessionAccountPins.workspaceId, input.workspaceId),
          eq(schema.xaiSessionAccountPins.sessionId, input.sessionId),
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
  const current = await getXaiSessionAccountPin(db, input);
  if (!current) {
    return await setXaiSessionAccountPin(db, {
      ...input,
      credentialId: null,
      pinSource: null,
    }).then(async () => await recordXaiSessionLastAccount(db, input));
  }
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.xaiSessionAccountPins)
      .set({
        lastCredentialId: input.credentialId,
        version: sql`${schema.xaiSessionAccountPins.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.xaiSessionAccountPins.id, current.id))
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

export async function armXaiCapacityWaiter(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    sessionId: string;
    blockedTurnId: string;
    blockedTurnGeneration: number;
    workflowId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
    earliestResetAt: Date | null;
    nextCheckAt: Date;
  },
): Promise<typeof schema.xaiCapacityWaiters.$inferSelect> {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const ownerRows =
      snapshot.scope === "user"
        ? await rawRows<{ membership_id: string }>(
            scopedDb,
            sql`select organization_membership_id as membership_id
              from resolve_xai_authority_pool(
                ${input.accountId}::uuid, ${input.workspaceId}::uuid,
                ${input.subjectId}, ${JSON.stringify(snapshot)}::jsonb
              )`,
          )
        : [];
    const ownerMembershipId = ownerRows[0]?.membership_id ?? null;
    const [row] = await scopedDb
      .insert(schema.xaiCapacityWaiters)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        blockedTurnId: input.blockedTurnId,
        blockedTurnGeneration: input.blockedTurnGeneration,
        workflowId: input.workflowId,
        authorityScope: snapshot.scope,
        ownerOrganizationMembershipId: ownerMembershipId,
        earliestResetAt: input.earliestResetAt,
        nextCheckAt: input.nextCheckAt,
      })
      .onConflictDoUpdate({
        target: [schema.xaiCapacityWaiters.workspaceId, schema.xaiCapacityWaiters.sessionId],
        set: {
          blockedTurnId: input.blockedTurnId,
          blockedTurnGeneration: input.blockedTurnGeneration,
          workflowId: input.workflowId,
          authorityScope: snapshot.scope,
          ownerOrganizationMembershipId: ownerMembershipId,
          status: "waiting",
          generation: sql`${schema.xaiCapacityWaiters.generation} + 1`,
          earliestResetAt: input.earliestResetAt,
          nextCheckAt: input.nextCheckAt,
          wakeRevision: sql`${schema.xaiCapacityWaiters.wakeRevision} + 1`,
          lastWakeReason: "capacity_wait_rearmed",
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  });
}

export async function wakeXaiCapacityWaiters(
  db: Database,
  input: { workspaceId: string; subjectId: string; reason: string; now?: Date },
): Promise<number> {
  const now = input.now ?? new Date();
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
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
        ),
      )
      .returning({ id: schema.xaiCapacityWaiters.id });
    return rows.length;
  });
}

export async function getXaiCapacityWaiter(
  db: Database,
  input: { workspaceId: string; subjectId: string; sessionId: string },
): Promise<typeof schema.xaiCapacityWaiters.$inferSelect | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.xaiCapacityWaiters)
      .where(
        and(
          eq(schema.xaiCapacityWaiters.workspaceId, input.workspaceId),
          eq(schema.xaiCapacityWaiters.sessionId, input.sessionId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function observeXaiCapacityWaiter(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    waiterId: string;
    generation: number;
    observedWakeRevision: number;
  },
): Promise<typeof schema.xaiCapacityWaiters.$inferSelect | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.xaiCapacityWaiters)
      .set({
        observedWakeRevision: input.observedWakeRevision,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.xaiCapacityWaiters.id, input.waiterId),
          eq(schema.xaiCapacityWaiters.workspaceId, input.workspaceId),
          eq(schema.xaiCapacityWaiters.generation, input.generation),
          eq(schema.xaiCapacityWaiters.status, "waiting"),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export async function settleXaiCapacityWaiter(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    waiterId: string;
    generation: number;
    status: "resumed" | "superseded";
    reason: string;
  },
): Promise<typeof schema.xaiCapacityWaiters.$inferSelect | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.xaiCapacityWaiters)
      .set({
        status: input.status,
        lastWakeReason: input.reason,
        observedWakeRevision: sql`${schema.xaiCapacityWaiters.wakeRevision}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.xaiCapacityWaiters.id, input.waiterId),
          eq(schema.xaiCapacityWaiters.workspaceId, input.workspaceId),
          eq(schema.xaiCapacityWaiters.generation, input.generation),
          eq(schema.xaiCapacityWaiters.status, "waiting"),
        ),
      )
      .returning();
    return row ?? null;
  });
}
