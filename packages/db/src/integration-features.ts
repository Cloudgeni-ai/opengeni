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
  IntegrationFeatureBindingOwnershipConflictError,
  IntegrationFeatureBindingVersionConflictError,
  listIntegrationFeatureBindingOwners,
  removeIntegrationFeatureBindingOwner,
  upsertIntegrationFeatureBinding,
} from "./integration-bindings";
import * as schema from "./schema";

export type IntegrationFeatureKind =
  | "knowledge_source"
  | "inbound_trigger"
  | "delivery_destination"
  | "identity_link";

export type IntegrationFeatureBindingSummary = {
  id: string;
  featureKey: string;
  kind: IntegrationFeatureKind;
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
};

export type IntegrationFeatureDefinitionSummary = {
  featureKey: string;
  kind: IntegrationFeatureKind;
  configSchema: Record<string, unknown>;
  capabilities: Record<string, unknown>;
};

export type IntegrationInstanceFeatures = {
  capabilityId: string;
  instanceKey: string;
  providerDomain: string;
  connectionId: string | null;
  features: {
    definition: IntegrationFeatureDefinitionSummary;
    binding: IntegrationFeatureBindingSummary | null;
  }[];
};

export type IntegrationFeatureMutationResult = {
  capabilityId: string;
  instanceKey: string;
  featureKey: string;
  status: "configured" | "paused" | "active";
  binding: IntegrationFeatureBindingSummary;
};

export type IntegrationFeatureRemovalResult = {
  capabilityId: string;
  instanceKey: string;
  featureKey: string;
  status: "not_configured" | "removed" | "retained_by_other_owners";
  binding: IntegrationFeatureBindingSummary | null;
  remainingOwners: {
    kind: "direct" | "plugin" | "pack" | "migration";
    id: string;
    removable: boolean;
  }[];
};

export class IntegrationFeatureNotFoundError extends Error {
  readonly name = "IntegrationFeatureNotFoundError";
}

export class IntegrationFeatureConnectionError extends Error {
  readonly name = "IntegrationFeatureConnectionError";
}

export class IntegrationFeatureConfigError extends Error {
  readonly name = "IntegrationFeatureConfigError";
}

export class IntegrationFeatureOperationIdempotencyError extends Error {
  readonly name = "IntegrationFeatureOperationIdempotencyError";
}

type IntegrationInstanceContext = {
  accountId: string;
  integrationFacetInstallationId: string;
  integrationFacetId: string;
  providerDomain: string;
  connectionId: string | null;
};

export async function listIntegrationInstanceFeatures(
  db: Database,
  workspaceId: string,
  subjectId: string,
  capabilityId: string,
  instanceKey: string,
): Promise<IntegrationInstanceFeatures> {
  return await withWorkspaceSubjectRls(db, workspaceId, subjectId, async (scopedDb) => {
    const context = await loadIntegrationInstanceContext(
      scopedDb,
      workspaceId,
      subjectId,
      capabilityId,
      instanceKey,
    );
    if (!context) throw new IntegrationFeatureNotFoundError("Integration instance not found");
    const rows = await scopedDb
      .select({
        featureKey: schema.integrationFeatureFacets.featureKey,
        kind: schema.integrationFeatureFacets.kind,
        configSchema: schema.integrationFeatureFacets.configSchema,
        capabilities: schema.integrationFeatureFacets.capabilities,
        bindingId: schema.integrationFeatureBindings.id,
        bindingKey: schema.integrationFeatureBindings.bindingKey,
        displayName: schema.integrationFeatureBindings.displayName,
        connectionId: schema.integrationFeatureBindings.connectionId,
        status: schema.integrationFeatureBindings.status,
        config: schema.integrationFeatureBindings.config,
        cursor: schema.integrationFeatureBindings.cursor,
        version: schema.integrationFeatureBindings.version,
        lastSuccessAt: schema.integrationFeatureBindings.lastSuccessAt,
        lastErrorCode: schema.integrationFeatureBindings.lastErrorCode,
        createdAt: schema.integrationFeatureBindings.createdAt,
        updatedAt: schema.integrationFeatureBindings.updatedAt,
      })
      .from(schema.integrationFeatureFacets)
      .leftJoin(
        schema.integrationFeatureBindings,
        and(
          eq(schema.integrationFeatureBindings.featureFacetId, schema.integrationFeatureFacets.id),
          eq(
            schema.integrationFeatureBindings.integrationFacetInstallationId,
            context.integrationFacetInstallationId,
          ),
          eq(schema.integrationFeatureBindings.bindingKey, instanceKey),
        ),
      )
      .where(
        and(
          eq(schema.integrationFeatureFacets.integrationFacetId, context.integrationFacetId),
          ne(schema.integrationFeatureFacets.kind, "tools"),
        ),
      )
      .orderBy(
        asc(schema.integrationFeatureFacets.kind),
        asc(schema.integrationFeatureFacets.featureKey),
      );
    return {
      capabilityId,
      instanceKey,
      providerDomain: context.providerDomain,
      connectionId: context.connectionId,
      features: rows.map((row) => ({
        definition: {
          featureKey: row.featureKey,
          kind: featureKind(row.kind),
          configSchema: row.configSchema,
          capabilities: row.capabilities,
        },
        binding: row.bindingId
          ? bindingSummary({
              id: row.bindingId,
              featureKey: row.featureKey,
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
            })
          : null,
      })),
    };
  });
}

export async function configureIntegrationFeature(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    featureKey: string;
    displayName: string;
    config: Record<string, unknown>;
    expectedVersion?: number;
    idempotencyKey: string;
  },
): Promise<IntegrationFeatureMutationResult> {
  const requestDigest = sha256(
    stableJson({
      action: "configure",
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      featureKey: input.featureKey,
      displayName: input.displayName,
      config: input.config,
      expectedVersion: input.expectedVersion ?? null,
    }),
  );
  return await withFeatureOperation(db, input, requestDigest, "configure", async (tx) => {
    const context = await requireMutationContext(tx, input);
    const definition = await requireFeatureDefinition(tx, context, input.featureKey);
    assertFeatureConfig(input.config, definition.configSchema);
    await requireFeatureConnection(tx, input, context, definition.capabilities);
    const result = await upsertIntegrationFeatureBinding(tx, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      integrationFacetInstallationId: context.integrationFacetInstallationId,
      featureFacetId: definition.id,
      bindingKey: input.instanceKey,
      displayName: input.displayName,
      runtimeKey: null,
      connectionId: context.connectionId,
      config: input.config,
      createdBySubjectId: input.subjectId,
      owner: featureOwner(input.capabilityId, input.instanceKey, input.featureKey),
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    });
    return {
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      featureKey: input.featureKey,
      status: "configured",
      binding: bindingSummary({
        ...result.row,
        featureKey: definition.featureKey,
        kind: definition.kind,
      }),
    };
  });
}

export async function setIntegrationFeatureLifecycle(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    featureKey: string;
    action: "pause" | "resume";
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<IntegrationFeatureMutationResult> {
  const requestDigest = sha256(
    stableJson({
      ...input,
      accountId: undefined,
      workspaceId: undefined,
      subjectId: undefined,
      idempotencyKey: undefined,
    }),
  );
  return await withFeatureOperation(db, input, requestDigest, "update", async (tx) => {
    const context = await requireMutationContext(tx, input);
    const definition = await requireFeatureDefinition(tx, context, input.featureKey);
    const binding = await loadFeatureBinding(tx, context, input.instanceKey, definition.id, true);
    if (!binding || binding.status === "disabled") {
      throw new IntegrationFeatureNotFoundError("Integration feature is not configured");
    }
    if (binding.version !== input.expectedVersion) {
      throw new IntegrationFeatureBindingVersionConflictError(
        input.instanceKey,
        input.expectedVersion,
        binding.version,
      );
    }
    await assertDirectFeatureOwnership(tx, binding.id, input);
    const targetStatus = input.action === "pause" ? "paused" : "active";
    let row = binding;
    if (binding.status !== targetStatus) {
      const [updated] = await tx
        .update(schema.integrationFeatureBindings)
        .set({
          status: targetStatus,
          version: binding.version + 1,
          ...(input.action === "resume" ? { lastErrorCode: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.integrationFeatureBindings.id, binding.id))
        .returning();
      if (!updated) throw new Error("Failed to update Integration feature lifecycle");
      row = updated;
    }
    return {
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      featureKey: input.featureKey,
      status: input.action === "pause" ? "paused" : "active",
      binding: bindingSummary({
        ...row,
        featureKey: definition.featureKey,
        kind: definition.kind,
      }),
    };
  });
}

export async function removeIntegrationFeature(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    featureKey: string;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<IntegrationFeatureRemovalResult> {
  const requestDigest = sha256(
    stableJson({
      action: "remove",
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      featureKey: input.featureKey,
      expectedVersion: input.expectedVersion,
    }),
  );
  return await withFeatureOperation(db, input, requestDigest, "disconnect", async (tx) => {
    const context = await requireMutationContext(tx, input);
    const definition = await requireFeatureDefinition(tx, context, input.featureKey);
    const binding = await loadFeatureBinding(tx, context, input.instanceKey, definition.id, true);
    const owner = featureOwner(input.capabilityId, input.instanceKey, input.featureKey);
    if (!binding) {
      return {
        capabilityId: input.capabilityId,
        instanceKey: input.instanceKey,
        featureKey: input.featureKey,
        status: "not_configured",
        binding: null,
        remainingOwners: [],
      };
    }
    if (binding.version !== input.expectedVersion) {
      throw new IntegrationFeatureBindingVersionConflictError(
        input.instanceKey,
        input.expectedVersion,
        binding.version,
      );
    }
    const owners = await listIntegrationFeatureBindingOwners(tx, binding.id);
    if (!owners.some((candidate) => candidate.kind === owner.kind && candidate.id === owner.id)) {
      return {
        capabilityId: input.capabilityId,
        instanceKey: input.instanceKey,
        featureKey: input.featureKey,
        status: "not_configured",
        binding: bindingSummary({
          ...binding,
          featureKey: definition.featureKey,
          kind: definition.kind,
        }),
        remainingOwners: owners,
      };
    }
    const removed = await removeIntegrationFeatureBindingOwner(tx, {
      workspaceId: input.workspaceId,
      bindingId: binding.id,
      owner,
      expectedVersion: input.expectedVersion,
    });
    return {
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      featureKey: input.featureKey,
      status: removed.remainingOwners.length > 0 ? "retained_by_other_owners" : "removed",
      binding: removed.binding
        ? bindingSummary({
            ...removed.binding,
            featureKey: definition.featureKey,
            kind: definition.kind,
          })
        : null,
      remainingOwners: removed.remainingOwners,
    };
  });
}

async function withFeatureOperation<T extends Record<string, unknown>>(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    featureKey: string;
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
          if (existing.requestDigest !== requestDigest) {
            throw new IntegrationFeatureOperationIdempotencyError(
              "Integration feature idempotency key was reused",
            );
          }
          if (existing.status === "completed" && existing.result) return existing.result as T;
          throw new IntegrationFeatureOperationIdempotencyError(
            "Integration feature operation is already in progress",
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
            `${input.capabilityId}\0${input.instanceKey}\0${input.featureKey}`,
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
  if (!context) throw new IntegrationFeatureNotFoundError("Integration instance not found");
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
      accountId: schema.integrationFeatureBindings.accountId,
      integrationFacetInstallationId:
        schema.integrationFeatureBindings.integrationFacetInstallationId,
      integrationFacetId: schema.integrationFeatureFacets.integrationFacetId,
      providerDomain: schema.capabilityIntegrationFacets.providerDomain,
      connectionId: schema.integrationFeatureBindings.connectionId,
    })
    .from(schema.integrationFeatureBindings)
    .innerJoin(
      schema.integrationFeatureFacets,
      eq(schema.integrationFeatureFacets.id, schema.integrationFeatureBindings.featureFacetId),
    )
    .innerJoin(
      schema.capabilityIntegrationFacets,
      eq(
        schema.capabilityIntegrationFacets.facetId,
        schema.integrationFeatureFacets.integrationFacetId,
      ),
    )
    .innerJoin(
      schema.capabilityFacetInstallations,
      eq(
        schema.capabilityFacetInstallations.id,
        schema.integrationFeatureBindings.integrationFacetInstallationId,
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
        eq(schema.integrationFeatureBindings.workspaceId, workspaceId),
        eq(schema.integrationFeatureBindings.bindingKey, instanceKey),
        eq(schema.integrationFeatureBindings.status, "active"),
        eq(schema.integrationFeatureFacets.kind, "tools"),
        eq(schema.capabilityPluginInstallations.status, "active"),
        sql`${schema.capabilityPluginVersions.manifest} ->> 'capabilityId' = ${capabilityId}`,
        sql`(
          ${schema.integrationFeatureBindings.connectionId} is null
          or exists (
            select 1 from ${schema.connections} connection
            where connection.id = ${schema.integrationFeatureBindings.connectionId}
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

async function requireFeatureDefinition(
  db: Database,
  context: IntegrationInstanceContext,
  featureKey: string,
): Promise<typeof schema.integrationFeatureFacets.$inferSelect> {
  const [definition] = await db
    .select()
    .from(schema.integrationFeatureFacets)
    .where(
      and(
        eq(schema.integrationFeatureFacets.integrationFacetId, context.integrationFacetId),
        eq(schema.integrationFeatureFacets.featureKey, featureKey),
        ne(schema.integrationFeatureFacets.kind, "tools"),
      ),
    )
    .limit(1);
  if (!definition) throw new IntegrationFeatureNotFoundError("Integration feature not found");
  featureKind(definition.kind);
  return definition;
}

async function requireFeatureConnection(
  db: Database,
  input: { workspaceId: string; subjectId: string },
  context: IntegrationInstanceContext,
  capabilities: Record<string, unknown>,
): Promise<void> {
  if (!context.connectionId) {
    if (capabilities.connectionRequired === true) {
      throw new IntegrationFeatureConnectionError(
        "Integration feature requires the instance Connection",
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
    throw new IntegrationFeatureConnectionError(
      "Integration feature Connection is unavailable or does not match the provider",
    );
  }
}

async function loadFeatureBinding(
  db: Database,
  context: IntegrationInstanceContext,
  instanceKey: string,
  featureFacetId: string,
  lock = false,
): Promise<typeof schema.integrationFeatureBindings.$inferSelect | null> {
  let query = db
    .select()
    .from(schema.integrationFeatureBindings)
    .where(
      and(
        eq(
          schema.integrationFeatureBindings.integrationFacetInstallationId,
          context.integrationFacetInstallationId,
        ),
        eq(schema.integrationFeatureBindings.featureFacetId, featureFacetId),
        eq(schema.integrationFeatureBindings.bindingKey, instanceKey),
      ),
    )
    .limit(1);
  if (lock) query = query.for("update") as typeof query;
  const [binding] = await query;
  return binding ?? null;
}

async function assertDirectFeatureOwnership(
  db: Database,
  bindingId: string,
  input: { capabilityId: string; instanceKey: string; featureKey: string },
): Promise<void> {
  const expected = featureOwner(input.capabilityId, input.instanceKey, input.featureKey);
  const owners = await listIntegrationFeatureBindingOwners(db, bindingId);
  if (!owners.some((owner) => owner.kind === expected.kind && owner.id === expected.id)) {
    throw new IntegrationFeatureBindingOwnershipConflictError(
      "Integration feature is not directly owned",
    );
  }
  if (owners.some((owner) => owner.kind !== expected.kind || owner.id !== expected.id)) {
    throw new IntegrationFeatureBindingOwnershipConflictError(
      "Integration feature is shared by another owner and cannot change lifecycle in place",
    );
  }
}

function featureOwner(capabilityId: string, instanceKey: string, featureKey: string) {
  return {
    kind: "direct" as const,
    id: `feature:${sha256(`${capabilityId}\0${instanceKey}\0${featureKey}`)}`,
    removable: true,
  };
}

type BindingSummaryRow = Pick<
  typeof schema.integrationFeatureBindings.$inferSelect,
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
  featureKey: string;
  kind: string;
};

function bindingSummary(row: BindingSummaryRow): IntegrationFeatureBindingSummary {
  return {
    id: row.id,
    featureKey: row.featureKey,
    kind: featureKind(row.kind),
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
  };
}

function featureKind(value: string): IntegrationFeatureKind {
  if (
    value !== "knowledge_source" &&
    value !== "inbound_trigger" &&
    value !== "delivery_destination" &&
    value !== "identity_link"
  ) {
    throw new Error(`Unknown Integration feature kind: ${value}`);
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
    throw new Error(`Unknown Integration feature status: ${value}`);
  }
  return value;
}

function assertFeatureConfig(
  config: Record<string, unknown>,
  schemaValue: Record<string, unknown>,
): void {
  const serialized = stableJson(config);
  if (Buffer.byteLength(serialized, "utf8") > 131_072) {
    throw new IntegrationFeatureConfigError("Integration feature config exceeds 131072 bytes");
  }
  validateSchemaValue(config, schemaValue, "config", 0);
}

function validateSchemaValue(
  value: unknown,
  schemaValue: Record<string, unknown>,
  path: string,
  depth: number,
): void {
  if (depth > 8) throw new IntegrationFeatureConfigError(`${path} exceeds supported depth`);
  const type = schemaValue.type;
  if (
    Array.isArray(schemaValue.enum) &&
    !schemaValue.enum.some((item) => stableJson(item) === stableJson(value))
  ) {
    throw new IntegrationFeatureConfigError(`${path} is not an allowed value`);
  }
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new IntegrationFeatureConfigError(`${path} must be an object`);
    }
    const object = value as Record<string, unknown>;
    const properties = objectValue(schemaValue.properties);
    const required = Array.isArray(schemaValue.required)
      ? schemaValue.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    for (const key of required) {
      if (!(key in object)) throw new IntegrationFeatureConfigError(`${path}.${key} is required`);
    }
    if (schemaValue.additionalProperties === false) {
      const unknown = Object.keys(object).find((key) => !(key in properties));
      if (unknown) throw new IntegrationFeatureConfigError(`${path}.${unknown} is not supported`);
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
      throw new IntegrationFeatureConfigError(`${path} must be an array`);
    }
    if (typeof schemaValue.minItems === "number" && value.length < schemaValue.minItems) {
      throw new IntegrationFeatureConfigError(`${path} has too few items`);
    }
    if (typeof schemaValue.maxItems === "number" && value.length > schemaValue.maxItems) {
      throw new IntegrationFeatureConfigError(`${path} has too many items`);
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
      throw new IntegrationFeatureConfigError(`${path} must be a string`);
    if (typeof schemaValue.minLength === "number" && value.length < schemaValue.minLength) {
      throw new IntegrationFeatureConfigError(`${path} is too short`);
    }
    if (typeof schemaValue.maxLength === "number" && value.length > schemaValue.maxLength) {
      throw new IntegrationFeatureConfigError(`${path} is too long`);
    }
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean")
      throw new IntegrationFeatureConfigError(`${path} must be a boolean`);
    return;
  }
  if (type === "integer" || type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (type === "integer" && !Number.isInteger(value))
    ) {
      throw new IntegrationFeatureConfigError(
        `${path} must be ${type === "integer" ? "an integer" : "a number"}`,
      );
    }
    if (typeof schemaValue.minimum === "number" && value < schemaValue.minimum) {
      throw new IntegrationFeatureConfigError(`${path} is below the minimum`);
    }
    if (typeof schemaValue.maximum === "number" && value > schemaValue.maximum) {
      throw new IntegrationFeatureConfigError(`${path} exceeds the maximum`);
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
