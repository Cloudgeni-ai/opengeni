import { and, eq, sql } from "drizzle-orm";

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
      ),
    );
  if (owners.some((owner) => owner.kind !== input.owner.kind || owner.id !== input.owner.id)) {
    throw new CapabilityComponentVersionConflictError(input.pluginKey);
  }
}
