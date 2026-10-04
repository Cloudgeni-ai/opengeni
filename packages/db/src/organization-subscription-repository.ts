import { SubscriptionAccountChangedError } from "./subscription-account-conflict";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  withRlsContext,
  setSubjectRlsContext,
  withWorkspaceSubjectRls,
  rawRows,
  type Database,
} from "./database";
import { encryptEnvironmentValue } from "./environment-crypto";
import type { SubscriptionPoolTables } from "./subscription-pool-schema";
import type { createSubscriptionAccountRepository } from "./subscription-account-repository";

export function createOrganizationSubscriptionRepository<Secret, Settings>(options: {
  provider: "xai" | "claude";
  displayName: "SuperGrok" | "Claude";
  tables: SubscriptionPoolTables;
  repository: Pick<
    ReturnType<typeof createSubscriptionAccountRepository<Secret, Settings>>,
    | "credentialMetadataColumns"
    | "wakeSubscriptionCapacityWaiters"
    | "subscriptionAccountMetadataFromRow"
  >;
  accessToken: (secret: Secret) => string | undefined;
}) {
  const { provider, tables } = options;
  const {
    credentialMetadataColumns,
    wakeSubscriptionCapacityWaiters,
    subscriptionAccountMetadataFromRow,
  } = options.repository;
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
      eq(tables.credentials.accountId, organizationId),
      eq(tables.credentials.authorityScope, "organization"),
      isNull(tables.credentials.workspaceId),
    );
  const organizationRotation = (organizationId: string) =>
    and(
      eq(tables.rotationSettings.accountId, organizationId),
      eq(tables.rotationSettings.authorityScope, "organization"),
      isNull(tables.rotationSettings.workspaceId),
    );

  async function listOrganizationSubscriptions(db: Database, input: OrganizationActor) {
    return await withAdministrator(db, input, async (tx) => {
      const accounts = await tx
        .select(credentialMetadataColumns)
        .from(tables.credentials)
        .where(organizationCredentials(input.organizationId))
        .orderBy(asc(tables.credentials.createdAt), asc(tables.credentials.id));
      const [rotation] = await tx
        .select()
        .from(tables.rotationSettings)
        .where(organizationRotation(input.organizationId));
      return {
        accounts: accounts.map(subscriptionAccountMetadataFromRow),
        rotation: rotation ?? null,
      };
    });
  }

  async function lockPool(tx: Database, organizationId: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-${provider}:${organizationId}`}, 0))`,
    );
    await tx
      .insert(tables.rotationSettings)
      .values({
        accountId: organizationId,
        workspaceId: null,
        authorityScope: "organization",
        rotationEnabled: false,
      })
      .onConflictDoNothing();
    const [rotation] = await tx
      .select()
      .from(tables.rotationSettings)
      .where(organizationRotation(organizationId))
      .for("update");
    if (!rotation) throw new Error(`Organization ${options.displayName} settings are unavailable`);
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
        await wakeSubscriptionCapacityWaiters(scopedDb, {
          workspaceId,
          subjectId: input.actorSubjectId,
          authoritySnapshot: { version: 1, scope: "organization" },
          reason: `organization_${provider}_pool_changed`,
        });
      });
    }
  }

  /** Policy writes share the pool-before-credential lock order and durable wake. */
  async function withOrganizationCapacityMutation<T>(
    db: Database,
    input: OrganizationActor,
    mutate: (tx: Database) => Promise<T | null>,
  ): Promise<T | null> {
    return await withAdministrator(db, input, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`organization-${provider}:${input.organizationId}`}, 0))`,
      );
      await tx
        .select({ id: tables.rotationSettings.id })
        .from(tables.rotationSettings)
        .where(organizationRotation(input.organizationId))
        .for("update");
      const updated = await mutate(tx);
      if (updated !== null) await wakeOrganizationPool(tx, input);
      return updated;
    });
  }

  async function upsertOrganizationSubscription(
    db: Database,
    input: OrganizationActor & {
      encryptionKey: Uint8Array;
      secret: Secret;
      providerAccountId: string;
      credentialId?: string;
      expectedCredentialVersion?: number;
      expectedProviderAccountId?: string | null;
      label: string | null;
      accountEmail: string | null;
      expiresAt: Date | null;
      planType?: string | null;
    },
  ) {
    if (!options.accessToken(input.secret))
      throw new Error(`${options.displayName} access token is required`);
    const encrypted = encryptEnvironmentValue(input.encryptionKey, JSON.stringify(input.secret));
    return await withAdministrator(db, input, async (tx) => {
      const rotation = await lockPool(tx, input.organizationId);
      const [existing] = await tx
        .select({
          id: tables.credentials.id,
          providerAccountId: tables.credentials.providerAccountId,
          version: tables.credentials.version,
        })
        .from(tables.credentials)
        .where(
          and(
            organizationCredentials(input.organizationId),
            input.credentialId
              ? eq(tables.credentials.id, input.credentialId)
              : eq(tables.credentials.providerAccountId, input.providerAccountId),
          ),
        );
      if (
        input.credentialId &&
        (!existing ||
          existing.providerAccountId !==
            (input.expectedProviderAccountId !== undefined
              ? input.expectedProviderAccountId
              : input.providerAccountId) ||
          (input.expectedCredentialVersion !== undefined &&
            existing.version !== input.expectedCredentialVersion))
      )
        throw new SubscriptionAccountChangedError();
      const values = {
        providerAccountId: input.providerAccountId,
        ...(provider === "claude"
          ? {
              exhaustedUntil: null,
              quotaUsedPercent: null,
              quotaResetAt: null,
              quotaCheckedAt: null,
            }
          : {}),
        credentialEncrypted: encrypted,
        accountEmail: input.accountEmail,
        ...(input.planType !== undefined ? { planType: input.planType } : {}),
        expiresAt: input.expiresAt,
        status: "active",
        lastError: null,
        lastRefreshAt: new Date(),
        updatedAt: new Date(),
      };
      const [row] = existing
        ? await tx
            .update(tables.credentials)
            .set({ ...values, version: sql`${tables.credentials.version} + 1` })
            .where(
              and(
                organizationCredentials(input.organizationId),
                eq(tables.credentials.id, existing.id),
              ),
            )
            .returning(credentialMetadataColumns)
        : await tx
            .insert(tables.credentials)
            .values({
              ...values,
              accountId: input.organizationId,
              workspaceId: null,
              authorityScope: "organization",
              providerAccountId: input.providerAccountId,
              label: input.label,
              connectedBySubjectId: input.actorSubjectId,
            })
            .returning(credentialMetadataColumns);
      if (!row) throw new Error(`${options.displayName} connection could not be saved`);
      const activeCredentialId = rotation.activeCredentialId ?? row.id;
      if (!rotation.activeCredentialId)
        await tx
          .update(tables.rotationSettings)
          .set({ activeCredentialId, updatedAt: new Date() })
          .where(eq(tables.rotationSettings.id, rotation.id));
      await wakeOrganizationPool(tx, input);
      return {
        account: subscriptionAccountMetadataFromRow(row),
        isActive: activeCredentialId === row.id,
      };
    });
  }

  async function updateOrganizationSubscription(
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
        eq(tables.credentials.id, input.credentialId),
      );
      const [account] = await tx
        .select(credentialMetadataColumns)
        .from(tables.credentials)
        .where(predicate)
        .for("update");
      if (!account) return null;
      if (input.disconnect) {
        await tx.delete(tables.credentials).where(predicate);
        if (rotation.activeCredentialId === account.id) {
          const [next] = await tx
            .select({ id: tables.credentials.id })
            .from(tables.credentials)
            .where(
              and(
                organizationCredentials(input.organizationId),
                eq(tables.credentials.status, "active"),
                eq(tables.credentials.allocatorEnabled, true),
              ),
            )
            .orderBy(asc(tables.credentials.createdAt), asc(tables.credentials.id))
            .limit(1);
          await tx
            .update(tables.rotationSettings)
            .set({ activeCredentialId: next?.id ?? null, updatedAt: new Date() })
            .where(eq(tables.rotationSettings.id, rotation.id));
        }
        await wakeOrganizationPool(tx, input);
        return { disconnected: true };
      }
      if (input.activate) {
        if (account.status !== "active" || !account.allocatorEnabled)
          throw new Error(`Choose an active, enabled ${options.displayName} subscription`);
        await tx
          .update(tables.rotationSettings)
          .set({ activeCredentialId: account.id, updatedAt: new Date() })
          .where(eq(tables.rotationSettings.id, rotation.id));
      }
      if (input.label !== undefined) {
        const label = input.label?.trim() || null;
        if (label && label.length > 200)
          throw new Error("Subscription name must be 200 characters or fewer");
        await tx.update(tables.credentials).set({ label, updatedAt: new Date() }).where(predicate);
      }
      if (input.allocatorEnabled !== undefined) {
        if (input.expectedAllocatorVersion !== account.allocatorVersion)
          throw new Error("Subscription changed. Refresh and try again.");
        await tx
          .update(tables.credentials)
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

  async function updateOrganizationRotation(
    db: Database,
    input: OrganizationActor & { rotationEnabled: boolean },
  ) {
    return await withAdministrator(db, input, async (tx) => {
      const rotation = await lockPool(tx, input.organizationId);
      const [updated] = await tx
        .update(tables.rotationSettings)
        .set({ rotationEnabled: input.rotationEnabled, updatedAt: new Date() })
        .where(eq(tables.rotationSettings.id, rotation.id))
        .returning();
      await wakeOrganizationPool(tx, input);
      return updated!;
    });
  }

  return {
    listOrganizationSubscriptions,
    withOrganizationCapacityMutation,
    upsertOrganizationSubscription,
    updateOrganizationSubscription,
    updateOrganizationRotation,
  };
}
