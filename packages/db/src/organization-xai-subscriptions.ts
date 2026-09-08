import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  withRlsContext,
  setSubjectRlsContext,
  withWorkspaceSubjectRls,
  rawRows,
  type Database,
} from "./database";
import { encryptEnvironmentValue } from "./environment-crypto";
import * as schema from "./schema";
import {
  xaiCredentialMetadataColumns,
  wakeXaiCapacityWaiters,
  xaiSubscriptionMetadataFromRow,
  type XaiCredentialSecretV1,
} from "./xai-subscription";

type OrganizationActor = { organizationId: string; actorSubjectId: string };

async function withAdministrator<T>(
  db: Database,
  input: OrganizationActor,
  use: (db: Database) => Promise<T>,
) {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (tx) => {
      await setSubjectRlsContext(tx, input.actorSubjectId);
      await tx.execute(
        sql`select get_organization_administration_overview(${input.organizationId}::uuid, ${input.actorSubjectId})`,
      );
      return await use(tx);
    },
  );
}
const organizationCredentials = (organizationId: string) =>
  and(
    eq(schema.xaiSubscriptionCredentials.accountId, organizationId),
    eq(schema.xaiSubscriptionCredentials.authorityScope, "organization"),
    isNull(schema.xaiSubscriptionCredentials.workspaceId),
  );
const organizationRotation = (organizationId: string) =>
  and(
    eq(schema.xaiRotationSettings.accountId, organizationId),
    eq(schema.xaiRotationSettings.authorityScope, "organization"),
    isNull(schema.xaiRotationSettings.workspaceId),
  );

export async function listOrganizationXaiSubscriptions(db: Database, input: OrganizationActor) {
  return await withAdministrator(db, input, async (tx) => {
    const accounts = await tx
      .select(xaiCredentialMetadataColumns)
      .from(schema.xaiSubscriptionCredentials)
      .where(organizationCredentials(input.organizationId))
      .orderBy(
        asc(schema.xaiSubscriptionCredentials.createdAt),
        asc(schema.xaiSubscriptionCredentials.id),
      );
    const [rotation] = await tx
      .select()
      .from(schema.xaiRotationSettings)
      .where(organizationRotation(input.organizationId));
    return { accounts: accounts.map(xaiSubscriptionMetadataFromRow), rotation: rotation ?? null };
  });
}

async function lockPool(tx: Database, organizationId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`organization-xai:${organizationId}`}, 0))`,
  );
  await tx
    .insert(schema.xaiRotationSettings)
    .values({
      accountId: organizationId,
      workspaceId: null,
      authorityScope: "organization",
      rotationEnabled: false,
    })
    .onConflictDoNothing();
  const [rotation] = await tx
    .select()
    .from(schema.xaiRotationSettings)
    .where(organizationRotation(organizationId))
    .for("update");
  if (!rotation) throw new Error("Organization SuperGrok settings are unavailable");
  return rotation;
}

/**
 * Durable invalidation only: organization administration grants no session reads.
 * Reuse the complete subscription inventory, including canonical Personal workspaces.
 */
async function wakeOrganizationPool(tx: Database, input: OrganizationActor) {
  const workspaces = await rawRows<{ workspace_id: string }>(
    tx,
    sql`select workspace_id from list_organization_codex_workspace_ids(${input.organizationId}::uuid) order by workspace_id`,
  );
  for (const { workspace_id: workspaceId } of workspaces) {
    await withWorkspaceSubjectRls(tx, workspaceId, input.actorSubjectId, async (scopedDb) => {
      await scopedDb.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${`session-tenancy:${workspaceId}`}, 0))`,
      );
      await wakeXaiCapacityWaiters(scopedDb, {
        workspaceId,
        subjectId: input.actorSubjectId,
        authoritySnapshot: { version: 1, scope: "organization" },
        reason: "organization_xai_pool_changed",
      });
    });
  }
}

/** Policy writes share the pool-before-credential lock order and durable wake. */
export async function withOrganizationXaiCapacityMutation<T>(
  db: Database,
  input: OrganizationActor,
  mutate: (tx: Database) => Promise<T | null>,
): Promise<T | null> {
  return await withAdministrator(db, input, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-xai:${input.organizationId}`}, 0))`,
    );
    await tx
      .select({ id: schema.xaiRotationSettings.id })
      .from(schema.xaiRotationSettings)
      .where(organizationRotation(input.organizationId))
      .for("update");
    const updated = await mutate(tx);
    if (updated !== null) await wakeOrganizationPool(tx, input);
    return updated;
  });
}

export async function upsertOrganizationXaiSubscription(
  db: Database,
  input: OrganizationActor & {
    encryptionKey: Uint8Array;
    secret: XaiCredentialSecretV1;
    providerAccountId: string;
    label: string | null;
    accountEmail: string | null;
    expiresAt: Date;
  },
) {
  if (!input.secret.accessToken) throw new Error("SuperGrok access token is required");
  const encrypted = encryptEnvironmentValue(input.encryptionKey, JSON.stringify(input.secret));
  return await withAdministrator(db, input, async (tx) => {
    const rotation = await lockPool(tx, input.organizationId);
    const [existing] = await tx
      .select({ id: schema.xaiSubscriptionCredentials.id })
      .from(schema.xaiSubscriptionCredentials)
      .where(
        and(
          organizationCredentials(input.organizationId),
          eq(schema.xaiSubscriptionCredentials.providerAccountId, input.providerAccountId),
        ),
      );
    const values = {
      credentialEncrypted: encrypted,
      accountEmail: input.accountEmail,
      expiresAt: input.expiresAt,
      status: "active",
      lastError: null,
      lastRefreshAt: new Date(),
      updatedAt: new Date(),
    };
    const [row] = existing
      ? await tx
          .update(schema.xaiSubscriptionCredentials)
          .set({ ...values, version: sql`${schema.xaiSubscriptionCredentials.version} + 1` })
          .where(
            and(
              organizationCredentials(input.organizationId),
              eq(schema.xaiSubscriptionCredentials.id, existing.id),
            ),
          )
          .returning(xaiCredentialMetadataColumns)
      : await tx
          .insert(schema.xaiSubscriptionCredentials)
          .values({
            ...values,
            accountId: input.organizationId,
            workspaceId: null,
            authorityScope: "organization",
            providerAccountId: input.providerAccountId,
            label: input.label,
            connectedBySubjectId: input.actorSubjectId,
          })
          .returning(xaiCredentialMetadataColumns);
    if (!row) throw new Error("SuperGrok connection could not be saved");
    const activeCredentialId = rotation.activeCredentialId ?? row.id;
    if (!rotation.activeCredentialId)
      await tx
        .update(schema.xaiRotationSettings)
        .set({ activeCredentialId, updatedAt: new Date() })
        .where(eq(schema.xaiRotationSettings.id, rotation.id));
    await wakeOrganizationPool(tx, input);
    return {
      account: xaiSubscriptionMetadataFromRow(row),
      isActive: activeCredentialId === row.id,
    };
  });
}

export async function updateOrganizationXaiSubscription(
  db: Database,
  input: OrganizationActor & {
    credentialId: string;
    label?: string | null;
    allocatorEnabled?: boolean;
    expectedAllocatorVersion?: number;
    activate?: boolean;
    disconnect?: boolean;
  },
) {
  return await withAdministrator(db, input, async (tx) => {
    const rotation = await lockPool(tx, input.organizationId);
    const predicate = and(
      organizationCredentials(input.organizationId),
      eq(schema.xaiSubscriptionCredentials.id, input.credentialId),
    );
    const [account] = await tx
      .select(xaiCredentialMetadataColumns)
      .from(schema.xaiSubscriptionCredentials)
      .where(predicate)
      .for("update");
    if (!account) return null;
    if (input.disconnect) {
      await tx.delete(schema.xaiSubscriptionCredentials).where(predicate);
      if (rotation.activeCredentialId === account.id) {
        const [next] = await tx
          .select({ id: schema.xaiSubscriptionCredentials.id })
          .from(schema.xaiSubscriptionCredentials)
          .where(
            and(
              organizationCredentials(input.organizationId),
              eq(schema.xaiSubscriptionCredentials.status, "active"),
              eq(schema.xaiSubscriptionCredentials.allocatorEnabled, true),
            ),
          )
          .orderBy(
            asc(schema.xaiSubscriptionCredentials.createdAt),
            asc(schema.xaiSubscriptionCredentials.id),
          )
          .limit(1);
        await tx
          .update(schema.xaiRotationSettings)
          .set({ activeCredentialId: next?.id ?? null, updatedAt: new Date() })
          .where(eq(schema.xaiRotationSettings.id, rotation.id));
      }
      await wakeOrganizationPool(tx, input);
      return { disconnected: true };
    }
    if (input.activate) {
      if (account.status !== "active" || !account.allocatorEnabled)
        throw new Error("Choose an active, enabled SuperGrok subscription");
      await tx
        .update(schema.xaiRotationSettings)
        .set({ activeCredentialId: account.id, updatedAt: new Date() })
        .where(eq(schema.xaiRotationSettings.id, rotation.id));
    }
    if (input.label !== undefined) {
      const label = input.label?.trim() || null;
      if (label && label.length > 200)
        throw new Error("Subscription name must be 200 characters or fewer");
      await tx
        .update(schema.xaiSubscriptionCredentials)
        .set({ label, updatedAt: new Date() })
        .where(predicate);
    }
    if (input.allocatorEnabled !== undefined) {
      if (input.expectedAllocatorVersion !== account.allocatorVersion)
        throw new Error("Subscription changed. Refresh and try again.");
      await tx
        .update(schema.xaiSubscriptionCredentials)
        .set({
          allocatorEnabled: input.allocatorEnabled,
          allocatorVersion: account.allocatorVersion + 1,
          allocatorUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(predicate);
    }
    if (input.activate || input.allocatorEnabled !== undefined)
      await wakeOrganizationPool(tx, input);
    return { updated: true };
  });
}

export async function updateOrganizationXaiRotation(
  db: Database,
  input: OrganizationActor & { rotationEnabled: boolean },
) {
  return await withAdministrator(db, input, async (tx) => {
    const rotation = await lockPool(tx, input.organizationId);
    const [updated] = await tx
      .update(schema.xaiRotationSettings)
      .set({ rotationEnabled: input.rotationEnabled, updatedAt: new Date() })
      .where(eq(schema.xaiRotationSettings.id, rotation.id))
      .returning();
    await wakeOrganizationPool(tx, input);
    return updated!;
  });
}
