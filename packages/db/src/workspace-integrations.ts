import { and, desc, eq, sql } from "drizzle-orm";
import { rawRows, type Database, withAccountRls, withRlsContext } from "./database";
import {
  organizationCredentialProviders,
  organizationWebhookDeliveries,
  organizationWebhooks,
  workspaces,
  workspaceCredentialProviders,
  workspaceWebhookDeliveries,
  workspaceWebhooks,
  type IntegrationWorkspaceFilter,
} from "./schema";

export type WorkspaceIntegrationScope = {
  accountId: string;
  workspaceId: string;
};

export const WORKSPACE_WEBHOOK_LIMIT = 10;
export const WORKSPACE_WEBHOOK_MAX_ATTEMPTS = 12;

export class WorkspaceWebhookLimitError extends Error {
  constructor() {
    super(`a workspace may have at most ${WORKSPACE_WEBHOOK_LIMIT} webhooks`);
    this.name = "WorkspaceWebhookLimitError";
  }
}

export type WorkspaceCredentialProviderRow = typeof workspaceCredentialProviders.$inferSelect;
export type WorkspaceWebhookRow = typeof workspaceWebhooks.$inferSelect;
export type WorkspaceWebhookDeliveryRow = typeof workspaceWebhookDeliveries.$inferSelect;
export type OrganizationIntegrationScope = { accountId: string };
export type OrganizationCredentialProviderRow = typeof organizationCredentialProviders.$inferSelect;
export type OrganizationWebhookRow = typeof organizationWebhooks.$inferSelect;
export type OrganizationWebhookDeliveryRow = typeof organizationWebhookDeliveries.$inferSelect;
export type ResolvedWorkspaceCredentialProvider =
  | WorkspaceCredentialProviderRow
  | OrganizationCredentialProviderRow;
export type InitiatingHuman = {
  subjectId: string;
  externalIdentity: { source: string; externalId: string } | null;
};

export function integrationInitiatingHuman(
  subjectId: string | null,
  externalIdentity: InitiatingHuman["externalIdentity"],
): InitiatingHuman | null {
  return subjectId === null
    ? null
    : {
        subjectId,
        externalIdentity: subjectId.startsWith("external_user:") ? externalIdentity : null,
      };
}

export function selectWorkspaceCredentialProvider<
  W extends { accountId: string; workspaceId: string; enabled: boolean },
  O extends {
    accountId: string;
    enabled: boolean;
    workspaceFilter: IntegrationWorkspaceFilter | null;
  },
>(
  scope: WorkspaceIntegrationScope,
  workspace: {
    accountId: string;
    id: string;
    externalSource: string | null;
    kind: "personal" | "shared";
  } | null,
  provider: W | null,
  organizationProvider: O | null,
): W | O | null {
  if (!workspace || workspace.accountId !== scope.accountId || workspace.id !== scope.workspaceId)
    return null;
  // A configured disabled row is an explicit opt-out, not absence.
  if (provider)
    return provider.enabled &&
      provider.accountId === scope.accountId &&
      provider.workspaceId === scope.workspaceId
      ? provider
      : null;
  return workspace.kind === "shared" &&
    organizationProvider?.enabled &&
    organizationProvider.accountId === scope.accountId &&
    integrationWorkspaceFilterMatches(organizationProvider.workspaceFilter, workspace)
    ? organizationProvider
    : null;
}

/** Hold through read + create/update so only the winning create returns a secret. */
export async function withCredentialProviderConfigurationLock<T>(
  db: Database,
  scope: { accountId: string; workspaceId?: string },
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return withRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId ?? null },
    async (tx) => {
      const key = scope.workspaceId
        ? `workspace-credential-provider:${scope.workspaceId}`
        : `organization-credential-provider:${scope.accountId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      return fn(tx);
    },
  );
}

/** Attribution only, never authorization; no session-creator fallback. */
export async function resolveInitiatingHuman(
  db: Database,
  scope: WorkspaceIntegrationScope,
  subjectId: string | null,
  turnId?: string,
): Promise<InitiatingHuman | null> {
  if (subjectId === null) return null;
  return withRlsContext(db, scope, async (scopedDb) => {
    const [row] = await rawRows<{ human: InitiatingHuman | null }>(
      scopedDb,
      sql`select opengeni_private.resolve_integration_initiating_human_v1(
        ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${subjectId}::text,
        ${turnId ?? null}::uuid
      ) as human`,
    );
    return row?.human ? integrationInitiatingHuman(subjectId, row.human.externalIdentity) : null;
  });
}

export function integrationWorkspaceFilterMatches(
  filter: IntegrationWorkspaceFilter | null,
  workspace: { externalSource: string | null },
): boolean {
  return filter === null || filter.externalSource === workspace.externalSource;
}

/** Only absence inherits organization configuration; Personal never inherits. */
export async function resolveWorkspaceCredentialProvider(
  db: Database,
  scope: WorkspaceIntegrationScope,
): Promise<ResolvedWorkspaceCredentialProvider | null> {
  return withRlsContext(db, scope, async (scopedDb) => {
    const [workspace] = await scopedDb
      .select({
        id: workspaces.id,
        accountId: workspaces.accountId,
        externalSource: workspaces.externalSource,
      })
      .from(workspaces)
      .where(and(eq(workspaces.accountId, scope.accountId), eq(workspaces.id, scope.workspaceId)))
      .limit(1);
    if (!workspace) return null;
    const provider = await getWorkspaceCredentialProvider(scopedDb, scope);
    // Preserve the explicit opt-out for the worker adapter: null means absence
    // and would allow it to borrow the deployment runCredentials port.
    if (provider && !provider.enabled) return provider;
    const [classification] = await rawRows<{ kind: "personal" | "shared" }>(
      scopedDb,
      sql`select get_workspace_kind(${scope.accountId}::uuid, ${scope.workspaceId}::uuid) as kind`,
    );
    const classifiedWorkspace = { ...workspace, kind: classification!.kind };
    const selectedWorkspace = selectWorkspaceCredentialProvider<
      WorkspaceCredentialProviderRow,
      OrganizationCredentialProviderRow
    >(scope, classifiedWorkspace, provider, null);
    if (provider || classifiedWorkspace.kind === "personal") return selectedWorkspace;
    const [organizationProvider] = await rawRows<OrganizationCredentialProviderRow>(
      scopedDb,
      sql`select id, account_id as "accountId", url, secret_encrypted as "secretEncrypted",
        enabled, timeout_ms as "timeoutMs", workspace_filter as "workspaceFilter",
        created_by_subject_id as "createdBySubjectId", created_at as "createdAt", updated_at as "updatedAt"
        from opengeni_private.resolve_organization_credential_provider_v1(
          ${scope.accountId}::uuid, ${scope.workspaceId}::uuid
        )`,
    );
    return selectWorkspaceCredentialProvider<
      WorkspaceCredentialProviderRow,
      OrganizationCredentialProviderRow
    >(scope, classifiedWorkspace, provider, organizationProvider ?? null);
  });
}

export async function getOrganizationCredentialProvider(
  db: Database,
  scope: OrganizationIntegrationScope,
): Promise<OrganizationCredentialProviderRow | null> {
  return withAccountRls(db, scope.accountId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(organizationCredentialProviders)
      .where(eq(organizationCredentialProviders.accountId, scope.accountId))
      .limit(1);
    return row ?? null;
  });
}

export async function upsertOrganizationCredentialProvider(
  db: Database,
  input: OrganizationIntegrationScope & {
    url: string;
    secretEncrypted?: string;
    enabled: boolean;
    timeoutMs: number;
    workspaceFilter: IntegrationWorkspaceFilter | null;
    createdBySubjectId: string | null;
  },
): Promise<OrganizationCredentialProviderRow> {
  return withCredentialProviderConfigurationLock(db, input, async (scopedDb) => {
    const values = {
      url: input.url,
      enabled: input.enabled,
      timeoutMs: input.timeoutMs,
      workspaceFilter: input.workspaceFilter,
      updatedAt: sql`now()`,
    };
    if (input.secretEncrypted === undefined) {
      const [row] = await scopedDb
        .update(organizationCredentialProviders)
        .set(values)
        .where(eq(organizationCredentialProviders.accountId, input.accountId))
        .returning();
      if (!row) throw new Error("a signing secret is required when creating a credential provider");
      return row;
    }
    const [row] = await scopedDb
      .insert(organizationCredentialProviders)
      .values({
        ...values,
        accountId: input.accountId,
        secretEncrypted: input.secretEncrypted,
        createdBySubjectId: input.createdBySubjectId,
      })
      .onConflictDoUpdate({
        target: organizationCredentialProviders.accountId,
        set: { ...values, secretEncrypted: input.secretEncrypted },
      })
      .returning();
    return row!;
  });
}

export async function deleteOrganizationCredentialProvider(
  db: Database,
  scope: OrganizationIntegrationScope,
): Promise<boolean> {
  return withCredentialProviderConfigurationLock(db, scope, async (scopedDb) => {
    const rows = await scopedDb
      .delete(organizationCredentialProviders)
      .where(eq(organizationCredentialProviders.accountId, scope.accountId))
      .returning({ id: organizationCredentialProviders.id });
    return rows.length > 0;
  });
}

/** Replace the only accepted secret atomically; never keep an overlap slot. */
export async function rotateOrganizationCredentialProviderSecret(
  db: Database,
  input: OrganizationIntegrationScope & { secretEncrypted: string },
): Promise<OrganizationCredentialProviderRow | null> {
  return withCredentialProviderConfigurationLock(db, input, async (tx) => {
    const [row] = await tx
      .update(organizationCredentialProviders)
      .set({ secretEncrypted: input.secretEncrypted, updatedAt: sql`now()` })
      .where(eq(organizationCredentialProviders.accountId, input.accountId))
      .returning();
    return row ?? null;
  });
}

export async function rotateOrganizationWebhookSecret(
  db: Database,
  input: OrganizationIntegrationScope & { webhookId: string; secretEncrypted: string },
): Promise<OrganizationWebhookRow | null> {
  return withAccountRls(db, input.accountId, async (tx) => {
    const [row] = await tx
      .update(organizationWebhooks)
      .set({ secretEncrypted: input.secretEncrypted, updatedAt: sql`now()` })
      .where(
        and(
          eq(organizationWebhooks.accountId, input.accountId),
          eq(organizationWebhooks.id, input.webhookId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export const ORGANIZATION_WEBHOOK_LIMIT = 10;
export class OrganizationWebhookLimitError extends Error {
  constructor() {
    super(`an organization may have at most ${ORGANIZATION_WEBHOOK_LIMIT} webhooks`);
    this.name = "OrganizationWebhookLimitError";
  }
}

export async function listOrganizationWebhooks(
  db: Database,
  scope: OrganizationIntegrationScope,
): Promise<OrganizationWebhookRow[]> {
  return withAccountRls(db, scope.accountId, async (scopedDb) =>
    scopedDb
      .select()
      .from(organizationWebhooks)
      .where(eq(organizationWebhooks.accountId, scope.accountId))
      .orderBy(organizationWebhooks.createdAt, organizationWebhooks.id),
  );
}

export async function getOrganizationWebhook(
  db: Database,
  input: OrganizationIntegrationScope & { webhookId: string },
): Promise<OrganizationWebhookRow | null> {
  return withAccountRls(db, input.accountId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(organizationWebhooks)
      .where(
        and(
          eq(organizationWebhooks.accountId, input.accountId),
          eq(organizationWebhooks.id, input.webhookId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function createOrganizationWebhook(
  db: Database,
  input: OrganizationIntegrationScope & {
    url: string;
    secretEncrypted: string;
    eventTypes: string[];
    enabled: boolean;
    description: string | null;
    workspaceFilter: IntegrationWorkspaceFilter | null;
    createdBySubjectId: string | null;
  },
): Promise<OrganizationWebhookRow> {
  return withAccountRls(db, input.accountId, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-webhooks:${input.accountId}`}, 0))`,
    );
    const [counted] = await rawRows<{ count: number }>(
      scopedDb,
      sql`select count(*)::integer as count from organization_webhooks where account_id = ${input.accountId}::uuid`,
    );
    if ((counted?.count ?? 0) >= ORGANIZATION_WEBHOOK_LIMIT)
      throw new OrganizationWebhookLimitError();
    const [row] = await scopedDb.insert(organizationWebhooks).values(input).returning();
    return row!;
  });
}

export async function updateOrganizationWebhook(
  db: Database,
  input: OrganizationIntegrationScope & {
    webhookId: string;
    url?: string;
    eventTypes?: string[];
    enabled?: boolean;
    description?: string | null;
    workspaceFilter?: IntegrationWorkspaceFilter | null;
  },
): Promise<OrganizationWebhookRow | null> {
  return withAccountRls(db, input.accountId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(organizationWebhooks)
      .set({
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.workspaceFilter !== undefined ? { workspaceFilter: input.workspaceFilter } : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(organizationWebhooks.accountId, input.accountId),
          eq(organizationWebhooks.id, input.webhookId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export async function deleteOrganizationWebhook(
  db: Database,
  input: OrganizationIntegrationScope & { webhookId: string },
): Promise<boolean> {
  return withAccountRls(db, input.accountId, async (scopedDb) => {
    const rows = await scopedDb
      .delete(organizationWebhooks)
      .where(
        and(
          eq(organizationWebhooks.accountId, input.accountId),
          eq(organizationWebhooks.id, input.webhookId),
        ),
      )
      .returning({ id: organizationWebhooks.id });
    return rows.length > 0;
  });
}

export async function listOrganizationWebhookDeliveries(
  db: Database,
  input: OrganizationIntegrationScope & { webhookId: string; limit?: number },
): Promise<OrganizationWebhookDeliveryRow[]> {
  return withAccountRls(db, input.accountId, async (scopedDb) =>
    scopedDb
      .select()
      .from(organizationWebhookDeliveries)
      .where(
        and(
          eq(organizationWebhookDeliveries.accountId, input.accountId),
          eq(organizationWebhookDeliveries.webhookId, input.webhookId),
        ),
      )
      .orderBy(
        desc(organizationWebhookDeliveries.createdAt),
        desc(organizationWebhookDeliveries.id),
      )
      .limit(Math.max(1, Math.min(input.limit ?? 50, 200))),
  );
}

export async function redeliverOrganizationWebhookDelivery(
  db: Database,
  input: OrganizationIntegrationScope & { webhookId: string; deliveryId: string },
): Promise<OrganizationWebhookDeliveryRow | null> {
  return withAccountRls(db, input.accountId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(organizationWebhookDeliveries)
      .set({
        attempts: 0,
        deliveredAt: null,
        failedAt: null,
        claimId: null,
        claimUntil: null,
        nextAttemptAt: sql`now()`,
      })
      .where(
        and(
          eq(organizationWebhookDeliveries.accountId, input.accountId),
          eq(organizationWebhookDeliveries.webhookId, input.webhookId),
          eq(organizationWebhookDeliveries.id, input.deliveryId),
          sql`(${organizationWebhookDeliveries.deliveredAt} is not null or ${organizationWebhookDeliveries.failedAt} is not null)`,
        ),
      )
      .returning();
    return row ?? null;
  });
}

export async function getWorkspaceCredentialProvider(
  db: Database,
  scope: WorkspaceIntegrationScope,
): Promise<WorkspaceCredentialProviderRow | null> {
  return withRlsContext(db, scope, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(workspaceCredentialProviders)
      .where(
        and(
          eq(workspaceCredentialProviders.accountId, scope.accountId),
          eq(workspaceCredentialProviders.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/** Create or replace the workspace's single provider. Omit the secret to keep it. */
export async function upsertWorkspaceCredentialProvider(
  db: Database,
  input: WorkspaceIntegrationScope & {
    url: string;
    secretEncrypted?: string;
    enabled: boolean;
    timeoutMs: number;
    createdBySubjectId: string | null;
  },
): Promise<WorkspaceCredentialProviderRow> {
  return withCredentialProviderConfigurationLock(db, input, async (scopedDb) => {
    if (input.secretEncrypted === undefined) {
      const [updated] = await scopedDb
        .update(workspaceCredentialProviders)
        .set({
          url: input.url,
          enabled: input.enabled,
          timeoutMs: input.timeoutMs,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(workspaceCredentialProviders.accountId, input.accountId),
            eq(workspaceCredentialProviders.workspaceId, input.workspaceId),
          ),
        )
        .returning();
      if (!updated) {
        throw new Error("a signing secret is required when creating a credential provider");
      }
      return updated;
    }
    const [row] = await scopedDb
      .insert(workspaceCredentialProviders)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        url: input.url,
        secretEncrypted: input.secretEncrypted,
        enabled: input.enabled,
        timeoutMs: input.timeoutMs,
        createdBySubjectId: input.createdBySubjectId,
      })
      .onConflictDoUpdate({
        target: workspaceCredentialProviders.workspaceId,
        set: {
          url: input.url,
          secretEncrypted: input.secretEncrypted,
          enabled: input.enabled,
          timeoutMs: input.timeoutMs,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row!;
  });
}

export async function deleteWorkspaceCredentialProvider(
  db: Database,
  scope: WorkspaceIntegrationScope,
): Promise<boolean> {
  return withCredentialProviderConfigurationLock(db, scope, async (scopedDb) => {
    const deleted = await scopedDb
      .delete(workspaceCredentialProviders)
      .where(
        and(
          eq(workspaceCredentialProviders.accountId, scope.accountId),
          eq(workspaceCredentialProviders.workspaceId, scope.workspaceId),
        ),
      )
      .returning({ id: workspaceCredentialProviders.id });
    return deleted.length > 0;
  });
}

export async function rotateWorkspaceCredentialProviderSecret(
  db: Database,
  input: WorkspaceIntegrationScope & { secretEncrypted: string },
): Promise<WorkspaceCredentialProviderRow | null> {
  return withCredentialProviderConfigurationLock(db, input, async (tx) => {
    const [row] = await tx
      .update(workspaceCredentialProviders)
      .set({ secretEncrypted: input.secretEncrypted, updatedAt: sql`now()` })
      .where(
        and(
          eq(workspaceCredentialProviders.accountId, input.accountId),
          eq(workspaceCredentialProviders.workspaceId, input.workspaceId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export async function rotateWorkspaceWebhookSecret(
  db: Database,
  input: WorkspaceIntegrationScope & { webhookId: string; secretEncrypted: string },
): Promise<WorkspaceWebhookRow | null> {
  return withRlsContext(db, input, async (tx) => {
    const [row] = await tx
      .update(workspaceWebhooks)
      .set({ secretEncrypted: input.secretEncrypted, updatedAt: sql`now()` })
      .where(
        and(
          eq(workspaceWebhooks.accountId, input.accountId),
          eq(workspaceWebhooks.workspaceId, input.workspaceId),
          eq(workspaceWebhooks.id, input.webhookId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export async function listWorkspaceWebhooks(
  db: Database,
  scope: WorkspaceIntegrationScope,
): Promise<WorkspaceWebhookRow[]> {
  return withRlsContext(db, scope, async (scopedDb) =>
    scopedDb
      .select()
      .from(workspaceWebhooks)
      .where(
        and(
          eq(workspaceWebhooks.accountId, scope.accountId),
          eq(workspaceWebhooks.workspaceId, scope.workspaceId),
        ),
      )
      .orderBy(workspaceWebhooks.createdAt, workspaceWebhooks.id),
  );
}

export async function getWorkspaceWebhook(
  db: Database,
  input: WorkspaceIntegrationScope & { webhookId: string },
): Promise<WorkspaceWebhookRow | null> {
  return withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(workspaceWebhooks)
      .where(
        and(
          eq(workspaceWebhooks.accountId, input.accountId),
          eq(workspaceWebhooks.workspaceId, input.workspaceId),
          eq(workspaceWebhooks.id, input.webhookId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function createWorkspaceWebhook(
  db: Database,
  input: WorkspaceIntegrationScope & {
    url: string;
    secretEncrypted: string;
    eventTypes: string[];
    enabled: boolean;
    description: string | null;
    createdBySubjectId: string | null;
  },
): Promise<WorkspaceWebhookRow> {
  return withRlsContext(db, input, async (scopedDb) => {
    // Serialize creates per workspace so the count check cannot race.
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-webhooks:${input.workspaceId}`}, 0))`,
    );
    const [counted] = await rawRows<{ count: number }>(
      scopedDb,
      sql`select count(*)::integer as count from workspace_webhooks
        where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid`,
    );
    if ((counted?.count ?? 0) >= WORKSPACE_WEBHOOK_LIMIT) {
      throw new WorkspaceWebhookLimitError();
    }
    const [row] = await scopedDb
      .insert(workspaceWebhooks)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        url: input.url,
        secretEncrypted: input.secretEncrypted,
        eventTypes: input.eventTypes,
        enabled: input.enabled,
        description: input.description,
        createdBySubjectId: input.createdBySubjectId,
      })
      .returning();
    return row!;
  });
}

export async function updateWorkspaceWebhook(
  db: Database,
  input: WorkspaceIntegrationScope & {
    webhookId: string;
    url?: string;
    eventTypes?: string[];
    enabled?: boolean;
    description?: string | null;
  },
): Promise<WorkspaceWebhookRow | null> {
  return withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .update(workspaceWebhooks)
      .set({
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(workspaceWebhooks.accountId, input.accountId),
          eq(workspaceWebhooks.workspaceId, input.workspaceId),
          eq(workspaceWebhooks.id, input.webhookId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export async function deleteWorkspaceWebhook(
  db: Database,
  input: WorkspaceIntegrationScope & { webhookId: string },
): Promise<boolean> {
  return withRlsContext(db, input, async (scopedDb) => {
    const deleted = await scopedDb
      .delete(workspaceWebhooks)
      .where(
        and(
          eq(workspaceWebhooks.accountId, input.accountId),
          eq(workspaceWebhooks.workspaceId, input.workspaceId),
          eq(workspaceWebhooks.id, input.webhookId),
        ),
      )
      .returning({ id: workspaceWebhooks.id });
    return deleted.length > 0;
  });
}

export async function listWorkspaceWebhookDeliveries(
  db: Database,
  input: WorkspaceIntegrationScope & { webhookId: string; limit?: number },
): Promise<WorkspaceWebhookDeliveryRow[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  return withRlsContext(db, input, async (scopedDb) =>
    scopedDb
      .select()
      .from(workspaceWebhookDeliveries)
      .where(
        and(
          eq(workspaceWebhookDeliveries.accountId, input.accountId),
          eq(workspaceWebhookDeliveries.workspaceId, input.workspaceId),
          eq(workspaceWebhookDeliveries.webhookId, input.webhookId),
        ),
      )
      .orderBy(desc(workspaceWebhookDeliveries.createdAt), desc(workspaceWebhookDeliveries.id))
      .limit(limit),
  );
}

/** Put a settled delivery back on the queue with a fresh attempt budget. */
export async function redeliverWorkspaceWebhookDelivery(
  db: Database,
  input: WorkspaceIntegrationScope & { webhookId: string; deliveryId: string },
): Promise<WorkspaceWebhookDeliveryRow | null> {
  return withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .update(workspaceWebhookDeliveries)
      .set({
        attempts: 0,
        deliveredAt: null,
        failedAt: null,
        claimId: null,
        claimUntil: null,
        nextAttemptAt: sql`now()`,
      })
      .where(
        and(
          eq(workspaceWebhookDeliveries.accountId, input.accountId),
          eq(workspaceWebhookDeliveries.workspaceId, input.workspaceId),
          eq(workspaceWebhookDeliveries.webhookId, input.webhookId),
          eq(workspaceWebhookDeliveries.id, input.deliveryId),
          sql`(${workspaceWebhookDeliveries.deliveredAt} is not null or ${workspaceWebhookDeliveries.failedAt} is not null)`,
        ),
      )
      .returning();
    return row ?? null;
  });
}

export type ClaimedWorkspaceWebhookDelivery = {
  deliveryId: string;
  accountId: string;
  workspaceId: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  url: string;
  secretEncrypted: string;
};

/** Cross-workspace claim for the single dispatcher loop. */
export async function claimWorkspaceWebhookDeliveries(
  db: Database,
  input: { claimId: string; limit?: number; claimSeconds?: number },
): Promise<ClaimedWorkspaceWebhookDelivery[]> {
  const rows = await rawRows<{
    delivery_id: string;
    account_id: string;
    workspace_id: string;
    webhook_id: string;
    event_id: string;
    event_type: string;
    payload: unknown;
    attempts: number;
    url: string;
    secret_encrypted: string;
  }>(
    db,
    sql`select * from opengeni_private.claim_workspace_webhook_deliveries_v1(
      ${input.claimId}::uuid, ${input.limit ?? 32}::integer, ${input.claimSeconds ?? 60}::integer
    )`,
  );
  return rows.map((row) => ({
    deliveryId: row.delivery_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    attempts: row.attempts,
    url: row.url,
    secretEncrypted: row.secret_encrypted,
  }));
}

export async function settleWorkspaceWebhookDelivery(
  db: Database,
  input: {
    deliveryId: string;
    claimId: string;
    status: number | null;
    error: string | null;
    maxAttempts?: number;
  },
): Promise<boolean> {
  const [row] = await rawRows<{ settled: boolean }>(
    db,
    sql`select opengeni_private.settle_workspace_webhook_delivery_v1(
      ${input.deliveryId}::uuid,
      ${input.claimId}::uuid,
      ${input.status}::integer,
      ${input.error}::text,
      ${input.maxAttempts ?? WORKSPACE_WEBHOOK_MAX_ATTEMPTS}::integer
    ) as settled`,
  );
  return row?.settled === true;
}

export async function pruneWorkspaceWebhookDeliveries(
  db: Database,
  input: { retentionSeconds?: number; limit?: number } = {},
): Promise<number> {
  const [row] = await rawRows<{ pruned: number }>(
    db,
    sql`select opengeni_private.prune_workspace_webhook_deliveries_v1(
      ${input.retentionSeconds ?? 604_800}::integer, ${input.limit ?? 500}::integer
    ) as pruned`,
  );
  return row?.pruned ?? 0;
}

export type ClaimedOrganizationWebhookDelivery = ClaimedWorkspaceWebhookDelivery;

export async function claimOrganizationWebhookDeliveries(
  db: Database,
  input: { claimId: string; limit?: number; claimSeconds?: number },
): Promise<ClaimedOrganizationWebhookDelivery[]> {
  const rows = await rawRows<{
    delivery_id: string;
    account_id: string;
    workspace_id: string;
    webhook_id: string;
    event_id: string;
    event_type: string;
    payload: unknown;
    attempts: number;
    url: string;
    secret_encrypted: string;
  }>(
    db,
    sql`select * from opengeni_private.claim_organization_webhook_deliveries_v1(
    ${input.claimId}::uuid, ${input.limit ?? 32}::integer, ${input.claimSeconds ?? 60}::integer
  )`,
  );
  return rows.map((row) => ({
    deliveryId: row.delivery_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    attempts: row.attempts,
    url: row.url,
    secretEncrypted: row.secret_encrypted,
  }));
}

export async function settleOrganizationWebhookDelivery(
  db: Database,
  input: {
    deliveryId: string;
    claimId: string;
    status: number | null;
    error: string | null;
    maxAttempts?: number;
  },
): Promise<boolean> {
  const [row] = await rawRows<{ settled: boolean }>(
    db,
    sql`select opengeni_private.settle_organization_webhook_delivery_v1(
      ${input.deliveryId}::uuid, ${input.claimId}::uuid, ${input.status}::integer,
      ${input.error}::text, ${input.maxAttempts ?? WORKSPACE_WEBHOOK_MAX_ATTEMPTS}::integer
    ) as settled`,
  );
  return row?.settled === true;
}

export async function pruneOrganizationWebhookDeliveries(
  db: Database,
  input: { retentionSeconds?: number; limit?: number } = {},
): Promise<number> {
  const [row] = await rawRows<{ pruned: number }>(
    db,
    sql`select opengeni_private.prune_organization_webhook_deliveries_v1(
      ${input.retentionSeconds ?? 604_800}::integer, ${input.limit ?? 500}::integer
    ) as pruned`,
  );
  return row?.pruned ?? 0;
}
