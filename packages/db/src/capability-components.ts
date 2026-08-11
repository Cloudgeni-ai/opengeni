import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";

import type { Database } from "./database";
import * as schema from "./schema";

export type CapabilityComponentOwnerIdentity = {
  kind: "direct" | "plugin" | "pack" | "migration";
  id: string;
};

export class CapabilityComponentVersionConflictError extends Error {
  readonly name = "CapabilityComponentVersionConflictError";

  constructor(readonly pluginKey: string) {
    super("Capability component version is pinned by another owner");
  }
}

/**
 * An owner row is runtime-effective only while its lifecycle-owning Plugin or
 * v2 Pack installation is active. Direct, migration, and legacy textual Pack
 * ownership is intrinsic so the rolling migration does not hide pre-v2 shared
 * components before those Packs are reinstalled into the normalized ledger.
 */
export function effectiveCapabilityOwnerSql(
  ownerKind: SQLWrapper,
  ownerId: SQLWrapper,
): ReturnType<typeof sql> {
  return sql`(
    ${ownerKind} not in ('plugin', 'pack')
    or (
      ${ownerKind} = 'plugin'
      and exists (
        select 1 from ${schema.capabilityPluginInstallations} owning_plugin
        where owning_plugin.id::text = ${ownerId}
          and owning_plugin.status = 'active'
      )
    )
    or (
      ${ownerKind} = 'pack'
      and (
        ${ownerId} !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or exists (
          select 1 from ${schema.packInstallations} owning_pack
          where owning_pack.id::text = ${ownerId}
            and owning_pack.status = 'active'
        )
      )
    )
  )`;
}

/** Serialize one workspace-local component identity across direct, Plugin, and Pack installers. */
export async function lockCapabilityComponentIdentity(
  db: Database,
  workspaceId: string,
  pluginKey: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`capability-component:${workspaceId}:${pluginKey}`}, 0))`,
  );
}

/**
 * A child installation selects exactly one immutable Plugin version. Changing
 * that version is safe only when every retained facet owner is the caller.
 */
export async function assertCapabilityComponentVersionCanChange(
  db: Database,
  input: {
    workspaceId: string;
    pluginKey: string;
    pluginInstallationId: string;
    owner: CapabilityComponentOwnerIdentity;
  },
): Promise<void> {
  const owners = await db
    .select({
      kind: schema.capabilityComponentOwners.ownerKind,
      id: schema.capabilityComponentOwners.ownerId,
    })
    .from(schema.capabilityComponentOwners)
    .innerJoin(
      schema.capabilityFacetInstallations,
      eq(
        schema.capabilityFacetInstallations.id,
        schema.capabilityComponentOwners.facetInstallationId,
      ),
    )
    .where(
      and(
        eq(schema.capabilityComponentOwners.workspaceId, input.workspaceId),
        eq(schema.capabilityFacetInstallations.pluginInstallationId, input.pluginInstallationId),
        effectiveCapabilityOwnerSql(
          schema.capabilityComponentOwners.ownerKind,
          schema.capabilityComponentOwners.ownerId,
        ),
      ),
    );
  if (owners.some((owner) => owner.kind !== input.owner.kind || owner.id !== input.owner.id)) {
    throw new CapabilityComponentVersionConflictError(input.pluginKey);
  }
}

/**
 * Delete physically ownerless facet installations and disable now-empty child
 * components. Inactive lifecycle owners still preserve storage: a Pack may
 * have claimed a component while its installation is pending or repairing,
 * even though that owner is intentionally hidden from runtime reads.
 */
export async function cleanupOrphanedCapabilityComponents(
  db: Database,
  workspaceId: string,
  facetInstallationIds: string[],
): Promise<void> {
  const uniqueIds = [...new Set(facetInstallationIds)];
  if (uniqueIds.length === 0) return;
  const orphanRows = await db
    .select({
      facetInstallationId: schema.capabilityFacetInstallations.id,
      pluginInstallationId: schema.capabilityFacetInstallations.pluginInstallationId,
    })
    .from(schema.capabilityFacetInstallations)
    .where(
      and(
        inArray(schema.capabilityFacetInstallations.id, uniqueIds),
        sql`not exists (
          select 1 from ${schema.capabilityComponentOwners} owner
          where owner.facet_installation_id = ${schema.capabilityFacetInstallations.id}
        )`,
      ),
    );
  if (orphanRows.length === 0) return;
  await db.delete(schema.capabilityFacetInstallations).where(
    inArray(
      schema.capabilityFacetInstallations.id,
      orphanRows.map((row) => row.facetInstallationId),
    ),
  );
  const childInstallations = [...new Set(orphanRows.map((row) => row.pluginInstallationId))];
  for (const childInstallationId of childInstallations) {
    const [remaining] = await db
      .select({ id: schema.capabilityFacetInstallations.id })
      .from(schema.capabilityFacetInstallations)
      .where(eq(schema.capabilityFacetInstallations.pluginInstallationId, childInstallationId))
      .limit(1);
    if (remaining) continue;
    await db
      .update(schema.capabilityPluginInstallations)
      .set({
        status: "disabled",
        version: sql`${schema.capabilityPluginInstallations.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.capabilityPluginInstallations.id, childInstallationId));
    await db
      .update(schema.capabilityInstallations)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(
        and(
          eq(schema.capabilityInstallations.workspaceId, workspaceId),
          sql`${schema.capabilityInstallations.metadata} ->> 'pluginInstallationId' = ${childInstallationId}`,
        ),
      );
  }
}
