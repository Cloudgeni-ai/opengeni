import { createHash } from "node:crypto";

import {
  stableJson,
  type CapabilityPackComponentReference,
  type PackComponentResolution,
} from "@opengeni/contracts";
import { and, asc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";

import {
  cleanupOrphanedCapabilityComponents,
  effectiveCapabilityOwnerSql,
} from "./capability-components";
import {
  listInstalledApiIntegrationsInRlsContext,
  type ApiIntegrationRuntime,
} from "./capability-integrations";
import { withRlsContext, withWorkspaceRls, type Database } from "./database";
import {
  addIntegrationFacetBindingOwner,
  removeIntegrationFacetBindingOwner,
  removeIntegrationFacetBindingOwnersForOwner,
} from "./integration-bindings";
import * as schema from "./schema";

type PackComponentKind = PackComponentResolution["kind"];

export type PackInlineSkillRequirement = {
  key: string;
  capabilityId: string;
  name: string;
  activationMode: "workspace_managed" | "session_selected";
  contentSha256: string;
};

type ResolvedPackComponentTarget = {
  resolution: PackComponentResolution;
  facetInstallationIds: string[];
  bindingIds: string[];
  metadata: Record<string, unknown>;
};

export type StoredPackInstallationComponent = {
  id: string;
  packInstallationId: string;
  key: string;
  kind: PackComponentKind;
  capabilityId: string;
  resolvedId: string;
  digest: string;
  metadata: Record<string, unknown>;
};

export class PackComponentResolutionError extends Error {
  readonly name = "PackComponentResolutionError";

  constructor(
    readonly componentKey: string,
    readonly status: "missing" | "mismatch",
  ) {
    super(`Pack component ${componentKey} is ${status}`);
  }
}

export async function resolvePackComponentReferences(
  db: Database,
  workspaceId: string,
  references: readonly CapabilityPackComponentReference[],
): Promise<PackComponentResolution[]> {
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await resolvePackComponentTargets(scopedDb, workspaceId, references).then((targets) =>
        targets.map((target) => target.resolution),
      ),
  );
}

/**
 * Resolve inline Pack Skills against effective owners by case-insensitive
 * runtime name. Exact content is shareable; different content under the same
 * active name is a conflict. The current Pack owner may be excluded so an
 * update can replace its own previous inline Skill safely.
 */
export async function resolvePackInlineSkillReferences(
  db: Database,
  workspaceId: string,
  requirements: readonly PackInlineSkillRequirement[],
  excludePackInstallationId?: string,
): Promise<PackComponentResolution[]> {
  if (requirements.length === 0) return [];
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const normalizedNames = [
      ...new Set(requirements.map((requirement) => requirement.name.toLowerCase())),
    ];
    const rows = await scopedDb
      .select({
        facetInstallationId: schema.capabilityFacetInstallations.id,
        name: schema.capabilitySkillFacets.name,
        activationMode: schema.capabilityFacets.activationMode,
        contentSha256: schema.capabilitySkillFacets.contentSha256,
      })
      .from(schema.capabilitySkillFacets)
      .innerJoin(
        schema.capabilityFacets,
        eq(schema.capabilityFacets.id, schema.capabilitySkillFacets.facetId),
      )
      .innerJoin(
        schema.capabilityFacetInstallations,
        eq(schema.capabilityFacetInstallations.facetId, schema.capabilitySkillFacets.facetId),
      )
      .innerJoin(
        schema.capabilityPluginInstallations,
        eq(
          schema.capabilityPluginInstallations.id,
          schema.capabilityFacetInstallations.pluginInstallationId,
        ),
      )
      .where(
        and(
          eq(schema.capabilityFacetInstallations.workspaceId, workspaceId),
          eq(schema.capabilityFacetInstallations.status, "active"),
          eq(schema.capabilityPluginInstallations.status, "active"),
          inArray(sql<string>`lower(${schema.capabilitySkillFacets.name})`, normalizedNames),
          sql`exists (
            select 1 from ${schema.capabilityComponentOwners} owner
            where owner.facet_installation_id = ${schema.capabilityFacetInstallations.id}
              and ${effectiveCapabilityOwnerSql(sql`owner.owner_kind`, sql`owner.owner_id`)}
              and ${
                excludePackInstallationId
                  ? sql`not (
                      owner.owner_kind = 'pack'
                      and owner.owner_id = ${excludePackInstallationId}
                    )`
                  : sql`true`
              }
          )`,
        ),
      )
      .orderBy(
        asc(schema.capabilitySkillFacets.name),
        asc(schema.capabilitySkillFacets.contentSha256),
      );
    return requirements.map((requirement) => {
      const candidates = rows.filter(
        (row) => row.name.toLowerCase() === requirement.name.toLowerCase(),
      );
      const exact = candidates.find(
        (candidate) =>
          candidate.contentSha256 === requirement.contentSha256 &&
          candidate.activationMode === requirement.activationMode,
      );
      const mismatch =
        candidates.find((candidate) => candidate.contentSha256 !== requirement.contentSha256) ??
        null;
      return {
        key: requirement.key,
        kind: "inline_skill" as const,
        capabilityId: requirement.capabilityId,
        required: true,
        status: !mismatch || exact ? "ready" : "mismatch",
        expectedDigest: requirement.contentSha256,
        actualDigest: exact?.contentSha256 ?? mismatch?.contentSha256 ?? requirement.contentSha256,
        resolvedId: exact?.facetInstallationId ?? (mismatch ? null : requirement.capabilityId),
        label: requirement.name,
      };
    });
  });
}

export async function adoptPackComponentReferences(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    packInstallationId: string;
    references: readonly CapabilityPackComponentReference[];
  },
): Promise<{
  components: StoredPackInstallationComponent[];
  retainedFacetInstallationIds: string[];
  retainedBindingIds: string[];
}> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`pack-components:${input.workspaceId}:${input.packInstallationId}`}, 0))`,
        );
        const [installation] = await tx
          .select({ id: schema.packInstallations.id })
          .from(schema.packInstallations)
          .where(
            and(
              eq(schema.packInstallations.workspaceId, input.workspaceId),
              eq(schema.packInstallations.id, input.packInstallationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!installation) throw new Error("Pack installation was not found");

        const targets = await resolvePackComponentTargets(tx, input.workspaceId, input.references);
        const retainedFacetInstallationIds: string[] = [];
        const retainedBindingIds: string[] = [];
        const components: StoredPackInstallationComponent[] = [];
        for (const target of targets) {
          if (target.resolution.status !== "ready") {
            if (target.resolution.required) {
              throw new PackComponentResolutionError(
                target.resolution.key,
                target.resolution.status,
              );
            }
            continue;
          }
          for (const facetInstallationId of target.facetInstallationIds) {
            await tx
              .insert(schema.capabilityComponentOwners)
              .values({
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                facetInstallationId,
                ownerKind: "pack",
                ownerId: input.packInstallationId,
                removable: true,
              })
              .onConflictDoNothing();
            retainedFacetInstallationIds.push(facetInstallationId);
          }
          for (const bindingId of target.bindingIds) {
            await addIntegrationFacetBindingOwner(tx, bindingId, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              owner: { kind: "pack", id: input.packInstallationId, removable: true },
            });
            retainedBindingIds.push(bindingId);
          }
          const [row] = await tx
            .insert(schema.packInstallationComponents)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              packInstallationId: input.packInstallationId,
              componentKey: target.resolution.key,
              kind: target.resolution.kind,
              capabilityId: target.resolution.capabilityId,
              resolvedId: target.resolution.resolvedId!,
              digest: target.resolution.actualDigest!,
              metadata: {
                ...target.metadata,
                facetInstallationIds: [...new Set(target.facetInstallationIds)],
                bindingIds: [...new Set(target.bindingIds)],
              },
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                schema.packInstallationComponents.packInstallationId,
                schema.packInstallationComponents.componentKey,
              ],
              set: {
                kind: target.resolution.kind,
                capabilityId: target.resolution.capabilityId,
                resolvedId: target.resolution.resolvedId!,
                digest: target.resolution.actualDigest!,
                metadata: {
                  ...target.metadata,
                  facetInstallationIds: [...new Set(target.facetInstallationIds)],
                  bindingIds: [...new Set(target.bindingIds)],
                },
                updatedAt: new Date(),
              },
            })
            .returning();
          if (!row) throw new Error(`Failed to record Pack component ${target.resolution.key}`);
          components.push(mapStoredPackComponent(row));
        }
        return {
          components,
          retainedFacetInstallationIds: [...new Set(retainedFacetInstallationIds)],
          retainedBindingIds: [...new Set(retainedBindingIds)],
        };
      }),
  );
}

export async function listPackInstallationComponents(
  db: Database,
  workspaceId: string,
  packInstallationId: string,
): Promise<StoredPackInstallationComponent[]> {
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await listPackInstallationComponentsInRlsContext(scopedDb, workspaceId, packInstallationId),
  );
}

export async function recordPackInlineSkillComponent(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    packInstallationId: string;
    componentKey: string;
    capabilityId: string;
    facetInstallationId: string;
    contentSha256: string;
    name: string;
  },
): Promise<StoredPackInstallationComponent> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.packInstallationComponents)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          packInstallationId: input.packInstallationId,
          componentKey: input.componentKey,
          kind: "inline_skill",
          capabilityId: input.capabilityId,
          resolvedId: input.facetInstallationId,
          digest: input.contentSha256,
          metadata: {
            name: input.name,
            facetInstallationIds: [input.facetInstallationId],
            bindingIds: [],
          },
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.packInstallationComponents.packInstallationId,
            schema.packInstallationComponents.componentKey,
          ],
          set: {
            kind: "inline_skill",
            capabilityId: input.capabilityId,
            resolvedId: input.facetInstallationId,
            digest: input.contentSha256,
            metadata: {
              name: input.name,
              facetInstallationIds: [input.facetInstallationId],
              bindingIds: [],
            },
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error(`Failed to record inline Pack Skill ${input.componentKey}`);
      return mapStoredPackComponent(row);
    },
  );
}

export async function finalizePackComponentOwnership(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    packInstallationId: string;
    retainedComponentKeys: string[];
    retainedFacetInstallationIds: string[];
    retainedBindingIds: string[];
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const retainedFacets = new Set(input.retainedFacetInstallationIds);
        const ownedFacets = await tx
          .select({
            id: schema.capabilityComponentOwners.id,
            facetInstallationId: schema.capabilityComponentOwners.facetInstallationId,
          })
          .from(schema.capabilityComponentOwners)
          .where(
            and(
              eq(schema.capabilityComponentOwners.workspaceId, input.workspaceId),
              eq(schema.capabilityComponentOwners.ownerKind, "pack"),
              eq(schema.capabilityComponentOwners.ownerId, input.packInstallationId),
            ),
          );
        const staleFacets = ownedFacets.filter(
          (owner) => !retainedFacets.has(owner.facetInstallationId),
        );
        if (staleFacets.length > 0) {
          await tx.delete(schema.capabilityComponentOwners).where(
            inArray(
              schema.capabilityComponentOwners.id,
              staleFacets.map((owner) => owner.id),
            ),
          );
          await cleanupOrphanedCapabilityComponents(
            tx,
            input.workspaceId,
            staleFacets.map((owner) => owner.facetInstallationId),
          );
        }
        const retainedBindings = new Set(input.retainedBindingIds);
        const ownedBindings = await tx
          .select({ bindingId: schema.integrationFacetBindingOwners.bindingId })
          .from(schema.integrationFacetBindingOwners)
          .where(
            and(
              eq(schema.integrationFacetBindingOwners.workspaceId, input.workspaceId),
              eq(schema.integrationFacetBindingOwners.ownerKind, "pack"),
              eq(schema.integrationFacetBindingOwners.ownerId, input.packInstallationId),
            ),
          );
        for (const bindingId of [
          ...new Set(
            ownedBindings
              .map((owner) => owner.bindingId)
              .filter((ownedBindingId) => !retainedBindings.has(ownedBindingId)),
          ),
        ]) {
          await removeIntegrationFacetBindingOwner(tx, {
            workspaceId: input.workspaceId,
            bindingId,
            owner: { kind: "pack", id: input.packInstallationId },
          });
        }
        const retainedKeys = [...new Set(input.retainedComponentKeys)];
        await tx
          .delete(schema.packInstallationComponents)
          .where(
            and(
              eq(schema.packInstallationComponents.workspaceId, input.workspaceId),
              eq(schema.packInstallationComponents.packInstallationId, input.packInstallationId),
              retainedKeys.length > 0
                ? notInArray(schema.packInstallationComponents.componentKey, retainedKeys)
                : sql`true`,
            ),
          );
      }),
  );
}

export async function previewPackComponentRelease(
  db: Database,
  workspaceId: string,
  packInstallationId: string,
): Promise<
  Array<{
    key: string;
    kind: PackComponentKind;
    capabilityId: string;
    retainedByOtherOwners: boolean;
  }>
> {
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await previewPackComponentReleaseInRlsContext(scopedDb, workspaceId, packInstallationId),
  );
}

async function previewPackComponentReleaseInRlsContext(
  scopedDb: Database,
  workspaceId: string,
  packInstallationId: string,
): Promise<
  Array<{
    key: string;
    kind: PackComponentKind;
    capabilityId: string;
    retainedByOtherOwners: boolean;
  }>
> {
  const components = await listPackInstallationComponentsInRlsContext(
    scopedDb,
    workspaceId,
    packInstallationId,
  );
  const result = [];
  for (const component of components) {
    const facetIds = stringArray(component.metadata.facetInstallationIds);
    const bindingIds = stringArray(component.metadata.bindingIds);
    const [facetOwner] =
      facetIds.length === 0
        ? []
        : await scopedDb
            .select({ id: schema.capabilityComponentOwners.id })
            .from(schema.capabilityComponentOwners)
            .where(
              and(
                inArray(schema.capabilityComponentOwners.facetInstallationId, facetIds),
                effectiveCapabilityOwnerSql(
                  schema.capabilityComponentOwners.ownerKind,
                  schema.capabilityComponentOwners.ownerId,
                ),
                or(
                  ne(schema.capabilityComponentOwners.ownerKind, "pack"),
                  ne(schema.capabilityComponentOwners.ownerId, packInstallationId),
                ),
              ),
            )
            .limit(1);
    const [bindingOwner] =
      bindingIds.length === 0
        ? []
        : await scopedDb
            .select({ id: schema.integrationFacetBindingOwners.id })
            .from(schema.integrationFacetBindingOwners)
            .where(
              and(
                inArray(schema.integrationFacetBindingOwners.bindingId, bindingIds),
                effectiveCapabilityOwnerSql(
                  schema.integrationFacetBindingOwners.ownerKind,
                  schema.integrationFacetBindingOwners.ownerId,
                ),
                or(
                  ne(schema.integrationFacetBindingOwners.ownerKind, "pack"),
                  ne(schema.integrationFacetBindingOwners.ownerId, packInstallationId),
                ),
              ),
            )
            .limit(1);
    result.push({
      key: component.key,
      kind: component.kind,
      capabilityId: component.capabilityId,
      retainedByOtherOwners: Boolean(facetOwner || bindingOwner),
    });
  }
  return result;
}

export async function releasePackComponents(
  db: Database,
  input: { accountId: string; workspaceId: string; packInstallationId: string },
): Promise<{ retainedComponents: string[] }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const preview = await previewPackComponentReleaseInRlsContext(
          tx,
          input.workspaceId,
          input.packInstallationId,
        );
        await removeIntegrationFacetBindingOwnersForOwner(tx, {
          workspaceId: input.workspaceId,
          owner: { kind: "pack", id: input.packInstallationId },
        });
        const deletedOwners = await tx
          .delete(schema.capabilityComponentOwners)
          .where(
            and(
              eq(schema.capabilityComponentOwners.workspaceId, input.workspaceId),
              eq(schema.capabilityComponentOwners.ownerKind, "pack"),
              eq(schema.capabilityComponentOwners.ownerId, input.packInstallationId),
            ),
          )
          .returning({ facetInstallationId: schema.capabilityComponentOwners.facetInstallationId });
        await cleanupOrphanedCapabilityComponents(
          tx,
          input.workspaceId,
          deletedOwners.map((row) => row.facetInstallationId),
        );
        await tx
          .delete(schema.packInstallationComponents)
          .where(
            and(
              eq(schema.packInstallationComponents.workspaceId, input.workspaceId),
              eq(schema.packInstallationComponents.packInstallationId, input.packInstallationId),
            ),
          );
        return {
          retainedComponents: preview
            .filter((component) => component.retainedByOtherOwners)
            .map((component) => component.capabilityId),
        };
      }),
  );
}

async function resolvePackComponentTargets(
  db: Database,
  workspaceId: string,
  references: readonly CapabilityPackComponentReference[],
): Promise<ResolvedPackComponentTarget[]> {
  const integrations = await listInstalledApiIntegrationsInRlsContext(db, workspaceId);
  const targets: ResolvedPackComponentTarget[] = [];
  for (const reference of references) {
    if (reference.kind === "plugin") {
      targets.push(await resolvePluginReference(db, workspaceId, reference));
    } else if (reference.kind === "skill") {
      targets.push(await resolveSkillReference(db, workspaceId, reference));
    } else if (reference.kind === "integration") {
      targets.push(await resolveIntegrationReference(db, workspaceId, reference, integrations));
    } else {
      targets.push(await resolveFacetReference(db, workspaceId, reference, integrations));
    }
  }
  return targets;
}

async function resolvePluginReference(
  db: Database,
  workspaceId: string,
  reference: Extract<CapabilityPackComponentReference, { kind: "plugin" }>,
): Promise<ResolvedPackComponentTarget> {
  const [row] = await db
    .select({
      pluginInstallationId: schema.capabilityPluginInstallations.id,
      status: schema.capabilityPluginInstallations.status,
      version: schema.capabilityPluginVersions.version,
      manifestDigest: schema.capabilityPluginVersions.manifestDigest,
      name: schema.capabilityPlugins.name,
    })
    .from(schema.capabilityPluginInstallations)
    .innerJoin(
      schema.capabilityPlugins,
      eq(schema.capabilityPlugins.id, schema.capabilityPluginInstallations.pluginId),
    )
    .innerJoin(
      schema.capabilityPluginVersions,
      eq(schema.capabilityPluginVersions.id, schema.capabilityPluginInstallations.pluginVersionId),
    )
    .where(
      and(
        eq(schema.capabilityPluginInstallations.workspaceId, workspaceId),
        eq(schema.capabilityPlugins.pluginKey, reference.pluginKey),
      ),
    )
    .limit(1);
  const expectedDigest = reference.manifestDigest;
  const exact =
    row?.status === "active" &&
    row.version === reference.version &&
    row.manifestDigest === reference.manifestDigest;
  const facetInstallationIds = !row
    ? []
    : (
        await db
          .select({ id: schema.capabilityComponentOwners.facetInstallationId })
          .from(schema.capabilityComponentOwners)
          .where(
            and(
              eq(schema.capabilityComponentOwners.workspaceId, workspaceId),
              eq(schema.capabilityComponentOwners.ownerKind, "plugin"),
              eq(schema.capabilityComponentOwners.ownerId, row.pluginInstallationId),
            ),
          )
      ).map((entry) => entry.id);
  const bindingIds = !row
    ? []
    : (
        await db
          .select({ id: schema.integrationFacetBindingOwners.bindingId })
          .from(schema.integrationFacetBindingOwners)
          .where(
            and(
              eq(schema.integrationFacetBindingOwners.workspaceId, workspaceId),
              eq(schema.integrationFacetBindingOwners.ownerKind, "plugin"),
              eq(schema.integrationFacetBindingOwners.ownerId, row.pluginInstallationId),
            ),
          )
      ).map((entry) => entry.id);
  return {
    resolution: {
      key: reference.key,
      kind: "plugin",
      capabilityId: `plugin:${reference.pluginKey}`,
      required: reference.required,
      status: !row ? "missing" : exact ? "ready" : "mismatch",
      expectedDigest,
      actualDigest: row?.manifestDigest ?? null,
      resolvedId: exact ? row.pluginInstallationId : null,
      label: row?.name ?? reference.pluginKey,
    },
    facetInstallationIds: exact ? facetInstallationIds : [],
    bindingIds: exact ? bindingIds : [],
    metadata: { pluginKey: reference.pluginKey, version: reference.version },
  };
}

async function resolveSkillReference(
  db: Database,
  workspaceId: string,
  reference: Extract<CapabilityPackComponentReference, { kind: "skill" }>,
): Promise<ResolvedPackComponentTarget> {
  const rows = await db
    .select({
      facetInstallationId: schema.capabilityFacetInstallations.id,
      contentSha256: schema.capabilitySkillFacets.contentSha256,
      name: schema.capabilitySkillFacets.name,
    })
    .from(schema.capabilitySkillFacets)
    .innerJoin(
      schema.capabilityFacetInstallations,
      eq(schema.capabilityFacetInstallations.facetId, schema.capabilitySkillFacets.facetId),
    )
    .innerJoin(
      schema.capabilityPluginInstallations,
      eq(
        schema.capabilityPluginInstallations.id,
        schema.capabilityFacetInstallations.pluginInstallationId,
      ),
    )
    .where(
      and(
        eq(schema.capabilityFacetInstallations.workspaceId, workspaceId),
        eq(schema.capabilitySkillFacets.capabilityId, reference.capabilityId),
        eq(schema.capabilityFacetInstallations.status, "active"),
        eq(schema.capabilityPluginInstallations.status, "active"),
        sql`exists (
          select 1 from ${schema.capabilityComponentOwners} owner
          where owner.facet_installation_id = ${schema.capabilityFacetInstallations.id}
            and ${effectiveCapabilityOwnerSql(sql`owner.owner_kind`, sql`owner.owner_id`)}
        )`,
      ),
    )
    .limit(8);
  const exact = rows.find((row) => row.contentSha256 === reference.contentSha256);
  const actual = exact ?? rows[0] ?? null;
  return {
    resolution: {
      key: reference.key,
      kind: "skill",
      capabilityId: reference.capabilityId,
      required: reference.required,
      status: rows.length === 0 ? "missing" : exact ? "ready" : "mismatch",
      expectedDigest: reference.contentSha256,
      actualDigest: actual?.contentSha256 ?? null,
      resolvedId: exact?.facetInstallationId ?? null,
      label: actual?.name ?? reference.capabilityId,
    },
    facetInstallationIds: exact ? [exact.facetInstallationId] : [],
    bindingIds: [],
    metadata: {},
  };
}

async function resolveIntegrationReference(
  db: Database,
  workspaceId: string,
  reference: Extract<CapabilityPackComponentReference, { kind: "integration" }>,
  integrations: readonly ApiIntegrationRuntime[],
): Promise<ResolvedPackComponentTarget> {
  const candidates = integrations.filter(
    (integration) =>
      integration.capabilityId === reference.capabilityId &&
      integration.instanceKey === reference.instanceKey,
  );
  const exact = candidates.find(
    (integration) =>
      integration.revision.id === reference.revisionId &&
      integration.revision.contentSha256 === reference.contentSha256,
  );
  const actual = exact ?? candidates[0] ?? null;
  const facetInstallationIds = exact
    ? await integrationFacetInstallationIds(db, exact.pluginInstallationId)
    : [];
  return {
    resolution: {
      key: reference.key,
      kind: "integration",
      capabilityId: reference.capabilityId,
      required: reference.required,
      status: candidates.length === 0 ? "missing" : exact ? "ready" : "mismatch",
      expectedDigest: reference.contentSha256,
      actualDigest: actual?.revision.contentSha256 ?? null,
      resolvedId: exact?.instanceId ?? null,
      label: actual?.displayName ?? reference.capabilityId,
    },
    facetInstallationIds,
    bindingIds: exact ? [exact.instanceId] : [],
    metadata: {
      instanceKey: reference.instanceKey,
      revisionId: reference.revisionId,
    },
  };
}

async function resolveFacetReference(
  db: Database,
  workspaceId: string,
  reference: Extract<CapabilityPackComponentReference, { kind: "facet" }>,
  integrations: readonly ApiIntegrationRuntime[],
): Promise<ResolvedPackComponentTarget> {
  const integration = integrations.find(
    (candidate) =>
      candidate.capabilityId === reference.capabilityId &&
      candidate.instanceKey === reference.instanceKey,
  );
  if (!integration) {
    return missingTarget(reference, "facet", reference.capabilityId, reference.configDigest);
  }
  const [integrationFacetInstallationId] = await integrationFacetInstallationIds(
    db,
    integration.pluginInstallationId,
    "integration",
  );
  if (!integrationFacetInstallationId) {
    return missingTarget(reference, "facet", reference.capabilityId, reference.configDigest);
  }
  const [binding] = await db
    .select({
      id: schema.integrationFacetBindings.id,
      config: schema.integrationFacetBindings.config,
      status: schema.integrationFacetBindings.status,
      displayName: schema.integrationFacetBindings.displayName,
    })
    .from(schema.integrationFacetBindings)
    .innerJoin(
      schema.integrationFacetDefinitions,
      eq(schema.integrationFacetDefinitions.id, schema.integrationFacetBindings.facetDefinitionId),
    )
    .where(
      and(
        eq(schema.integrationFacetBindings.workspaceId, workspaceId),
        eq(
          schema.integrationFacetBindings.integrationFacetInstallationId,
          integrationFacetInstallationId,
        ),
        eq(schema.integrationFacetDefinitions.facetKey, reference.facetKey),
        eq(schema.integrationFacetBindings.bindingKey, reference.bindingKey),
      ),
    )
    .limit(1);
  const actualDigest = binding ? sha256(stableJson(binding.config)) : null;
  const exact =
    binding?.status === "active" &&
    actualDigest !== null &&
    actualDigest === reference.configDigest;
  return {
    resolution: {
      key: reference.key,
      kind: "facet",
      capabilityId: reference.capabilityId,
      required: reference.required,
      status: !binding ? "missing" : exact ? "ready" : "mismatch",
      expectedDigest: reference.configDigest,
      actualDigest,
      resolvedId: exact ? binding.id : null,
      label: binding?.displayName ?? reference.facetKey,
    },
    facetInstallationIds: exact ? [integrationFacetInstallationId] : [],
    bindingIds: exact ? [binding.id] : [],
    metadata: {
      instanceKey: reference.instanceKey,
      facetKey: reference.facetKey,
      bindingKey: reference.bindingKey,
    },
  };
}

async function integrationFacetInstallationIds(
  db: Database,
  pluginInstallationId: string,
  onlyKind?: "integration" | "api",
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.capabilityFacetInstallations.id, kind: schema.capabilityFacets.kind })
    .from(schema.capabilityFacetInstallations)
    .innerJoin(
      schema.capabilityFacets,
      eq(schema.capabilityFacets.id, schema.capabilityFacetInstallations.facetId),
    )
    .where(
      and(
        eq(schema.capabilityFacetInstallations.pluginInstallationId, pluginInstallationId),
        onlyKind
          ? eq(schema.capabilityFacets.kind, onlyKind)
          : inArray(schema.capabilityFacets.kind, ["integration", "api"]),
      ),
    );
  return rows.map((row) => row.id);
}

async function listPackInstallationComponentsInRlsContext(
  scopedDb: Database,
  workspaceId: string,
  packInstallationId: string,
): Promise<StoredPackInstallationComponent[]> {
  const rows = await scopedDb
    .select()
    .from(schema.packInstallationComponents)
    .where(
      and(
        eq(schema.packInstallationComponents.workspaceId, workspaceId),
        eq(schema.packInstallationComponents.packInstallationId, packInstallationId),
      ),
    )
    .orderBy(asc(schema.packInstallationComponents.componentKey));
  return rows.map(mapStoredPackComponent);
}

function missingTarget(
  reference: { key: string; required: boolean },
  kind: PackComponentKind,
  capabilityId: string,
  expectedDigest: string,
): ResolvedPackComponentTarget {
  return {
    resolution: {
      key: reference.key,
      kind,
      capabilityId,
      required: reference.required,
      status: "missing",
      expectedDigest,
      actualDigest: null,
      resolvedId: null,
      label: capabilityId,
    },
    facetInstallationIds: [],
    bindingIds: [],
    metadata: {},
  };
}

function mapStoredPackComponent(
  row: typeof schema.packInstallationComponents.$inferSelect,
): StoredPackInstallationComponent {
  if (
    row.kind !== "plugin" &&
    row.kind !== "skill" &&
    row.kind !== "integration" &&
    row.kind !== "facet" &&
    row.kind !== "inline_skill"
  ) {
    throw new Error(`Unknown Pack component kind: ${row.kind}`);
  }
  return {
    id: row.id,
    packInstallationId: row.packInstallationId,
    key: row.componentKey,
    kind: row.kind,
    capabilityId: row.capabilityId,
    resolvedId: row.resolvedId,
    digest: row.digest,
    metadata: row.metadata,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
