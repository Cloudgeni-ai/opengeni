import { createHash } from "node:crypto";

import { stableJson } from "@opengeni/contracts";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import type { Database } from "./database";
import { effectiveCapabilityOwnerSql } from "./capability-components";
import * as schema from "./schema";

export type IntegrationFacetBindingOwner = {
  kind: "direct" | "plugin" | "pack" | "migration";
  id: string;
  removable: boolean;
};

export type UpsertIntegrationFacetBindingInput = {
  accountId: string;
  workspaceId: string;
  integrationFacetInstallationId: string;
  facetDefinitionId: string;
  bindingKey: string;
  displayName: string;
  runtimeKey?: string | null;
  connectionId?: string | null;
  config: Record<string, unknown>;
  createdBySubjectId: string;
  owner: IntegrationFacetBindingOwner;
  expectedVersion?: number;
};

export class IntegrationFacetBindingVersionConflictError extends Error {
  readonly name = "IntegrationFacetBindingVersionConflictError";

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

export class IntegrationFacetBindingVersionRequiredError extends Error {
  readonly name = "IntegrationFacetBindingVersionRequiredError";
}

export class IntegrationFacetBindingOwnershipConflictError extends Error {
  readonly name = "IntegrationFacetBindingOwnershipConflictError";
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

export async function ensureIntegrationFacetDefinition(
  db: Database,
  input: {
    integrationFacetId: string;
    facetKey: string;
    kind:
      | "tools"
      | "knowledge_source"
      | "inbound_trigger"
      | "delivery_destination"
      | "identity_link";
    configSchema?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
  },
): Promise<typeof schema.integrationFacetDefinitions.$inferSelect> {
  const [existing] = await db
    .select()
    .from(schema.integrationFacetDefinitions)
    .where(
      and(
        eq(schema.integrationFacetDefinitions.integrationFacetId, input.integrationFacetId),
        eq(schema.integrationFacetDefinitions.facetKey, input.facetKey),
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
      throw new Error(`Integration facet ${input.facetKey} conflicts with stored definition`);
    }
    return existing;
  }
  const [created] = await db
    .insert(schema.integrationFacetDefinitions)
    .values({
      integrationFacetId: input.integrationFacetId,
      facetKey: input.facetKey,
      kind: input.kind,
      configSchema,
      capabilities,
    })
    .returning();
  if (!created) throw new Error(`Failed to create Integration facet ${input.facetKey}`);
  return created;
}

export async function upsertIntegrationFacetBinding(
  db: Database,
  input: UpsertIntegrationFacetBindingInput,
): Promise<{ row: typeof schema.integrationFacetBindings.$inferSelect; changed: boolean }> {
  assertBindingKey(input.bindingKey);
  if (input.displayName.trim().length === 0 || input.displayName.trim().length > 200) {
    throw new Error("Integration instance display name must contain 1-200 characters");
  }
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`integration-binding:${input.workspaceId}:${input.runtimeKey ?? `${input.facetDefinitionId}:${input.bindingKey}`}`}, 0))`,
  );
  const [existing] = await db
    .select()
    .from(schema.integrationFacetBindings)
    .where(
      and(
        eq(schema.integrationFacetBindings.workspaceId, input.workspaceId),
        input.runtimeKey
          ? eq(schema.integrationFacetBindings.runtimeKey, input.runtimeKey)
          : and(
              eq(
                schema.integrationFacetBindings.integrationFacetInstallationId,
                input.integrationFacetInstallationId,
              ),
              eq(schema.integrationFacetBindings.facetDefinitionId, input.facetDefinitionId),
              eq(schema.integrationFacetBindings.bindingKey, input.bindingKey),
            ),
      ),
    )
    .for("update")
    .limit(1);
  if (!existing) {
    if (input.expectedVersion !== undefined) {
      throw new IntegrationFacetBindingVersionConflictError(
        input.bindingKey,
        input.expectedVersion,
        0,
      );
    }
    const [created] = await db
      .insert(schema.integrationFacetBindings)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        integrationFacetInstallationId: input.integrationFacetInstallationId,
        facetDefinitionId: input.facetDefinitionId,
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
    await addIntegrationFacetBindingOwner(db, created.id, input);
    return { row: created, changed: true };
  }
  if (existing.bindingKey !== input.bindingKey) {
    throw new IntegrationFacetBindingOwnershipConflictError(
      "Integration runtime identity is already assigned to another instance",
    );
  }
  const changed =
    existing.integrationFacetInstallationId !== input.integrationFacetInstallationId ||
    existing.facetDefinitionId !== input.facetDefinitionId ||
    existing.displayName !== input.displayName.trim() ||
    existing.runtimeKey !== (input.runtimeKey ?? null) ||
    existing.connectionId !== (input.connectionId ?? null) ||
    existing.status !== "active" ||
    stableJson(existing.config) !== stableJson(input.config);
  let row = existing;
  if (changed) {
    if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw new IntegrationFacetBindingVersionConflictError(
        input.bindingKey,
        input.expectedVersion,
        existing.version,
      );
    }
    if (input.owner.kind === "direct" && input.expectedVersion === undefined) {
      throw new IntegrationFacetBindingVersionRequiredError(
        "Updating an Integration instance requires its previewed version",
      );
    }
    const owners = await listIntegrationFacetBindingOwners(db, existing.id);
    const otherOwners = owners.filter(
      (owner) => owner.kind !== input.owner.kind || owner.id !== input.owner.id,
    );
    if (otherOwners.length > 0) {
      throw new IntegrationFacetBindingOwnershipConflictError(
        "Integration instance is shared by another owner and cannot be changed in place",
      );
    }
    const [updated] = await db
      .update(schema.integrationFacetBindings)
      .set({
        integrationFacetInstallationId: input.integrationFacetInstallationId,
        facetDefinitionId: input.facetDefinitionId,
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
      .where(eq(schema.integrationFacetBindings.id, existing.id))
      .returning();
    if (!updated) throw new Error("Failed to update Integration instance");
    row = updated;
  }
  await addIntegrationFacetBindingOwner(db, row.id, input);
  return { row, changed };
}

export async function listIntegrationFacetBindingOwners(
  db: Database,
  bindingId: string,
): Promise<IntegrationFacetBindingOwner[]> {
  return (await listIntegrationFacetBindingOwnersForBindings(db, [bindingId])).get(bindingId) ?? [];
}

export async function listIntegrationFacetBindingOwnersForBindings(
  db: Database,
  bindingIds: string[],
): Promise<Map<string, IntegrationFacetBindingOwner[]>> {
  return await loadIntegrationFacetBindingOwnersForBindings(db, bindingIds, true);
}

async function loadIntegrationFacetBindingOwners(
  db: Database,
  bindingId: string,
  effectiveOnly: boolean,
): Promise<IntegrationFacetBindingOwner[]> {
  return (
    (await loadIntegrationFacetBindingOwnersForBindings(db, [bindingId], effectiveOnly)).get(
      bindingId,
    ) ?? []
  );
}

async function loadIntegrationFacetBindingOwnersForBindings(
  db: Database,
  bindingIds: string[],
  effectiveOnly: boolean,
): Promise<Map<string, IntegrationFacetBindingOwner[]>> {
  const uniqueBindingIds = [...new Set(bindingIds)];
  const ownersByBindingId = new Map(
    uniqueBindingIds.map((bindingId) => [bindingId, [] as IntegrationFacetBindingOwner[]]),
  );
  if (uniqueBindingIds.length === 0) return ownersByBindingId;
  const rows = await db
    .select({
      bindingId: schema.integrationFacetBindingOwners.bindingId,
      kind: schema.integrationFacetBindingOwners.ownerKind,
      id: schema.integrationFacetBindingOwners.ownerId,
      removable: schema.integrationFacetBindingOwners.removable,
    })
    .from(schema.integrationFacetBindingOwners)
    .where(
      and(
        inArray(schema.integrationFacetBindingOwners.bindingId, uniqueBindingIds),
        effectiveOnly
          ? effectiveCapabilityOwnerSql(
              schema.integrationFacetBindingOwners.ownerKind,
              schema.integrationFacetBindingOwners.ownerId,
            )
          : sql`true`,
      ),
    )
    .orderBy(
      asc(schema.integrationFacetBindingOwners.bindingId),
      asc(schema.integrationFacetBindingOwners.ownerKind),
      asc(schema.integrationFacetBindingOwners.ownerId),
    );
  for (const row of rows) {
    if (
      row.kind !== "direct" &&
      row.kind !== "plugin" &&
      row.kind !== "pack" &&
      row.kind !== "migration"
    ) {
      throw new Error(`Unknown Integration instance owner kind: ${row.kind}`);
    }
    ownersByBindingId
      .get(row.bindingId)
      ?.push({ kind: row.kind, id: row.id, removable: row.removable });
  }
  return ownersByBindingId;
}

export async function removeIntegrationFacetBindingOwner(
  db: Database,
  input: {
    workspaceId: string;
    bindingId: string;
    owner: Pick<IntegrationFacetBindingOwner, "kind" | "id">;
    expectedVersion?: number;
  },
): Promise<{
  binding: typeof schema.integrationFacetBindings.$inferSelect | null;
  remainingOwners: IntegrationFacetBindingOwner[];
}> {
  const [binding] = await db
    .select()
    .from(schema.integrationFacetBindings)
    .where(
      and(
        eq(schema.integrationFacetBindings.workspaceId, input.workspaceId),
        eq(schema.integrationFacetBindings.id, input.bindingId),
      ),
    )
    .for("update")
    .limit(1);
  if (!binding) return { binding: null, remainingOwners: [] };
  if (input.expectedVersion !== undefined && binding.version !== input.expectedVersion) {
    throw new IntegrationFacetBindingVersionConflictError(
      binding.bindingKey,
      input.expectedVersion,
      binding.version,
    );
  }
  await db
    .delete(schema.integrationFacetBindingOwners)
    .where(
      and(
        eq(schema.integrationFacetBindingOwners.workspaceId, input.workspaceId),
        eq(schema.integrationFacetBindingOwners.bindingId, binding.id),
        eq(schema.integrationFacetBindingOwners.ownerKind, input.owner.kind),
        eq(schema.integrationFacetBindingOwners.ownerId, input.owner.id),
      ),
    );
  // Pending or repairing owners are not runtime-effective yet, but they still
  // preserve the shared binding so their operation can resume safely.
  const remainingOwners = await loadIntegrationFacetBindingOwners(db, binding.id, false);
  if (remainingOwners.length > 0) return { binding, remainingOwners };
  const [disabled] = await db
    .update(schema.integrationFacetBindings)
    .set({ status: "disabled", version: binding.version + 1, updatedAt: new Date() })
    .where(eq(schema.integrationFacetBindings.id, binding.id))
    .returning();
  return { binding: disabled ?? binding, remainingOwners: [] };
}

export async function removeIntegrationFacetBindingOwnersForOwner(
  db: Database,
  input: {
    workspaceId: string;
    owner: Pick<IntegrationFacetBindingOwner, "kind" | "id">;
  },
): Promise<{ disabledBindingIds: string[]; retainedBindingIds: string[] }> {
  const deleted = await db
    .delete(schema.integrationFacetBindingOwners)
    .where(
      and(
        eq(schema.integrationFacetBindingOwners.workspaceId, input.workspaceId),
        eq(schema.integrationFacetBindingOwners.ownerKind, input.owner.kind),
        eq(schema.integrationFacetBindingOwners.ownerId, input.owner.id),
      ),
    )
    .returning({ bindingId: schema.integrationFacetBindingOwners.bindingId });
  const disabledBindingIds: string[] = [];
  const retainedBindingIds: string[] = [];
  for (const bindingId of [...new Set(deleted.map((row) => row.bindingId))]) {
    const owners = await loadIntegrationFacetBindingOwners(db, bindingId, false);
    if (owners.length > 0) {
      retainedBindingIds.push(bindingId);
      continue;
    }
    await db
      .update(schema.integrationFacetBindings)
      .set({
        status: "disabled",
        version: sql`${schema.integrationFacetBindings.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.integrationFacetBindings.workspaceId, input.workspaceId),
          eq(schema.integrationFacetBindings.id, bindingId),
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
    owner: Pick<IntegrationFacetBindingOwner, "kind" | "id">;
  },
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.integrationFacetBindingOwners.id })
    .from(schema.integrationFacetBindingOwners)
    .innerJoin(
      schema.integrationFacetBindings,
      eq(schema.integrationFacetBindings.id, schema.integrationFacetBindingOwners.bindingId),
    )
    .innerJoin(
      schema.capabilityFacetInstallations,
      eq(
        schema.capabilityFacetInstallations.id,
        schema.integrationFacetBindings.integrationFacetInstallationId,
      ),
    )
    .where(
      and(
        eq(schema.integrationFacetBindingOwners.workspaceId, input.workspaceId),
        eq(schema.integrationFacetBindingOwners.ownerKind, input.owner.kind),
        eq(schema.integrationFacetBindingOwners.ownerId, input.owner.id),
        eq(schema.capabilityFacetInstallations.pluginInstallationId, input.pluginInstallationId),
        or(
          eq(schema.integrationFacetBindings.status, "active"),
          eq(schema.integrationFacetBindings.status, "needs_attention"),
          eq(schema.integrationFacetBindings.status, "paused"),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function addIntegrationFacetBindingOwner(
  db: Database,
  bindingId: string,
  input: Pick<UpsertIntegrationFacetBindingInput, "accountId" | "workspaceId" | "owner">,
): Promise<void> {
  await db
    .insert(schema.integrationFacetBindingOwners)
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
