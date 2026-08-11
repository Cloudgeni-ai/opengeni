import { createHash } from "node:crypto";

import { stableJson, type CapabilityCatalogAuthKind } from "@opengeni/contracts";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";

import {
  assertCapabilityComponentVersionCanChange,
  cleanupOrphanedCapabilityComponents,
  effectiveCapabilityOwnerSql,
  lockCapabilityComponentIdentity,
} from "./capability-components";
import { setSubjectRlsContext, withRlsContext, withWorkspaceRls, type Database } from "./database";
import {
  removeIntegrationFeatureBindingOwner,
  removeIntegrationFeatureBindingOwnersForOwner,
} from "./integration-bindings";
import * as schema from "./schema";

export type PluginBomComponent = {
  key: string;
  kind: "skill" | "integration" | "mcp";
  capabilityId: string;
  digest: string;
};

export type InstalledPluginPackage = {
  pluginKey: string;
  version: string;
  pluginId: string;
  pluginVersionId: string;
  pluginInstallationId: string;
  installationVersion: number;
  manifest: Record<string, unknown>;
  status: string;
};

export type InstalledPluginPackageSummary = {
  pluginKey: string;
  version: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  sourceUrl: string | null;
  manifestDigest: string;
  installationVersion: number;
  componentCount: number;
  status: "active" | "needs_attention";
  installedAt: string;
  updatedAt: string;
};

export type PreparedPluginPackage = InstalledPluginPackage & {
  operationId: string;
  replayResult: Record<string, unknown> | null;
};

export class PluginOperationIdempotencyError extends Error {
  readonly name = "PluginOperationIdempotencyError";
}

export class PluginInstallationVersionConflictError extends Error {
  readonly name = "PluginInstallationVersionConflictError";
}

export class PluginInstallationVersionRequiredError extends Error {
  readonly name = "PluginInstallationVersionRequiredError";
}

export async function getInstalledPluginPackage(
  db: Database,
  workspaceId: string,
  pluginKey: string,
): Promise<InstalledPluginPackage | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        pluginKey: schema.capabilityPlugins.pluginKey,
        version: schema.capabilityPluginVersions.version,
        pluginId: schema.capabilityPlugins.id,
        pluginVersionId: schema.capabilityPluginVersions.id,
        pluginInstallationId: schema.capabilityPluginInstallations.id,
        installationVersion: schema.capabilityPluginInstallations.version,
        manifest: schema.capabilityPluginVersions.manifest,
        status: schema.capabilityPluginInstallations.status,
      })
      .from(schema.capabilityPluginInstallations)
      .innerJoin(
        schema.capabilityPlugins,
        eq(schema.capabilityPlugins.id, schema.capabilityPluginInstallations.pluginId),
      )
      .innerJoin(
        schema.capabilityPluginVersions,
        eq(
          schema.capabilityPluginVersions.id,
          schema.capabilityPluginInstallations.pluginVersionId,
        ),
      )
      .where(
        and(
          eq(schema.capabilityPluginInstallations.workspaceId, workspaceId),
          eq(schema.capabilityPlugins.pluginKey, pluginKey),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function listInstalledPluginPackages(
  db: Database,
  workspaceId: string,
): Promise<InstalledPluginPackageSummary[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        pluginKey: schema.capabilityPlugins.pluginKey,
        version: schema.capabilityPluginVersions.version,
        name: schema.capabilityPlugins.name,
        description: schema.capabilityPlugins.description,
        category: schema.capabilityPlugins.category,
        tags: schema.capabilityPlugins.tags,
        manifestDigest: schema.capabilityPluginVersions.manifestDigest,
        manifest: schema.capabilityPluginVersions.manifest,
        installationVersion: schema.capabilityPluginInstallations.version,
        status: schema.capabilityPluginInstallations.status,
        installedAt: schema.capabilityPluginInstallations.installedAt,
        updatedAt: schema.capabilityPluginInstallations.updatedAt,
      })
      .from(schema.capabilityPluginInstallations)
      .innerJoin(
        schema.capabilityPlugins,
        eq(schema.capabilityPlugins.id, schema.capabilityPluginInstallations.pluginId),
      )
      .innerJoin(
        schema.capabilityPluginVersions,
        eq(
          schema.capabilityPluginVersions.id,
          schema.capabilityPluginInstallations.pluginVersionId,
        ),
      )
      .where(
        and(
          eq(schema.capabilityPluginInstallations.workspaceId, workspaceId),
          inArray(schema.capabilityPluginInstallations.status, ["active", "needs_attention"]),
          sql`jsonb_typeof(${schema.capabilityPluginVersions.manifest} -> 'components') = 'array'`,
          sql`jsonb_typeof(${schema.capabilityPluginVersions.manifest} -> 'bom') = 'array'`,
        ),
      )
      .orderBy(asc(schema.capabilityPlugins.name), asc(schema.capabilityPlugins.pluginKey));

    return rows.map((row) => {
      const manifest = objectValue(row.manifest);
      const sourceUrl = stringValue(manifest.sourceUrl);
      const bom = pluginBom(manifest);
      if (row.status !== "active" && row.status !== "needs_attention") {
        throw new Error(`Unknown installed Plugin status: ${row.status}`);
      }
      return {
        pluginKey: row.pluginKey,
        version: row.version,
        name: row.name,
        description: row.description ?? "",
        category: row.category,
        tags:
          stringArray(manifest.tags).length > 0
            ? stringArray(manifest.tags)
            : stringArray(row.tags),
        sourceUrl: sourceUrl && safeHttpUrl(sourceUrl) ? sourceUrl : null,
        manifestDigest: row.manifestDigest,
        installationVersion: row.installationVersion,
        componentCount: bom.length,
        status: row.status,
        installedAt: row.installedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  });
}

export async function preparePluginPackageInstall(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    pluginKey: string;
    version: string;
    name: string;
    description: string;
    category: string;
    tags: string[];
    manifestDigest: string;
    manifest: Record<string, unknown>;
    idempotencyKey: string;
    requestDigest: string;
    expectedInstallationVersion?: number;
  },
): Promise<PreparedPluginPackage> {
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
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`plugin-package:${input.workspaceId}:${input.pluginKey}`}, 0))`,
        );
        let [operation] = await tx
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
        const resuming = Boolean(operation);
        if (operation && operation.requestDigest !== input.requestDigest) {
          throw new PluginOperationIdempotencyError("Plugin idempotency key was reused");
        }
        if (operation?.status === "completed" && operation.result) {
          const current = await pluginPackageInScope(tx, input.workspaceId, input.pluginKey);
          if (!current) throw new Error("Completed Plugin operation lost its installation");
          return { ...current, operationId: operation.id, replayResult: operation.result };
        }
        if (!operation) {
          [operation] = await tx
            .insert(schema.capabilityOperations)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              idempotencyKey: input.idempotencyKey,
              requestDigest: input.requestDigest,
              kind: input.expectedInstallationVersion ? "update" : "install",
              targetKind: "plugin",
              targetId: input.pluginKey,
              status: "running",
              phase: "admitted",
              createdBySubjectId: input.subjectId,
            })
            .returning();
        } else {
          [operation] = await tx
            .update(schema.capabilityOperations)
            .set({
              status: "running",
              phase: "resuming",
              errorCode: null,
              version: operation.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(schema.capabilityOperations.id, operation.id))
            .returning();
        }
        if (!operation) throw new Error("Failed to admit Plugin operation");

        let [plugin] = await tx
          .select()
          .from(schema.capabilityPlugins)
          .where(
            and(
              eq(schema.capabilityPlugins.workspaceId, input.workspaceId),
              eq(schema.capabilityPlugins.pluginKey, input.pluginKey),
            ),
          )
          .for("update")
          .limit(1);
        if (!plugin) {
          [plugin] = await tx
            .insert(schema.capabilityPlugins)
            .values({
              pluginKey: input.pluginKey,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              name: input.name,
              description: input.description,
              category: input.category,
              tags: input.tags,
              provenance: "workspace",
            })
            .returning();
        } else {
          [plugin] = await tx
            .update(schema.capabilityPlugins)
            .set({
              name: input.name,
              description: input.description,
              category: input.category,
              tags: input.tags,
              updatedAt: new Date(),
            })
            .where(eq(schema.capabilityPlugins.id, plugin.id))
            .returning();
        }
        if (!plugin) throw new Error("Failed to persist Plugin definition");

        let [pluginVersion] = await tx
          .select()
          .from(schema.capabilityPluginVersions)
          .where(
            and(
              eq(schema.capabilityPluginVersions.pluginId, plugin.id),
              eq(schema.capabilityPluginVersions.version, input.version),
            ),
          )
          .for("update")
          .limit(1);
        if (pluginVersion && pluginVersion.manifestDigest !== input.manifestDigest) {
          throw new Error("Plugin version conflicts with immutable manifest content");
        }
        if (!pluginVersion) {
          [pluginVersion] = await tx
            .insert(schema.capabilityPluginVersions)
            .values({
              pluginId: plugin.id,
              version: input.version,
              manifestDigest: input.manifestDigest,
              manifest: input.manifest,
              status: "published",
            })
            .returning();
        }
        if (!pluginVersion) throw new Error("Failed to persist Plugin version");

        let [installation] = await tx
          .select()
          .from(schema.capabilityPluginInstallations)
          .where(
            and(
              eq(schema.capabilityPluginInstallations.workspaceId, input.workspaceId),
              eq(schema.capabilityPluginInstallations.pluginId, plugin.id),
            ),
          )
          .for("update")
          .limit(1);
        if (
          installation &&
          !resuming &&
          input.expectedInstallationVersion !== undefined &&
          installation.version !== input.expectedInstallationVersion
        ) {
          throw new PluginInstallationVersionConflictError("Plugin installation changed");
        }
        if (installation && !resuming && input.expectedInstallationVersion === undefined) {
          throw new PluginInstallationVersionRequiredError(
            "Updating a Plugin requires the previewed installation version",
          );
        }
        if (!installation && !resuming && input.expectedInstallationVersion !== undefined) {
          throw new PluginInstallationVersionConflictError("Plugin installation changed");
        }
        if (!installation) {
          [installation] = await tx
            .insert(schema.capabilityPluginInstallations)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              pluginId: plugin.id,
              pluginVersionId: pluginVersion.id,
              status: "needs_attention",
              installedBySubjectId: input.subjectId,
            })
            .returning();
        } else if (!resuming) {
          [installation] = await tx
            .update(schema.capabilityPluginInstallations)
            .set({
              pluginVersionId: pluginVersion.id,
              status: "needs_attention",
              version: installation.version + 1,
              installedBySubjectId: input.subjectId,
              updatedAt: new Date(),
            })
            .where(eq(schema.capabilityPluginInstallations.id, installation.id))
            .returning();
        }
        if (!installation) throw new Error("Failed to persist Plugin installation");
        return {
          pluginKey: input.pluginKey,
          version: input.version,
          pluginId: plugin.id,
          pluginVersionId: pluginVersion.id,
          pluginInstallationId: installation.id,
          installationVersion: installation.version,
          manifest: input.manifest,
          status: installation.status,
          operationId: operation.id,
          replayResult: operation.result ?? null,
        };
      });
    },
  );
}

export async function checkpointPluginPackageOperation(
  db: Database,
  input: {
    workspaceId: string;
    operationId: string;
    phase: string;
    completedKeys: string[];
  },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    await scopedDb
      .update(schema.capabilityOperations)
      .set({
        status: "running",
        phase: input.phase,
        result: { completedKeys: input.completedKeys },
        errorCode: null,
        version: sql`${schema.capabilityOperations.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.capabilityOperations.id, input.operationId));
  });
}

export async function deferPluginPackageOperation(
  db: Database,
  input: { workspaceId: string; operationId: string; phase: string; errorCode: string },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    await scopedDb
      .update(schema.capabilityOperations)
      .set({
        status: "pending",
        phase: input.phase,
        errorCode: input.errorCode.slice(0, 120),
        version: sql`${schema.capabilityOperations.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.capabilityOperations.id, input.operationId));
  });
}

export async function finalizePluginPackageInstall(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    operationId: string;
    pluginInstallationId: string;
    retainedFacetInstallationIds: string[];
    retainedBindingIds: string[];
    result: Record<string, unknown>;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.subjectId);
      return await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const ownedRows = await tx
          .select({
            ownerId: schema.capabilityComponentOwners.id,
            facetInstallationId: schema.capabilityComponentOwners.facetInstallationId,
          })
          .from(schema.capabilityComponentOwners)
          .where(
            and(
              eq(schema.capabilityComponentOwners.workspaceId, input.workspaceId),
              eq(schema.capabilityComponentOwners.ownerKind, "plugin"),
              eq(schema.capabilityComponentOwners.ownerId, input.pluginInstallationId),
            ),
          );
        const retained = new Set(input.retainedFacetInstallationIds);
        const stale = ownedRows.filter((row) => !retained.has(row.facetInstallationId));
        if (stale.length > 0) {
          await tx.delete(schema.capabilityComponentOwners).where(
            inArray(
              schema.capabilityComponentOwners.id,
              stale.map((row) => row.ownerId),
            ),
          );
          await cleanupOrphanedCapabilityComponents(
            tx,
            input.workspaceId,
            stale.map((row) => row.facetInstallationId),
          );
        }
        const ownedBindings = await tx
          .select({ bindingId: schema.integrationFeatureBindingOwners.bindingId })
          .from(schema.integrationFeatureBindingOwners)
          .where(
            and(
              eq(schema.integrationFeatureBindingOwners.workspaceId, input.workspaceId),
              eq(schema.integrationFeatureBindingOwners.ownerKind, "plugin"),
              eq(schema.integrationFeatureBindingOwners.ownerId, input.pluginInstallationId),
            ),
          );
        const retainedBindings = new Set(input.retainedBindingIds);
        for (const bindingId of [
          ...new Set(
            ownedBindings
              .map((row) => row.bindingId)
              .filter((candidateId) => !retainedBindings.has(candidateId)),
          ),
        ]) {
          await removeIntegrationFeatureBindingOwner(tx, {
            workspaceId: input.workspaceId,
            bindingId,
            owner: { kind: "plugin", id: input.pluginInstallationId },
          });
        }
        await tx
          .update(schema.capabilityPluginInstallations)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(schema.capabilityPluginInstallations.id, input.pluginInstallationId));
        await tx
          .update(schema.capabilityOperations)
          .set({
            status: "completed",
            phase: "completed",
            result: input.result,
            errorCode: null,
            version: sql`${schema.capabilityOperations.version} + 1`,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.capabilityOperations.id, input.operationId));
      });
    },
  );
}

export async function installPluginMcpReference(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    ownerPluginInstallationId: string;
    serverId: string;
    name: string;
    url: string;
    allowedTools: string[];
    timeoutMs?: number;
    cacheToolsList?: boolean;
    requireApproval?: boolean | string[];
    connectionRef?: Record<string, unknown>;
    authKind: CapabilityCatalogAuthKind;
    digest: string;
  },
): Promise<{ capabilityId: string; facetInstallationId: string }> {
  const capabilityId = `mcp:configured:${input.serverId}`;
  const pluginKey = `plugin-mcp/${input.serverId}`;
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.subjectId);
      return await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const now = new Date();
        await lockCapabilityComponentIdentity(tx, input.workspaceId, pluginKey);
        let [plugin] = await tx
          .select()
          .from(schema.capabilityPlugins)
          .where(
            and(
              eq(schema.capabilityPlugins.workspaceId, input.workspaceId),
              eq(schema.capabilityPlugins.pluginKey, pluginKey),
            ),
          )
          .for("update")
          .limit(1);
        if (!plugin) {
          [plugin] = await tx
            .insert(schema.capabilityPlugins)
            .values({
              pluginKey,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              name: input.name,
              description: `Configured MCP reference ${input.serverId}`,
              category: "integrations",
              tags: ["mcp", "configured", "plugin"],
              provenance: "deployment",
            })
            .returning();
        }
        if (!plugin) throw new Error("Failed to persist Plugin MCP definition");
        const manifest = {
          schemaVersion: 1,
          kind: "mcp",
          capabilityId,
          serverId: input.serverId,
          url: input.url,
          digest: input.digest,
        };
        let [version] = await tx
          .select()
          .from(schema.capabilityPluginVersions)
          .where(
            and(
              eq(schema.capabilityPluginVersions.pluginId, plugin.id),
              eq(schema.capabilityPluginVersions.version, input.digest),
            ),
          )
          .limit(1);
        if (!version) {
          [version] = await tx
            .insert(schema.capabilityPluginVersions)
            .values({
              pluginId: plugin.id,
              version: input.digest,
              manifestDigest: input.digest,
              manifest,
            })
            .returning();
        }
        if (!version) throw new Error("Failed to persist Plugin MCP version");
        let [facet] = await tx
          .select()
          .from(schema.capabilityFacets)
          .where(
            and(
              eq(schema.capabilityFacets.pluginVersionId, version.id),
              eq(schema.capabilityFacets.facetKey, "mcp"),
            ),
          )
          .limit(1);
        if (!facet) {
          [facet] = await tx
            .insert(schema.capabilityFacets)
            .values({
              pluginVersionId: version.id,
              facetKey: "mcp",
              kind: "mcp",
              activationMode: "workspace_managed",
              required: true,
            })
            .returning();
          await tx.insert(schema.capabilityMcpFacets).values({
            facetId: facet!.id,
            serverId: input.serverId,
            endpointUrl: input.url,
            transport: "streamable_http",
            authKind: input.authKind,
            allowedTools: input.allowedTools,
          });
        }
        if (!facet) throw new Error("Failed to persist Plugin MCP facet");
        let [installation] = await tx
          .select()
          .from(schema.capabilityPluginInstallations)
          .where(
            and(
              eq(schema.capabilityPluginInstallations.workspaceId, input.workspaceId),
              eq(schema.capabilityPluginInstallations.pluginId, plugin.id),
            ),
          )
          .for("update")
          .limit(1);
        if (installation && installation.pluginVersionId !== version.id) {
          await assertCapabilityComponentVersionCanChange(tx, {
            workspaceId: input.workspaceId,
            pluginKey,
            pluginInstallationId: installation.id,
            owner: { kind: "plugin", id: input.ownerPluginInstallationId },
          });
        }
        if (!installation) {
          [installation] = await tx
            .insert(schema.capabilityPluginInstallations)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              pluginId: plugin.id,
              pluginVersionId: version.id,
              status: "active",
              installedBySubjectId: input.subjectId,
            })
            .returning();
        } else if (
          installation.pluginVersionId !== version.id ||
          installation.status !== "active"
        ) {
          await tx
            .delete(schema.capabilityFacetInstallations)
            .where(eq(schema.capabilityFacetInstallations.pluginInstallationId, installation.id));
          [installation] = await tx
            .update(schema.capabilityPluginInstallations)
            .set({
              pluginVersionId: version.id,
              status: "active",
              version: installation.version + 1,
              installedBySubjectId: input.subjectId,
              installedAt: now,
              updatedAt: now,
            })
            .where(eq(schema.capabilityPluginInstallations.id, installation.id))
            .returning();
        }
        if (!installation) throw new Error("Failed to persist Plugin MCP installation");
        let [facetInstallation] = await tx
          .select()
          .from(schema.capabilityFacetInstallations)
          .where(
            and(
              eq(schema.capabilityFacetInstallations.pluginInstallationId, installation.id),
              eq(schema.capabilityFacetInstallations.facetId, facet.id),
            ),
          )
          .limit(1);
        if (!facetInstallation) {
          [facetInstallation] = await tx
            .insert(schema.capabilityFacetInstallations)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              pluginInstallationId: installation.id,
              facetId: facet.id,
              status: "active",
              config: { serverId: input.serverId },
            })
            .returning();
        }
        if (!facetInstallation) throw new Error("Failed to persist Plugin MCP facet installation");
        await tx
          .insert(schema.capabilityComponentOwners)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            facetInstallationId: facetInstallation.id,
            ownerKind: "plugin",
            ownerId: input.ownerPluginInstallationId,
            removable: true,
          })
          .onConflictDoNothing();
        const metadata = {
          platformVersion: 2,
          serverId: input.serverId,
          mcpServerId: input.serverId,
          pluginInstallationId: installation.id,
          facetInstallationId: facetInstallation.id,
          pluginOwnerInstallationId: input.ownerPluginInstallationId,
          provenance: "plugin_configured_mcp",
        };
        await tx
          .insert(schema.capabilityCatalogItems)
          .values({
            id: capabilityId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            kind: "mcp",
            source: "manual",
            name: input.name,
            description: `Configured MCP reference ${input.serverId}`,
            category: "integrations",
            tags: ["mcp", "plugin"],
            endpointUrl: input.url,
            surfaceType: "mcp",
            transport: "streamable-http",
            authKind: input.authKind,
            provenance: "plugin_configured_mcp",
            metadata,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.capabilityCatalogItems.workspaceId, schema.capabilityCatalogItems.id],
            set: { name: input.name, endpointUrl: input.url, metadata, updatedAt: now },
          });
        await tx
          .insert(schema.capabilityInstallations)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            capabilityId,
            kind: "mcp",
            status: "active",
            config: {
              allowedTools: input.allowedTools,
              ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
              ...(input.cacheToolsList !== undefined
                ? { cacheToolsList: input.cacheToolsList }
                : {}),
              ...(input.requireApproval !== undefined
                ? { requireApproval: input.requireApproval }
                : {}),
              ...(input.connectionRef ? { connectionRef: input.connectionRef } : {}),
            },
            metadata: {
              ...metadata,
              mcpConnectivity: {
                status: input.connectionRef ? "auth_deferred" : "ok",
                checkedAt: now.toISOString(),
                source: "deployment_config",
              },
            },
            enabledAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              schema.capabilityInstallations.workspaceId,
              schema.capabilityInstallations.capabilityId,
            ],
            set: {
              status: "active",
              config: sql`excluded.config`,
              metadata: sql`excluded.metadata`,
              updatedAt: now,
            },
          });
        return { capabilityId, facetInstallationId: facetInstallation.id };
      });
    },
  );
}

export async function getPluginPackageUninstallPreview(
  db: Database,
  workspaceId: string,
  pluginKey: string,
): Promise<{
  installed: boolean;
  version: string | null;
  installationVersion: number | null;
  components: Array<{
    capabilityId: string;
    kind: "skill" | "integration" | "mcp";
    retainedByOtherOwners: boolean;
  }>;
}> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const plugin = await pluginPackageInScope(scopedDb, workspaceId, pluginKey);
    if (!plugin || plugin.status === "disabled") {
      return { installed: false, version: null, installationVersion: null, components: [] };
    }
    const components = await pluginOwnedComponents(
      scopedDb,
      workspaceId,
      plugin.pluginInstallationId,
    );
    return {
      installed: true,
      version: plugin.version,
      installationVersion: plugin.installationVersion,
      components,
    };
  });
}

export async function uninstallPluginPackage(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    pluginKey: string;
    expectedInstallationVersion: number;
    idempotencyKey: string;
  },
): Promise<{ status: "not_installed" | "uninstalled"; retainedComponents: string[] }> {
  const requestDigest = sha256(
    stableJson({
      pluginKey: input.pluginKey,
      expectedInstallationVersion: input.expectedInstallationVersion,
    }),
  );
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
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`plugin-package:${input.workspaceId}:${input.pluginKey}`}, 0))`,
        );
        const [existingOperation] = await tx
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
        if (existingOperation) {
          if (existingOperation.requestDigest !== requestDigest) {
            throw new PluginOperationIdempotencyError("Plugin idempotency key was reused");
          }
          if (existingOperation.status === "completed" && existingOperation.result) {
            return {
              status:
                existingOperation.result.status === "not_installed"
                  ? "not_installed"
                  : "uninstalled",
              retainedComponents: stringArray(existingOperation.result.retainedComponents),
            };
          }
        }
        const plugin = await pluginPackageInScope(tx, input.workspaceId, input.pluginKey, true);
        if (!plugin || plugin.status === "disabled") {
          await completeInlineOperation(tx, input, requestDigest, {
            status: "not_installed",
            retainedComponents: [],
          });
          return { status: "not_installed", retainedComponents: [] };
        }
        if (plugin.installationVersion !== input.expectedInstallationVersion) {
          throw new PluginInstallationVersionConflictError("Plugin installation changed");
        }
        const components = await pluginOwnedComponents(
          tx,
          input.workspaceId,
          plugin.pluginInstallationId,
        );
        await removeIntegrationFeatureBindingOwnersForOwner(tx, {
          workspaceId: input.workspaceId,
          owner: { kind: "plugin", id: plugin.pluginInstallationId },
        });
        const owned = await tx
          .delete(schema.capabilityComponentOwners)
          .where(
            and(
              eq(schema.capabilityComponentOwners.workspaceId, input.workspaceId),
              eq(schema.capabilityComponentOwners.ownerKind, "plugin"),
              eq(schema.capabilityComponentOwners.ownerId, plugin.pluginInstallationId),
            ),
          )
          .returning({ facetInstallationId: schema.capabilityComponentOwners.facetInstallationId });
        await cleanupOrphanedCapabilityComponents(
          tx,
          input.workspaceId,
          owned.map((row) => row.facetInstallationId),
        );
        await tx
          .update(schema.capabilityPluginInstallations)
          .set({
            status: "disabled",
            version: plugin.installationVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.capabilityPluginInstallations.id, plugin.pluginInstallationId));
        const retainedComponents = components
          .filter((component) => component.retainedByOtherOwners)
          .map((component) => component.capabilityId);
        await completeInlineOperation(tx, input, requestDigest, {
          status: "uninstalled",
          retainedComponents,
        });
        return { status: "uninstalled", retainedComponents };
      });
    },
  );
}

async function pluginPackageInScope(
  db: Database,
  workspaceId: string,
  pluginKey: string,
  lock = false,
): Promise<InstalledPluginPackage | null> {
  let query = db
    .select({
      pluginKey: schema.capabilityPlugins.pluginKey,
      version: schema.capabilityPluginVersions.version,
      pluginId: schema.capabilityPlugins.id,
      pluginVersionId: schema.capabilityPluginVersions.id,
      pluginInstallationId: schema.capabilityPluginInstallations.id,
      installationVersion: schema.capabilityPluginInstallations.version,
      manifest: schema.capabilityPluginVersions.manifest,
      status: schema.capabilityPluginInstallations.status,
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
        eq(schema.capabilityPlugins.pluginKey, pluginKey),
      ),
    )
    .limit(1);
  if (lock) query = query.for("update") as typeof query;
  const [row] = await query;
  return row ?? null;
}

async function pluginOwnedComponents(
  db: Database,
  workspaceId: string,
  ownerPluginInstallationId: string,
): Promise<
  Array<{
    capabilityId: string;
    kind: "skill" | "integration" | "mcp";
    retainedByOtherOwners: boolean;
  }>
> {
  const rows = await db
    .select({
      facetInstallationId: schema.capabilityFacetInstallations.id,
      facetKind: schema.capabilityFacets.kind,
      skillCapabilityId: schema.capabilitySkillFacets.capabilityId,
      manifest: schema.capabilityPluginVersions.manifest,
    })
    .from(schema.capabilityComponentOwners)
    .innerJoin(
      schema.capabilityFacetInstallations,
      eq(
        schema.capabilityFacetInstallations.id,
        schema.capabilityComponentOwners.facetInstallationId,
      ),
    )
    .innerJoin(
      schema.capabilityFacets,
      eq(schema.capabilityFacets.id, schema.capabilityFacetInstallations.facetId),
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
    .leftJoin(
      schema.capabilitySkillFacets,
      eq(schema.capabilitySkillFacets.facetId, schema.capabilityFacets.id),
    )
    .where(
      and(
        eq(schema.capabilityComponentOwners.workspaceId, workspaceId),
        eq(schema.capabilityComponentOwners.ownerKind, "plugin"),
        eq(schema.capabilityComponentOwners.ownerId, ownerPluginInstallationId),
      ),
    )
    .orderBy(asc(schema.capabilityFacets.kind), asc(schema.capabilityFacets.facetKey));
  const components = new Map<
    string,
    { capabilityId: string; kind: "skill" | "integration" | "mcp"; facetIds: string[] }
  >();
  for (const row of rows) {
    const manifest = objectValue(row.manifest);
    const capabilityId = row.skillCapabilityId ?? stringValue(manifest.capabilityId);
    const kind =
      row.facetKind === "skill"
        ? "skill"
        : row.facetKind === "mcp"
          ? "mcp"
          : row.facetKind === "api" || row.facetKind === "integration"
            ? "integration"
            : null;
    if (!capabilityId || !kind) continue;
    const existing = components.get(capabilityId);
    if (existing) existing.facetIds.push(row.facetInstallationId);
    else components.set(capabilityId, { capabilityId, kind, facetIds: [row.facetInstallationId] });
  }
  const result = [];
  for (const component of components.values()) {
    const [ownerCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.capabilityComponentOwners)
      .where(
        and(
          inArray(schema.capabilityComponentOwners.facetInstallationId, component.facetIds),
          effectiveCapabilityOwnerSql(
            schema.capabilityComponentOwners.ownerKind,
            schema.capabilityComponentOwners.ownerId,
          ),
          or(
            ne(schema.capabilityComponentOwners.ownerKind, "plugin"),
            ne(schema.capabilityComponentOwners.ownerId, ownerPluginInstallationId),
          ),
        ),
      );
    result.push({
      capabilityId: component.capabilityId,
      kind: component.kind,
      retainedByOtherOwners: (ownerCount?.count ?? 0) > 0,
    });
  }
  return result;
}

async function completeInlineOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    pluginKey: string;
    idempotencyKey: string;
  },
  requestDigest: string,
  result: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.capabilityOperations).values({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    idempotencyKey: input.idempotencyKey,
    requestDigest,
    kind: "uninstall",
    targetKind: "plugin",
    targetId: input.pluginKey,
    status: "completed",
    phase: "completed",
    result,
    createdBySubjectId: input.subjectId,
    completedAt: new Date(),
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function pluginBom(value: Record<string, unknown>): PluginBomComponent[] {
  if (!Array.isArray(value.bom)) return [];
  return value.bom.flatMap((entry) => {
    const record = objectValue(entry);
    const key = stringValue(record.key);
    const capabilityId = stringValue(record.capabilityId);
    const digest = stringValue(record.digest);
    const kind = record.kind;
    if (
      !key ||
      !capabilityId ||
      !digest ||
      !/^[0-9a-f]{64}$/.test(digest) ||
      (kind !== "skill" && kind !== "integration" && kind !== "mcp")
    ) {
      return [];
    }
    return [{ key, capabilityId, digest, kind }];
  });
}

function safeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
