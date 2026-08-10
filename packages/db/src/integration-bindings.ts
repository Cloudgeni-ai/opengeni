import { createHash } from "node:crypto";

import { stableJson } from "@opengeni/contracts";
import { and, asc, eq, or, sql } from "drizzle-orm";

import type { Database } from "./database";
import * as schema from "./schema";

export type IntegrationFeatureBindingOwner = {
  kind: "direct" | "plugin" | "pack" | "migration";
  id: string;
  removable: boolean;
};

export type UpsertIntegrationFeatureBindingInput = {
  accountId: string;
  workspaceId: string;
  integrationFacetInstallationId: string;
  featureFacetId: string;
  bindingKey: string;
  displayName: string;
  runtimeKey?: string | null;
  connectionId?: string | null;
  config: Record<string, unknown>;
  createdBySubjectId: string;
  owner: IntegrationFeatureBindingOwner;
  expectedVersion?: number;
};

export class IntegrationFeatureBindingVersionConflictError extends Error {
  readonly name = "IntegrationFeatureBindingVersionConflictError";

  constructor(
    readonly bindingKey: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Integration instance ${bindingKey} changed: expected version ${expectedVersion}, current version ${actualVersion}`,
    );
  }
}

export class IntegrationFeatureBindingVersionRequiredError extends Error {
  readonly name = "IntegrationFeatureBindingVersionRequiredError";
}

export class IntegrationFeatureBindingOwnershipConflictError extends Error {
  readonly name = "IntegrationFeatureBindingOwnershipConflictError";
}

export function integrationBindingKey(
  connectionId: string | null | undefined,
  requested?: string | null,
): string {
  const explicit = requested?.trim().toLowerCase();
  if (explicit) {
    assertBindingKey(explicit);
    return explicit;
  }
  if (!connectionId) return "default";
  return `account-${sha256(`connection\0${connectionId}`).slice(0, 24)}`;
}

export function integrationRuntimeKey(baseServerId: string, bindingKey: string): string {
  assertBindingKey(bindingKey);
  const suffix = sha256(`integration-instance\0${baseServerId}\0${bindingKey}`).slice(0, 16);
  const head = baseServerId.slice(0, 110).replace(/[^A-Za-z0-9._-]/g, "_");
  const runtimeKey = `${head}_${suffix}`;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(runtimeKey)) {
    throw new Error("Integration instance runtime key is invalid");
  }
  return runtimeKey;
}

export async function ensureIntegrationFeatureFacet(
  db: Database,
  input: {
    integrationFacetId: string;
    featureKey: string;
    kind:
      | "tools"
      | "knowledge_source"
      | "inbound_trigger"
      | "delivery_destination"
      | "identity_link";
    configSchema?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
  },
): Promise<typeof schema.integrationFeatureFacets.$inferSelect> {
  const [existing] = await db
    .select()
    .from(schema.integrationFeatureFacets)
    .where(
      and(
        eq(schema.integrationFeatureFacets.integrationFacetId, input.integrationFacetId),
        eq(schema.integrationFeatureFacets.featureKey, input.featureKey),
      ),
    )
    .limit(1);
  const configSchema = input.configSchema ?? {};
  const capabilities = input.capabilities ?? {};
  if (existing) {
    if (
      existing.kind !== input.kind ||
      stableJson(existing.configSchema) !== stableJson(configSchema) ||
      stableJson(existing.capabilities) !== stableJson(capabilities)
    ) {
      throw new Error(`Integration feature ${input.featureKey} conflicts with stored definition`);
    }
    return existing;
  }
  const [created] = await db
    .insert(schema.integrationFeatureFacets)
    .values({
      integrationFacetId: input.integrationFacetId,
      featureKey: input.featureKey,
      kind: input.kind,
      configSchema,
      capabilities,
    })
    .returning();
  if (!created) throw new Error(`Failed to create Integration feature ${input.featureKey}`);
  return created;
}

export async function upsertIntegrationFeatureBinding(
  db: Database,
  input: UpsertIntegrationFeatureBindingInput,
): Promise<{ row: typeof schema.integrationFeatureBindings.$inferSelect; changed: boolean }> {
  assertBindingKey(input.bindingKey);
  if (input.displayName.trim().length === 0 || input.displayName.trim().length > 200) {
    throw new Error("Integration instance display name must contain 1-200 characters");
  }
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`integration-binding:${input.workspaceId}:${input.runtimeKey ?? `${input.featureFacetId}:${input.bindingKey}`}`}, 0))`,
  );
  const [existing] = await db
    .select()
    .from(schema.integrationFeatureBindings)
    .where(
      and(
        eq(schema.integrationFeatureBindings.workspaceId, input.workspaceId),
        input.runtimeKey
          ? eq(schema.integrationFeatureBindings.runtimeKey, input.runtimeKey)
          : and(
              eq(
                schema.integrationFeatureBindings.integrationFacetInstallationId,
                input.integrationFacetInstallationId,
              ),
              eq(schema.integrationFeatureBindings.featureFacetId, input.featureFacetId),
              eq(schema.integrationFeatureBindings.bindingKey, input.bindingKey),
            ),
      ),
    )
    .for("update")
    .limit(1);
  if (!existing) {
    if (input.expectedVersion !== undefined) {
      throw new IntegrationFeatureBindingVersionConflictError(
        input.bindingKey,
        input.expectedVersion,
        0,
      );
    }
    const [created] = await db
      .insert(schema.integrationFeatureBindings)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        integrationFacetInstallationId: input.integrationFacetInstallationId,
        featureFacetId: input.featureFacetId,
        bindingKey: input.bindingKey,
        displayName: input.displayName.trim(),
        runtimeKey: input.runtimeKey ?? null,
        connectionId: input.connectionId ?? null,
        status: "active",
        config: input.config,
        createdBySubjectId: input.createdBySubjectId,
      })
      .returning();
    if (!created) throw new Error("Failed to create Integration instance");
    await addIntegrationFeatureBindingOwner(db, created.id, input);
    return { row: created, changed: true };
  }
  if (existing.bindingKey !== input.bindingKey) {
    throw new IntegrationFeatureBindingOwnershipConflictError(
      "Integration runtime identity is already assigned to another instance",
    );
  }
  const changed =
    existing.integrationFacetInstallationId !== input.integrationFacetInstallationId ||
    existing.featureFacetId !== input.featureFacetId ||
    existing.displayName !== input.displayName.trim() ||
    existing.runtimeKey !== (input.runtimeKey ?? null) ||
    existing.connectionId !== (input.connectionId ?? null) ||
    existing.status !== "active" ||
    stableJson(existing.config) !== stableJson(input.config);
  let row = existing;
  if (changed) {
    if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw new IntegrationFeatureBindingVersionConflictError(
        input.bindingKey,
        input.expectedVersion,
        existing.version,
      );
    }
    if (input.owner.kind === "direct" && input.expectedVersion === undefined) {
      throw new IntegrationFeatureBindingVersionRequiredError(
        "Updating an Integration instance requires its previewed version",
      );
    }
    const owners = await listIntegrationFeatureBindingOwners(db, existing.id);
    const otherOwners = owners.filter(
      (owner) => owner.kind !== input.owner.kind || owner.id !== input.owner.id,
    );
    if (otherOwners.length > 0) {
      throw new IntegrationFeatureBindingOwnershipConflictError(
        "Integration instance is shared by another owner and cannot be changed in place",
      );
    }
    const [updated] = await db
      .update(schema.integrationFeatureBindings)
      .set({
        integrationFacetInstallationId: input.integrationFacetInstallationId,
        featureFacetId: input.featureFacetId,
        displayName: input.displayName.trim(),
        runtimeKey: input.runtimeKey ?? null,
        connectionId: input.connectionId ?? null,
        status: "active",
        config: input.config,
        cursor: {},
        version: existing.version + 1,
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.integrationFeatureBindings.id, existing.id))
      .returning();
    if (!updated) throw new Error("Failed to update Integration instance");
    row = updated;
  }
  await addIntegrationFeatureBindingOwner(db, row.id, input);
  return { row, changed };
}

export async function listIntegrationFeatureBindingOwners(
  db: Database,
  bindingId: string,
): Promise<IntegrationFeatureBindingOwner[]> {
  const rows = await db
    .select({
      kind: schema.integrationFeatureBindingOwners.ownerKind,
      id: schema.integrationFeatureBindingOwners.ownerId,
      removable: schema.integrationFeatureBindingOwners.removable,
    })
    .from(schema.integrationFeatureBindingOwners)
    .where(
      and(
        eq(schema.integrationFeatureBindingOwners.bindingId, bindingId),
        sql`(
          ${schema.integrationFeatureBindingOwners.ownerKind} <> 'plugin'
          or exists (
            select 1 from ${schema.capabilityPluginInstallations} owning_plugin
            where owning_plugin.id::text = ${schema.integrationFeatureBindingOwners.ownerId}
              and owning_plugin.status = 'active'
          )
        )`,
      ),
    )
    .orderBy(
      asc(schema.integrationFeatureBindingOwners.ownerKind),
      asc(schema.integrationFeatureBindingOwners.ownerId),
    );
  return rows.map((row) => {
    if (
      row.kind !== "direct" &&
      row.kind !== "plugin" &&
      row.kind !== "pack" &&
      row.kind !== "migration"
    ) {
      throw new Error(`Unknown Integration instance owner kind: ${row.kind}`);
    }
    return { kind: row.kind, id: row.id, removable: row.removable };
  });
}

export async function removeIntegrationFeatureBindingOwner(
  db: Database,
  input: {
    workspaceId: string;
    bindingId: string;
    owner: Pick<IntegrationFeatureBindingOwner, "kind" | "id">;
    expectedVersion?: number;
  },
): Promise<{
  binding: typeof schema.integrationFeatureBindings.$inferSelect | null;
  remainingOwners: IntegrationFeatureBindingOwner[];
}> {
  const [binding] = await db
    .select()
    .from(schema.integrationFeatureBindings)
    .where(
      and(
        eq(schema.integrationFeatureBindings.workspaceId, input.workspaceId),
        eq(schema.integrationFeatureBindings.id, input.bindingId),
      ),
    )
    .for("update")
    .limit(1);
  if (!binding) return { binding: null, remainingOwners: [] };
  if (input.expectedVersion !== undefined && binding.version !== input.expectedVersion) {
    throw new IntegrationFeatureBindingVersionConflictError(
      binding.bindingKey,
      input.expectedVersion,
      binding.version,
    );
  }
  await db
    .delete(schema.integrationFeatureBindingOwners)
    .where(
      and(
        eq(schema.integrationFeatureBindingOwners.workspaceId, input.workspaceId),
        eq(schema.integrationFeatureBindingOwners.bindingId, binding.id),
        eq(schema.integrationFeatureBindingOwners.ownerKind, input.owner.kind),
        eq(schema.integrationFeatureBindingOwners.ownerId, input.owner.id),
      ),
    );
  const remainingOwners = await listIntegrationFeatureBindingOwners(db, binding.id);
  if (remainingOwners.length > 0) return { binding, remainingOwners };
  const [disabled] = await db
    .update(schema.integrationFeatureBindings)
    .set({ status: "disabled", version: binding.version + 1, updatedAt: new Date() })
    .where(eq(schema.integrationFeatureBindings.id, binding.id))
    .returning();
  return { binding: disabled ?? binding, remainingOwners: [] };
}

export async function removeIntegrationFeatureBindingOwnersForOwner(
  db: Database,
  input: {
    workspaceId: string;
    owner: Pick<IntegrationFeatureBindingOwner, "kind" | "id">;
  },
): Promise<{ disabledBindingIds: string[]; retainedBindingIds: string[] }> {
  const deleted = await db
    .delete(schema.integrationFeatureBindingOwners)
    .where(
      and(
        eq(schema.integrationFeatureBindingOwners.workspaceId, input.workspaceId),
        eq(schema.integrationFeatureBindingOwners.ownerKind, input.owner.kind),
        eq(schema.integrationFeatureBindingOwners.ownerId, input.owner.id),
      ),
    )
    .returning({ bindingId: schema.integrationFeatureBindingOwners.bindingId });
  const disabledBindingIds: string[] = [];
  const retainedBindingIds: string[] = [];
  for (const bindingId of [...new Set(deleted.map((row) => row.bindingId))]) {
    const owners = await listIntegrationFeatureBindingOwners(db, bindingId);
    if (owners.length > 0) {
      retainedBindingIds.push(bindingId);
      continue;
    }
    await db
      .update(schema.integrationFeatureBindings)
      .set({
        status: "disabled",
        version: sql`${schema.integrationFeatureBindings.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.integrationFeatureBindings.workspaceId, input.workspaceId),
          eq(schema.integrationFeatureBindings.id, bindingId),
        ),
      );
    disabledBindingIds.push(bindingId);
  }
  return { disabledBindingIds, retainedBindingIds };
}

export async function integrationDefinitionHasBindingOwner(
  db: Database,
  input: {
    workspaceId: string;
    pluginInstallationId: string;
    owner: Pick<IntegrationFeatureBindingOwner, "kind" | "id">;
  },
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.integrationFeatureBindingOwners.id })
    .from(schema.integrationFeatureBindingOwners)
    .innerJoin(
      schema.integrationFeatureBindings,
      eq(schema.integrationFeatureBindings.id, schema.integrationFeatureBindingOwners.bindingId),
    )
    .innerJoin(
      schema.capabilityFacetInstallations,
      eq(
        schema.capabilityFacetInstallations.id,
        schema.integrationFeatureBindings.integrationFacetInstallationId,
      ),
    )
    .where(
      and(
        eq(schema.integrationFeatureBindingOwners.workspaceId, input.workspaceId),
        eq(schema.integrationFeatureBindingOwners.ownerKind, input.owner.kind),
        eq(schema.integrationFeatureBindingOwners.ownerId, input.owner.id),
        eq(schema.capabilityFacetInstallations.pluginInstallationId, input.pluginInstallationId),
        or(
          eq(schema.integrationFeatureBindings.status, "active"),
          eq(schema.integrationFeatureBindings.status, "needs_attention"),
          eq(schema.integrationFeatureBindings.status, "paused"),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function addIntegrationFeatureBindingOwner(
  db: Database,
  bindingId: string,
  input: Pick<UpsertIntegrationFeatureBindingInput, "accountId" | "workspaceId" | "owner">,
): Promise<void> {
  await db
    .insert(schema.integrationFeatureBindingOwners)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      bindingId,
      ownerKind: input.owner.kind,
      ownerId: input.owner.id,
      removable: input.owner.removable,
    })
    .onConflictDoNothing();
}

function assertBindingKey(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/.test(value) || value.length > 128) {
    throw new Error("Integration instance key is invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
