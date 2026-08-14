import { createHash } from "node:crypto";

import { stableJson } from "@opengeni/contracts";
import { and, asc, eq, ne, sql } from "drizzle-orm";

import {
  setSubjectRlsContext,
  withRlsContext,
  withWorkspaceSubjectRls,
  type Database,
} from "./database";
import {
  IntegrationFacetBindingOwnershipConflictError,
  IntegrationFacetBindingVersionConflictError,
  listIntegrationFacetBindingOwners,
  listIntegrationFacetBindingOwnersForBindings,
  removeIntegrationFacetBindingOwner,
  upsertIntegrationFacetBinding,
  type IntegrationFacetBindingOwner,
} from "./integration-bindings";
import * as schema from "./schema";

export type IntegrationFacetKind =
  | "knowledge_source"
  | "inbound_trigger"
  | "delivery_destination"
  | "identity_link";

export type IntegrationFacetBindingSummary = {
  id: string;
  facetKey: string;
  kind: IntegrationFacetKind;
  bindingKey: string;
  displayName: string;
  connectionId: string | null;
  status: "active" | "paused" | "needs_attention" | "disabled";
  config: Record<string, unknown>;
  version: number;
  hasCursor: boolean;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  directlyOwned: boolean;
  owners: IntegrationFacetBindingOwner[];
};

export type IntegrationFacetDefinitionSummary = {
  facetKey: string;
  kind: IntegrationFacetKind;
  configSchema: Record<string, unknown>;
  capabilities: Record<string, unknown>;
};

export type IntegrationInstanceFacets = {
  capabilityId: string;
  instanceKey: string;
  providerDomain: string;
  connectionId: string | null;
  facets: {
    definition: IntegrationFacetDefinitionSummary;
    binding: IntegrationFacetBindingSummary | null;
  }[];
};

export type IntegrationFacetMutationResult = {
  capabilityId: string;
  instanceKey: string;
  facetKey: string;
  status: "configured" | "paused" | "active";
  binding: IntegrationFacetBindingSummary;
};

export type IntegrationFacetRemovalResult = {
  capabilityId: string;
  instanceKey: string;
  facetKey: string;
  status: "not_configured" | "removed" | "retained_by_other_owners";
  binding: IntegrationFacetBindingSummary | null;
  remainingOwners: {
    kind: "direct" | "plugin" | "pack" | "migration";
    id: string;
    removable: boolean;
  }[];
};

export class IntegrationFacetNotFoundError extends Error {
  readonly name = "IntegrationFacetNotFoundError";
}

export class IntegrationFacetConnectionError extends Error {
  readonly name = "IntegrationFacetConnectionError";
}

export class IntegrationFacetConfigError extends Error {
  readonly name = "IntegrationFacetConfigError";
}

export class IntegrationFacetOperationIdempotencyError extends Error {
  readonly name = "IntegrationFacetOperationIdempotencyError";
}

type IntegrationInstanceContext = {
  accountId: string;
  integrationFacetInstallationId: string;
  integrationFacetId: string;
  providerDomain: string;
  connectionId: string | null;
};

export async function listIntegrationInstanceFacets(
  db: Database,
  workspaceId: string,
  subjectId: string,
  capabilityId: string,
  instanceKey: string,
): Promise<IntegrationInstanceFacets> {
  return await withWorkspaceSubjectRls(db, workspaceId, subjectId, async (scopedDb) => {
    const context = await loadIntegrationInstanceContext(
      scopedDb,
      workspaceId,
      subjectId,
      capabilityId,
      instanceKey,
    );
    if (!context) throw new IntegrationFacetNotFoundError("Integration instance not found");
    const rows = await scopedDb
      .select({
        facetKey: schema.integrationFacetDefinitions.facetKey,
        kind: schema.integrationFacetDefinitions.kind,
        configSchema: schema.integrationFacetDefinitions.configSchema,
        capabilities: schema.integrationFacetDefinitions.capabilities,
        bindingId: schema.integrationFacetBindings.id,
        bindingKey: schema.integrationFacetBindings.bindingKey,
        displayName: schema.integrationFacetBindings.displayName,
        connectionId: schema.integrationFacetBindings.connectionId,
        status: schema.integrationFacetBindings.status,
        config: schema.integrationFacetBindings.config,
        cursor: schema.integrationFacetBindings.cursor,
        version: schema.integrationFacetBindings.version,
        lastSuccessAt: schema.integrationFacetBindings.lastSuccessAt,
        lastErrorCode: schema.integrationFacetBindings.lastErrorCode,
        createdAt: schema.integrationFacetBindings.createdAt,
        updatedAt: schema.integrationFacetBindings.updatedAt,
      })
      .from(schema.integrationFacetDefinitions)
      .leftJoin(
        schema.integrationFacetBindings,
        and(
          eq(
            schema.integrationFacetBindings.facetDefinitionId,
            schema.integrationFacetDefinitions.id,
          ),
          eq(
            schema.integrationFacetBindings.integrationFacetInstallationId,
            context.integrationFacetInstallationId,
          ),
          eq(schema.integrationFacetBindings.bindingKey, instanceKey),
        ),
      )
      .where(
        and(
          eq(schema.integrationFacetDefinitions.integrationFacetId, context.integrationFacetId),
          ne(schema.integrationFacetDefinitions.kind, "tools"),
        ),
      )
      .orderBy(
        asc(schema.integrationFacetDefinitions.kind),
        asc(schema.integrationFacetDefinitions.facetKey),
      );
    const ownersByBindingId = await listIntegrationFacetBindingOwnersForBindings(
      scopedDb,
      rows.flatMap((row) => (row.bindingId ? [row.bindingId] : [])),
    );
    return {
      capabilityId,
      instanceKey,
      providerDomain: context.providerDomain,
      connectionId: context.connectionId,
      facets: rows.map((row) => ({
        definition: {
          facetKey: row.facetKey,
          kind: facetKind(row.kind),
          configSchema: row.configSchema,
          capabilities: row.capabilities,
        },
        binding: row.bindingId
          ? bindingSummary(
              {
                id: row.bindingId,
                facetKey: row.facetKey,
                kind: row.kind,
                bindingKey: row.bindingKey!,
                displayName: row.displayName!,
                connectionId: row.connectionId ?? null,
                status: row.status!,
                config: row.config!,
                cursor: row.cursor!,
                version: row.version!,
                lastSuccessAt: row.lastSuccessAt ?? null,
                lastErrorCode: row.lastErrorCode ?? null,
                createdAt: row.createdAt!,
                updatedAt: row.updatedAt!,
              },
              ownersByBindingId.get(row.bindingId) ?? [],
              { capabilityId, instanceKey, facetKey: row.facetKey },
            )
          : null,
      })),
    };
  });
}

export async function configureIntegrationFacet(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    facetKey: string;
    displayName: string;
    config: Record<string, unknown>;
    expectedVersion?: number;
    idempotencyKey: string;
  },
): Promise<IntegrationFacetMutationResult> {
  const requestDigest = sha256(
    stableJson({
      action: "configure",
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      facetKey: input.facetKey,
      displayName: input.displayName,
      config: input.config,
      expectedVersion: input.expectedVersion ?? null,
    }),
  );
  return await withFacetOperation(db, input, requestDigest, "configure", async (tx) => {
    const context = await requireMutationContext(tx, input);
    const definition = await requireFacetDefinition(tx, context, input.facetKey);
    assertFacetConfig(input.config, definition.configSchema);
    await requireFacetConnection(tx, input, context, definition.capabilities);
    const result = await upsertIntegrationFacetBinding(tx, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      integrationFacetInstallationId: context.integrationFacetInstallationId,
      facetDefinitionId: definition.id,
      bindingKey: input.instanceKey,
      displayName: input.displayName,
      runtimeKey: null,
      connectionId: context.connectionId,
      config: input.config,
      createdBySubjectId: input.subjectId,
      owner: facetOwner(input.capabilityId, input.instanceKey, input.facetKey),
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    });
    const owners = await listIntegrationFacetBindingOwners(tx, result.row.id);
    return {
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      facetKey: input.facetKey,
      status: "configured",
      binding: bindingSummary(
        {
          ...result.row,
          facetKey: definition.facetKey,
          kind: definition.kind,
        },
        owners,
        input,
      ),
    };
  });
}

export async function setIntegrationFacetLifecycle(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    facetKey: string;
    action: "pause" | "resume";
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<IntegrationFacetMutationResult> {
  const requestDigest = sha256(
    stableJson({
      ...input,
      accountId: undefined,
      workspaceId: undefined,
      subjectId: undefined,
      idempotencyKey: undefined,
    }),
  );
  return await withFacetOperation(db, input, requestDigest, "update", async (tx) => {
    const context = await requireMutationContext(tx, input);
    const definition = await requireFacetDefinition(tx, context, input.facetKey);
    const binding = await loadFacetBinding(tx, context, input.instanceKey, definition.id, true);
    if (!binding || binding.status === "disabled") {
      throw new IntegrationFacetNotFoundError("Integration facet is not configured");
    }
    if (binding.version !== input.expectedVersion) {
      throw new IntegrationFacetBindingVersionConflictError(
        input.instanceKey,
        input.expectedVersion,
        binding.version,
      );
    }
    await assertDirectFacetOwnership(tx, binding.id, input);
    const targetStatus = input.action === "pause" ? "paused" : "active";
    let row = binding;
    if (binding.status !== targetStatus) {
      const [updated] = await tx
        .update(schema.integrationFacetBindings)
        .set({
          status: targetStatus,
          version: binding.version + 1,
          ...(input.action === "resume" ? { lastErrorCode: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.integrationFacetBindings.id, binding.id))
        .returning();
      if (!updated) throw new Error("Failed to update Integration facet lifecycle");
      row = updated;
    }
    const owners = await listIntegrationFacetBindingOwners(tx, row.id);
    return {
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      facetKey: input.facetKey,
      status: input.action === "pause" ? "paused" : "active",
      binding: bindingSummary(
        {
          ...row,
          facetKey: definition.facetKey,
          kind: definition.kind,
        },
        owners,
        input,
      ),
    };
  });
}

export async function removeIntegrationFacet(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    facetKey: string;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<IntegrationFacetRemovalResult> {
  const requestDigest = sha256(
    stableJson({
      action: "remove",
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      facetKey: input.facetKey,
      expectedVersion: input.expectedVersion,
    }),
  );
  return await withFacetOperation(db, input, requestDigest, "disconnect", async (tx) => {
    const context = await requireMutationContext(tx, input);
    const definition = await requireFacetDefinition(tx, context, input.facetKey);
    const binding = await loadFacetBinding(tx, context, input.instanceKey, definition.id, true);
    const owner = facetOwner(input.capabilityId, input.instanceKey, input.facetKey);
    if (!binding) {
      return {
        capabilityId: input.capabilityId,
        instanceKey: input.instanceKey,
        facetKey: input.facetKey,
        status: "not_configured",
        binding: null,
        remainingOwners: [],
      };
    }
    if (binding.version !== input.expectedVersion) {
      throw new IntegrationFacetBindingVersionConflictError(
        input.instanceKey,
        input.expectedVersion,
        binding.version,
      );
    }
    const owners = await listIntegrationFacetBindingOwners(tx, binding.id);
    if (!owners.some((candidate) => candidate.kind === owner.kind && candidate.id === owner.id)) {
      return {
        capabilityId: input.capabilityId,
        instanceKey: input.instanceKey,
        facetKey: input.facetKey,
        status: "not_configured",
        binding: bindingSummary(
          {
            ...binding,
            facetKey: definition.facetKey,
            kind: definition.kind,
          },
          owners,
          input,
        ),
        remainingOwners: owners,
      };
    }
    const removed = await removeIntegrationFacetBindingOwner(tx, {
      workspaceId: input.workspaceId,
      bindingId: binding.id,
      owner,
      expectedVersion: input.expectedVersion,
    });
    const effectiveRemainingOwners = removed.binding
      ? await listIntegrationFacetBindingOwners(tx, removed.binding.id)
      : [];
    return {
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      facetKey: input.facetKey,
      status: removed.remainingOwners.length > 0 ? "retained_by_other_owners" : "removed",
      binding: removed.binding
        ? bindingSummary(
            {
              ...removed.binding,
              facetKey: definition.facetKey,
              kind: definition.kind,
            },
            effectiveRemainingOwners,
            input,
          )
        : null,
      remainingOwners: removed.remainingOwners,
    };
  });
}

async function withFacetOperation<T extends Record<string, unknown>>(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    facetKey: string;
    idempotencyKey: string;
  },
  requestDigest: string,
  kind: string,
  execute: (tx: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.subjectId);
      return await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`capability-operation:${input.workspaceId}:${input.idempotencyKey}`}, 0))`,
        );
        const [existing] = await tx
          .select()
          .from(schema.capabilityOperations)
          .where(
            and(
              eq(schema.capabilityOperations.workspaceId, input.workspaceId),
              eq(schema.capabilityOperations.idempotencyKey, input.idempotencyKey),
            ),
          )
          .for("update")
          .limit(1);
        if (existing) {
          if (
            existing.createdBySubjectId !== input.subjectId ||
            existing.requestDigest !== requestDigest
          ) {
            throw new IntegrationFacetOperationIdempotencyError(
              "Integration facet idempotency key was reused",
            );
          }
          if (existing.status === "completed" && existing.result) return existing.result as T;
          throw new IntegrationFacetOperationIdempotencyError(
            "Integration facet operation is already in progress",
          );
        }
        const result = await execute(tx);
        await tx.insert(schema.capabilityOperations).values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          kind,
          targetKind: "facet_binding",
          targetId: `facet:${sha256(
            `${input.capabilityId}\0${input.instanceKey}\0${input.facetKey}`,
          )}`,
          status: "completed",
          phase: "completed",
          result,
          createdBySubjectId: input.subjectId,
          completedAt: new Date(),
        });
        return result;
      });
    },
  );
}

async function requireMutationContext(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
  },
): Promise<IntegrationInstanceContext> {
  const context = await loadIntegrationInstanceContext(
    db,
    input.workspaceId,
    input.subjectId,
    input.capabilityId,
    input.instanceKey,
    true,
  );
  if (!context) throw new IntegrationFacetNotFoundError("Integration instance not found");
  return context;
}

async function loadIntegrationInstanceContext(
  db: Database,
  workspaceId: string,
  subjectId: string,
  capabilityId: string,
  instanceKey: string,
  lock = false,
): Promise<IntegrationInstanceContext | null> {
  let query = db
    .select({
      accountId: schema.integrationFacetBindings.accountId,
      integrationFacetInstallationId:
        schema.integrationFacetBindings.integrationFacetInstallationId,
      integrationFacetId: schema.integrationFacetDefinitions.integrationFacetId,
      providerDomain: schema.capabilityIntegrationFacets.providerDomain,
      connectionId: schema.integrationFacetBindings.connectionId,
    })
    .from(schema.integrationFacetBindings)
    .innerJoin(
      schema.integrationFacetDefinitions,
      eq(schema.integrationFacetDefinitions.id, schema.integrationFacetBindings.facetDefinitionId),
    )
    .innerJoin(
      schema.capabilityIntegrationFacets,
      eq(
        schema.capabilityIntegrationFacets.facetId,
        schema.integrationFacetDefinitions.integrationFacetId,
      ),
    )
    .innerJoin(
      schema.capabilityFacetInstallations,
      eq(
        schema.capabilityFacetInstallations.id,
        schema.integrationFacetBindings.integrationFacetInstallationId,
      ),
    )
    .innerJoin(
      schema.capabilityPluginInstallations,
      eq(
        schema.capabilityPluginInstallations.id,
        schema.capabilityFacetInstallations.pluginInstallationId,
      ),
    )
    .innerJoin(
      schema.capabilityPluginVersions,
      eq(schema.capabilityPluginVersions.id, schema.capabilityPluginInstallations.pluginVersionId),
    )
    .where(
      and(
        eq(schema.integrationFacetBindings.workspaceId, workspaceId),
        eq(schema.integrationFacetBindings.bindingKey, instanceKey),
        eq(schema.integrationFacetBindings.status, "active"),
        eq(schema.integrationFacetDefinitions.kind, "tools"),
        eq(schema.capabilityPluginInstallations.status, "active"),
        sql`${schema.capabilityPluginVersions.manifest} ->> 'capabilityId' = ${capabilityId}`,
        sql`(
          ${schema.integrationFacetBindings.connectionId} is null
          or exists (
            select 1 from ${schema.connections} connection
            where connection.id = ${schema.integrationFacetBindings.connectionId}
              and (connection.subject_id is null or connection.subject_id = ${subjectId})
          )
        )`,
      ),
    )
    .limit(2);
  if (lock) query = query.for("update") as typeof query;
  const rows = await query;
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error(`API Integration ${capabilityId} instance is ambiguous`);
  return rows[0]!;
}

async function requireFacetDefinition(
  db: Database,
  context: IntegrationInstanceContext,
  facetKey: string,
): Promise<typeof schema.integrationFacetDefinitions.$inferSelect> {
  const [definition] = await db
    .select()
    .from(schema.integrationFacetDefinitions)
    .where(
      and(
        eq(schema.integrationFacetDefinitions.integrationFacetId, context.integrationFacetId),
        eq(schema.integrationFacetDefinitions.facetKey, facetKey),
        ne(schema.integrationFacetDefinitions.kind, "tools"),
      ),
    )
    .limit(1);
  if (!definition) throw new IntegrationFacetNotFoundError("Integration facet not found");
  facetKind(definition.kind);
  return definition;
}

async function requireFacetConnection(
  db: Database,
  input: { workspaceId: string; subjectId: string },
  context: IntegrationInstanceContext,
  capabilities: Record<string, unknown>,
): Promise<void> {
  if (!context.connectionId) {
    if (capabilities.connectionRequired === true) {
      throw new IntegrationFacetConnectionError(
        "Integration facet requires the instance Connection",
      );
    }
    return;
  }
  const [connection] = await db
    .select({
      providerDomain: schema.connections.providerDomain,
      subjectId: schema.connections.subjectId,
      status: schema.connections.status,
    })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, input.workspaceId),
        eq(schema.connections.id, context.connectionId),
      ),
    )
    .limit(1);
  if (
    !connection ||
    connection.status !== "active" ||
    (connection.subjectId !== null && connection.subjectId !== input.subjectId) ||
    connection.providerDomain.toLowerCase() !== context.providerDomain.toLowerCase()
  ) {
    throw new IntegrationFacetConnectionError(
      "Integration facet Connection is unavailable or does not match the provider",
    );
  }
}

async function loadFacetBinding(
  db: Database,
  context: IntegrationInstanceContext,
  instanceKey: string,
  facetDefinitionId: string,
  lock = false,
): Promise<typeof schema.integrationFacetBindings.$inferSelect | null> {
  let query = db
    .select()
    .from(schema.integrationFacetBindings)
    .where(
      and(
        eq(
          schema.integrationFacetBindings.integrationFacetInstallationId,
          context.integrationFacetInstallationId,
        ),
        eq(schema.integrationFacetBindings.facetDefinitionId, facetDefinitionId),
        eq(schema.integrationFacetBindings.bindingKey, instanceKey),
      ),
    )
    .limit(1);
  if (lock) query = query.for("update") as typeof query;
  const [binding] = await query;
  return binding ?? null;
}

async function assertDirectFacetOwnership(
  db: Database,
  bindingId: string,
  input: { capabilityId: string; instanceKey: string; facetKey: string },
): Promise<void> {
  const expected = facetOwner(input.capabilityId, input.instanceKey, input.facetKey);
  const owners = await listIntegrationFacetBindingOwners(db, bindingId);
  if (!owners.some((owner) => owner.kind === expected.kind && owner.id === expected.id)) {
    throw new IntegrationFacetBindingOwnershipConflictError(
      "Integration facet is not directly owned",
    );
  }
  if (owners.some((owner) => owner.kind !== expected.kind || owner.id !== expected.id)) {
    throw new IntegrationFacetBindingOwnershipConflictError(
      "Integration facet is shared by another owner and cannot change lifecycle in place",
    );
  }
}

function facetOwner(capabilityId: string, instanceKey: string, facetKey: string) {
  return {
    kind: "direct" as const,
    id: `facet:${sha256(`${capabilityId}\0${instanceKey}\0${facetKey}`)}`,
    removable: true,
  };
}

type BindingSummaryRow = Pick<
  typeof schema.integrationFacetBindings.$inferSelect,
  | "id"
  | "bindingKey"
  | "displayName"
  | "connectionId"
  | "status"
  | "config"
  | "cursor"
  | "version"
  | "lastSuccessAt"
  | "lastErrorCode"
  | "createdAt"
  | "updatedAt"
> & {
  facetKey: string;
  kind: string;
};

function bindingSummary(
  row: BindingSummaryRow,
  owners: IntegrationFacetBindingOwner[],
  identity: { capabilityId: string; instanceKey: string; facetKey: string },
): IntegrationFacetBindingSummary {
  const expectedOwner = facetOwner(identity.capabilityId, identity.instanceKey, identity.facetKey);
  return {
    id: row.id,
    facetKey: row.facetKey,
    kind: facetKind(row.kind),
    bindingKey: row.bindingKey,
    displayName: row.displayName,
    connectionId: row.connectionId,
    status: bindingStatus(row.status),
    config: row.config,
    version: row.version,
    hasCursor: Object.keys(row.cursor).length > 0,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    directlyOwned: owners.some(
      (owner) => owner.kind === expectedOwner.kind && owner.id === expectedOwner.id,
    ),
    owners,
  };
}

function facetKind(value: string): IntegrationFacetKind {
  if (
    value !== "knowledge_source" &&
    value !== "inbound_trigger" &&
    value !== "delivery_destination" &&
    value !== "identity_link"
  ) {
    throw new Error(`Unknown Integration facet kind: ${value}`);
  }
  return value;
}

function bindingStatus(value: string): "active" | "paused" | "needs_attention" | "disabled" {
  if (
    value !== "active" &&
    value !== "paused" &&
    value !== "needs_attention" &&
    value !== "disabled"
  ) {
    throw new Error(`Unknown Integration facet status: ${value}`);
  }
  return value;
}

function assertFacetConfig(
  config: Record<string, unknown>,
  schemaValue: Record<string, unknown>,
): void {
  const serialized = stableJson(config);
  if (Buffer.byteLength(serialized, "utf8") > 131_072) {
    throw new IntegrationFacetConfigError("Integration facet config exceeds 131072 bytes");
  }
  validateSchemaValue(config, schemaValue, "config", 0);
}

function validateSchemaValue(
  value: unknown,
  schemaValue: Record<string, unknown>,
  path: string,
  depth: number,
): void {
  if (depth > 8) throw new IntegrationFacetConfigError(`${path} exceeds supported depth`);
  const type = schemaValue.type;
  if (
    Array.isArray(schemaValue.enum) &&
    !schemaValue.enum.some((item) => stableJson(item) === stableJson(value))
  ) {
    throw new IntegrationFacetConfigError(`${path} is not an allowed value`);
  }
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new IntegrationFacetConfigError(`${path} must be an object`);
    }
    const object = value as Record<string, unknown>;
    const properties = objectValue(schemaValue.properties);
    const required = Array.isArray(schemaValue.required)
      ? schemaValue.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    for (const key of required) {
      if (!(key in object)) throw new IntegrationFacetConfigError(`${path}.${key} is required`);
    }
    if (schemaValue.additionalProperties === false) {
      const unknown = Object.keys(object).find((key) => !(key in properties));
      if (unknown) throw new IntegrationFacetConfigError(`${path}.${unknown} is not supported`);
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = objectValue(properties[key]);
      if (Object.keys(childSchema).length > 0) {
        validateSchemaValue(child, childSchema, `${path}.${key}`, depth + 1);
      }
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      throw new IntegrationFacetConfigError(`${path} must be an array`);
    }
    if (typeof schemaValue.minItems === "number" && value.length < schemaValue.minItems) {
      throw new IntegrationFacetConfigError(`${path} has too few items`);
    }
    if (typeof schemaValue.maxItems === "number" && value.length > schemaValue.maxItems) {
      throw new IntegrationFacetConfigError(`${path} has too many items`);
    }
    const itemSchema = objectValue(schemaValue.items);
    if (Object.keys(itemSchema).length > 0) {
      value.forEach((item, index) =>
        validateSchemaValue(item, itemSchema, `${path}[${index}]`, depth + 1),
      );
    }
    return;
  }
  if (type === "string") {
    if (typeof value !== "string")
      throw new IntegrationFacetConfigError(`${path} must be a string`);
    if (typeof schemaValue.minLength === "number" && value.length < schemaValue.minLength) {
      throw new IntegrationFacetConfigError(`${path} is too short`);
    }
    if (typeof schemaValue.maxLength === "number" && value.length > schemaValue.maxLength) {
      throw new IntegrationFacetConfigError(`${path} is too long`);
    }
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean")
      throw new IntegrationFacetConfigError(`${path} must be a boolean`);
    return;
  }
  if (type === "integer" || type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (type === "integer" && !Number.isInteger(value))
    ) {
      throw new IntegrationFacetConfigError(
        `${path} must be ${type === "integer" ? "an integer" : "a number"}`,
      );
    }
    if (typeof schemaValue.minimum === "number" && value < schemaValue.minimum) {
      throw new IntegrationFacetConfigError(`${path} is below the minimum`);
    }
    if (typeof schemaValue.maximum === "number" && value > schemaValue.maximum) {
      throw new IntegrationFacetConfigError(`${path} exceeds the maximum`);
    }
    return;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
