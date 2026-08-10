import { createHash } from "node:crypto";

import { stableJson, type McpServerConnectionRef } from "@opengeni/contracts";
import { and, asc, eq, sql } from "drizzle-orm";

import { setSubjectRlsContext, withRlsContext, withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

export type ApiIntegrationProtocol = "openapi" | "graphql";
export type ApiIntegrationToolSafety = "read" | "write" | "destructive";
export type ApiIntegrationApprovalMode = "never" | "ask";

export type ApiIntegrationToolDefinition = {
  readonly id: string;
  readonly operationKey: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly safety: ApiIntegrationToolSafety;
  readonly approvalMode: ApiIntegrationApprovalMode;
  readonly deprecated: boolean;
};

type StoredApiIntegrationRevisionBase = {
  readonly id: string;
  readonly integrationId: string;
  readonly contentSha256: string;
  readonly source: { readonly url?: string; readonly provider?: string; readonly fetchedAt?: string };
  readonly title: string;
  readonly description?: string;
  readonly version?: string;
  readonly tools: readonly ApiIntegrationToolDefinition[];
};

export type StoredOpenApiOperationBinding = {
  readonly method: "get" | "put" | "post" | "delete" | "patch" | "head" | "options" | "trace";
  readonly pathTemplate: string;
  readonly serverUrl: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly location: "path" | "query" | "header" | "cookie";
    readonly required: boolean;
    readonly schema: Readonly<Record<string, unknown>>;
    readonly description?: string;
  }[];
  readonly requestBody?: {
    readonly required: boolean;
    readonly contentTypes: readonly string[];
    readonly schemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  };
  readonly requiredScopeAlternatives?: readonly (readonly string[])[];
};

export type StoredGraphqlOperationBinding = {
  readonly kind: "query" | "mutation";
  readonly fieldName: string;
  readonly operationName: string;
  readonly variableDefinitions: readonly string[];
  readonly variableNames: readonly string[];
  readonly defaultSelection?: string;
  readonly selectionAllowed: boolean;
};

/** Protocol-normalized immutable revision persisted in integration_spec_revisions.spec. */
export type StoredApiIntegrationRevision =
  | (StoredApiIntegrationRevisionBase & {
      readonly protocol: "openapi";
      readonly bindings: Readonly<Record<string, StoredOpenApiOperationBinding>>;
    })
  | (StoredApiIntegrationRevisionBase & {
      readonly protocol: "graphql";
      readonly bindings: Readonly<Record<string, StoredGraphqlOperationBinding>>;
    });

export type InstallApiIntegrationInput = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  capabilityId: string;
  pluginKey: string;
  serverId: string;
  name: string;
  description?: string | null;
  category?: string;
  tags?: string[];
  provider?: string;
  providerDomain: string;
  protocol: ApiIntegrationProtocol;
  baseUrl: string;
  sourceUrl?: string | null;
  authScheme?: Record<string, unknown>;
  connectionId?: string | null;
  requiredScopes?: string[];
  ownership?: "workspace" | "subject" | "either";
  allowedTools?: string[];
  revision: StoredApiIntegrationRevision;
};

export type InstalledApiIntegration = {
  capabilityId: string;
  pluginId: string;
  pluginVersionId: string;
  integrationFacetId: string;
  apiFacetId: string;
  pluginInstallationId: string;
  integrationFacetInstallationId: string;
  apiFacetInstallationId: string;
  installationVersion: number;
  revisionId: string;
  serverId: string;
  status: "installed";
};

export type ApiIntegrationRuntime = {
  capabilityId: string;
  pluginKey: string;
  pluginInstallationId: string;
  installationVersion: number;
  serverId: string;
  name: string;
  description: string | null;
  protocol: ApiIntegrationProtocol;
  baseUrl: string;
  sourceUrl: string | null;
  providerDomain: string;
  connectionRef: McpServerConnectionRef | null;
  allowedTools: string[];
  requireApproval: true | string[];
  revision: StoredApiIntegrationRevision;
};

export type ApiIntegrationOwner = {
  kind: "direct" | "plugin" | "pack" | "migration";
  id: string;
  removable: boolean;
};

export type ApiIntegrationUninstallPreview = {
  capabilityId: string;
  installed: boolean;
  installationVersion: number | null;
  directOwner: ApiIntegrationOwner | null;
  remainingOwners: ApiIntegrationOwner[];
  removesRuntimeIntegration: boolean;
};

export type UninstallApiIntegrationResult = {
  capabilityId: string;
  status: "not_installed" | "uninstalled" | "retained_by_other_owners";
  remainingOwners: ApiIntegrationOwner[];
};

export class ApiIntegrationInstallationVersionConflictError extends Error {
  readonly name = "ApiIntegrationInstallationVersionConflictError";

  constructor(
    readonly capabilityId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `API Integration ${capabilityId} changed: expected version ${expectedVersion}, current version ${actualVersion}`,
    );
  }
}

export async function installApiIntegration(
  db: Database,
  input: InstallApiIntegrationInput,
): Promise<InstalledApiIntegration> {
  assertInstallInput(input);
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.subjectId);
      return await scopedDb.transaction(async (tx) => {
        const now = new Date();
        const connection = input.connectionId
          ? await loadInstallConnection(tx as unknown as Database, input)
          : null;
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
              description: input.description ?? null,
              category: input.category ?? "integrations",
              tags: normalizedStrings(input.tags ?? ["integration", input.protocol], 64),
              provenance: "workspace",
            })
            .returning();
        } else if (plugin.accountId !== input.accountId) {
          throw new Error("API Integration plugin tenant mismatch");
        } else if (
          plugin.name !== input.name ||
          plugin.description !== (input.description ?? null) ||
          plugin.category !== (input.category ?? "integrations")
        ) {
          [plugin] = await tx
            .update(schema.capabilityPlugins)
            .set({
              name: input.name,
              description: input.description ?? null,
              category: input.category ?? "integrations",
              tags: normalizedStrings(input.tags ?? ["integration", input.protocol], 64),
              updatedAt: now,
            })
            .where(eq(schema.capabilityPlugins.id, plugin.id))
            .returning();
        }
        if (!plugin) throw new Error("Failed to create API Integration plugin");

        const manifest = {
          schemaVersion: 1,
          kind: "integration",
          capabilityId: input.capabilityId,
          serverId: input.serverId,
          protocol: input.protocol,
          provider: input.provider ?? null,
          providerDomain: input.providerDomain,
          baseUrl: input.baseUrl,
          sourceUrl: input.sourceUrl ?? null,
          revisionId: input.revision.id,
          contentSha256: input.revision.contentSha256,
          toolCount: input.revision.tools.length,
        };
        const manifestDigest = sha256(stableJson(manifest));
        let [pluginVersion] = await tx
          .select()
          .from(schema.capabilityPluginVersions)
          .where(
            and(
              eq(schema.capabilityPluginVersions.pluginId, plugin.id),
              eq(schema.capabilityPluginVersions.version, input.revision.id),
            ),
          )
          .for("update")
          .limit(1);
        if (pluginVersion && pluginVersion.manifestDigest !== manifestDigest) {
          throw new Error(`API Integration revision ${input.revision.id} conflicts with stored content`);
        }
        if (!pluginVersion) {
          [pluginVersion] = await tx
            .insert(schema.capabilityPluginVersions)
            .values({
              pluginId: plugin.id,
              version: input.revision.id,
              manifestDigest,
              manifest,
              status: "published",
            })
            .returning();
        }
        if (!pluginVersion) throw new Error("Failed to create API Integration version");

        const integrationFacet = await ensureFacet(tx as unknown as Database, {
          pluginVersionId: pluginVersion.id,
          facetKey: "integration",
          kind: "integration",
        });
        const apiFacet = await ensureFacet(tx as unknown as Database, {
          pluginVersionId: pluginVersion.id,
          facetKey: "api",
          kind: "api",
        });
        await tx
          .insert(schema.capabilityIntegrationFacets)
          .values({
            facetId: integrationFacet.id,
            providerDomain: input.providerDomain,
            connectionKinds: connection ? [connection.kind] : [],
            ownership: input.ownership ?? (connection?.subjectId ? "subject" : "workspace"),
            requiredScopes: normalizedStrings(input.requiredScopes ?? [], 256),
            resourceSelection: "none",
          })
          .onConflictDoNothing();
        await tx
          .insert(schema.capabilityApiFacets)
          .values({
            facetId: apiFacet.id,
            protocol: input.protocol,
            baseUrl: input.baseUrl,
            specSourceUrl: input.sourceUrl ?? null,
            authScheme: input.authScheme ?? {},
            integrationFacetId: integrationFacet.id,
          })
          .onConflictDoNothing();
        await tx
          .insert(schema.integrationSpecRevisions)
          .values({
            apiFacetId: apiFacet.id,
            revision: 1,
            protocol: input.protocol,
            sourceUrl: input.sourceUrl ?? null,
            specDigest: input.revision.contentSha256,
            spec: input.revision as unknown as Record<string, unknown>,
            status: "active",
          })
          .onConflictDoNothing();
        await tx
          .insert(schema.integrationTools)
          .values(
            input.revision.tools.map((tool) => ({
              facetId: apiFacet.id,
              toolKey: tool.id,
              name: tool.name,
              description: tool.description || null,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema ?? null,
              effect: tool.safety,
              active: !tool.deprecated,
            })),
          )
          .onConflictDoNothing();

        let [pluginInstallation] = await tx
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
        const existingPluginInstallation = pluginInstallation;
        let pluginInstallationGenerationAdvanced = false;
        if (!pluginInstallation) {
          [pluginInstallation] = await tx
            .insert(schema.capabilityPluginInstallations)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              pluginId: plugin.id,
              pluginVersionId: pluginVersion.id,
              status: "active",
              installedBySubjectId: input.subjectId,
            })
            .returning();
        } else if (
          pluginInstallation.pluginVersionId !== pluginVersion.id ||
          pluginInstallation.status !== "active"
        ) {
          await tx
            .delete(schema.capabilityFacetInstallations)
            .where(
              eq(schema.capabilityFacetInstallations.pluginInstallationId, pluginInstallation.id),
            );
          [pluginInstallation] = await tx
            .update(schema.capabilityPluginInstallations)
            .set({
              pluginVersionId: pluginVersion.id,
              status: "active",
              version: pluginInstallation.version + 1,
              installedBySubjectId: input.subjectId,
              installedAt: now,
              updatedAt: now,
            })
            .where(eq(schema.capabilityPluginInstallations.id, pluginInstallation.id))
            .returning();
          pluginInstallationGenerationAdvanced = true;
        }
        if (!pluginInstallation) throw new Error("Failed to create API Integration installation");

        const integrationFacetInstallationResult = await ensureFacetInstallation(
          tx as unknown as Database,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            pluginInstallationId: pluginInstallation.id,
            facetId: integrationFacet.id,
            connectionId: input.connectionId ?? null,
            config: {},
          },
        );
        const integrationFacetInstallation = integrationFacetInstallationResult.row;
        const selectedTools = selectedToolIds(input);
        const apiFacetInstallationResult = await ensureFacetInstallation(tx as unknown as Database, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          pluginInstallationId: pluginInstallation.id,
          facetId: apiFacet.id,
          connectionId: input.connectionId ?? null,
          config: {
            serverId: input.serverId,
            allowedTools: selectedTools,
            requireApproval: input.revision.tools
              .filter((tool) => selectedTools.includes(tool.id) && tool.approvalMode === "ask")
              .map((tool) => tool.id),
          },
        });
        const apiFacetInstallation = apiFacetInstallationResult.row;
        if (
          existingPluginInstallation &&
          !pluginInstallationGenerationAdvanced &&
          (integrationFacetInstallationResult.changed || apiFacetInstallationResult.changed)
        ) {
          [pluginInstallation] = await tx
            .update(schema.capabilityPluginInstallations)
            .set({
              version: pluginInstallation.version + 1,
              updatedAt: now,
            })
            .where(eq(schema.capabilityPluginInstallations.id, pluginInstallation.id))
            .returning();
          if (!pluginInstallation) {
            throw new Error("Failed to advance API Integration installation version");
          }
        }
        for (const facetInstallation of [integrationFacetInstallation, apiFacetInstallation]) {
          await tx
            .insert(schema.capabilityComponentOwners)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              facetInstallationId: facetInstallation.id,
              ownerKind: "direct",
              ownerId: input.capabilityId,
              removable: true,
            })
            .onConflictDoNothing();
        }

        const compatibilityMetadata = {
          platformVersion: 2,
          protocol: input.protocol,
          provider: input.provider ?? null,
          providerDomain: input.providerDomain,
          pluginId: plugin.id,
          pluginVersionId: pluginVersion.id,
          integrationFacetId: integrationFacet.id,
          apiFacetId: apiFacet.id,
          revisionId: input.revision.id,
          contentSha256: input.revision.contentSha256,
          serverId: input.serverId,
          provenance: "workspace_import",
          connectionBound: connection !== null,
          connectionKind: connection?.kind ?? null,
          connectionOwnership: connection?.subjectId ? "subject" : connection ? "workspace" : "none",
        };
        await tx
          .insert(schema.capabilityCatalogItems)
          .values({
            id: input.capabilityId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            kind: "api",
            source: "manual",
            name: input.name,
            description: input.description ?? null,
            category: input.category ?? "integrations",
            tags: normalizedStrings(input.tags ?? ["integration", input.protocol], 64),
            homepageUrl: input.sourceUrl ?? input.baseUrl,
            endpointUrl: input.baseUrl,
            authModel: connection ? connection.kind : null,
            providerDomain: input.providerDomain,
            surfaceType: "api",
            authKind: connection ? connection.kind : "none",
            provenance: "workspace_import",
            tier: "community",
            metadata: compatibilityMetadata,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.capabilityCatalogItems.workspaceId, schema.capabilityCatalogItems.id],
            set: {
              name: input.name,
              description: input.description ?? null,
              tags: normalizedStrings(input.tags ?? ["integration", input.protocol], 64),
              homepageUrl: input.sourceUrl ?? input.baseUrl,
              endpointUrl: input.baseUrl,
              authModel: connection ? connection.kind : null,
              providerDomain: input.providerDomain,
              surfaceType: "api",
              authKind: connection ? connection.kind : "none",
              metadata: compatibilityMetadata,
              updatedAt: now,
            },
          });
        await tx
          .insert(schema.capabilityInstallations)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            capabilityId: input.capabilityId,
            kind: "api",
            status: "active",
            config: { serverId: input.serverId, allowedTools: selectedTools },
            metadata: {
              ...compatibilityMetadata,
              pluginInstallationId: pluginInstallation.id,
              integrationFacetInstallationId: integrationFacetInstallation.id,
              apiFacetInstallationId: apiFacetInstallation.id,
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
              config: { serverId: input.serverId, allowedTools: selectedTools },
              metadata: {
                ...compatibilityMetadata,
                pluginInstallationId: pluginInstallation.id,
                integrationFacetInstallationId: integrationFacetInstallation.id,
                apiFacetInstallationId: apiFacetInstallation.id,
              },
              enabledAt: now,
              updatedAt: now,
            },
          });

        return {
          capabilityId: input.capabilityId,
          pluginId: plugin.id,
          pluginVersionId: pluginVersion.id,
          integrationFacetId: integrationFacet.id,
          apiFacetId: apiFacet.id,
          pluginInstallationId: pluginInstallation.id,
          integrationFacetInstallationId: integrationFacetInstallation.id,
          apiFacetInstallationId: apiFacetInstallation.id,
          installationVersion: pluginInstallation.version,
          revisionId: input.revision.id,
          serverId: input.serverId,
          status: "installed",
        };
      });
    },
  );
}

export async function listInstalledApiIntegrations(
  db: Database,
  workspaceId: string,
): Promise<ApiIntegrationRuntime[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        pluginKey: schema.capabilityPlugins.pluginKey,
        pluginName: schema.capabilityPlugins.name,
        pluginDescription: schema.capabilityPlugins.description,
        manifest: schema.capabilityPluginVersions.manifest,
        pluginInstallationId: schema.capabilityPluginInstallations.id,
        installationVersion: schema.capabilityPluginInstallations.version,
        apiFacetId: schema.capabilityApiFacets.facetId,
        protocol: schema.capabilityApiFacets.protocol,
        baseUrl: schema.capabilityApiFacets.baseUrl,
        sourceUrl: schema.capabilityApiFacets.specSourceUrl,
        providerDomain: schema.capabilityIntegrationFacets.providerDomain,
        requiredScopes: schema.capabilityIntegrationFacets.requiredScopes,
        apiConfig: schema.capabilityFacetInstallations.config,
        connectionId: schema.capabilityFacetInstallations.connectionId,
        connectionKinds: schema.capabilityIntegrationFacets.connectionKinds,
        ownership: schema.capabilityIntegrationFacets.ownership,
        revision: schema.integrationSpecRevisions.spec,
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
      .innerJoin(
        schema.capabilityFacetInstallations,
        eq(
          schema.capabilityFacetInstallations.pluginInstallationId,
          schema.capabilityPluginInstallations.id,
        ),
      )
      .innerJoin(
        schema.capabilityApiFacets,
        eq(schema.capabilityApiFacets.facetId, schema.capabilityFacetInstallations.facetId),
      )
      .innerJoin(
        schema.capabilityIntegrationFacets,
        eq(
          schema.capabilityIntegrationFacets.facetId,
          schema.capabilityApiFacets.integrationFacetId,
        ),
      )
      .innerJoin(
        schema.integrationSpecRevisions,
        and(
          eq(schema.integrationSpecRevisions.apiFacetId, schema.capabilityApiFacets.facetId),
          eq(schema.integrationSpecRevisions.status, "active"),
        ),
      )
      .where(
        and(
          eq(schema.capabilityPluginInstallations.workspaceId, workspaceId),
          eq(schema.capabilityPluginInstallations.status, "active"),
          eq(schema.capabilityFacetInstallations.status, "active"),
          sql`exists (
            select 1 from ${schema.capabilityComponentOwners} owner
            where owner.facet_installation_id = ${schema.capabilityFacetInstallations.id}
          )`,
        ),
      )
      .orderBy(asc(schema.capabilityPlugins.name), asc(schema.capabilityPlugins.pluginKey));

    return rows.flatMap((row): ApiIntegrationRuntime[] => {
      const revision = storedRevision(row.revision);
      const config = objectValue(row.apiConfig);
      const manifest = objectValue(row.manifest);
      const capabilityId = stringValue(manifest.capabilityId);
      const serverId = stringValue(config.serverId) ?? stringValue(manifest.serverId);
      if (!capabilityId || !serverId || row.protocol !== revision.protocol) {
        throw new Error(`Installed API Integration ${row.pluginKey} has invalid immutable metadata`);
      }
      const allowedTools = stringArray(config.allowedTools) ?? revision.tools.map((tool) => tool.id);
      const requireApproval = stringArray(config.requireApproval) ??
        revision.tools.filter((tool) => tool.approvalMode === "ask").map((tool) => tool.id);
      const connectionRef: McpServerConnectionRef | null = row.connectionId
        ? {
            connectionId: row.connectionId,
            providerDomain: row.providerDomain,
            ...(stringValue(manifest.provider) ? { provider: stringValue(manifest.provider)! } : {}),
            ...(row.connectionKinds[0] === "oauth2" ||
            row.connectionKinds[0] === "api_key" ||
            row.connectionKinds[0] === "app_install" ||
            row.connectionKinds[0] === "delegated"
              ? { kind: row.connectionKinds[0] }
              : {}),
            ...(row.requiredScopes.length > 0 ? { scopes: [...row.requiredScopes] } : {}),
            subjectScope: row.ownership === "subject" ? "subject" : "workspace",
          }
        : null;
      return [
        {
          capabilityId,
          pluginKey: row.pluginKey,
          pluginInstallationId: row.pluginInstallationId,
          installationVersion: row.installationVersion,
          serverId,
          name: row.pluginName,
          description: row.pluginDescription,
          protocol: revision.protocol,
          baseUrl: row.baseUrl,
          sourceUrl: row.sourceUrl,
          providerDomain: row.providerDomain,
          connectionRef,
          allowedTools,
          requireApproval,
          revision,
        },
      ];
    });
  });
}

export async function getApiIntegrationUninstallPreview(
  db: Database,
  workspaceId: string,
  capabilityId: string,
): Promise<ApiIntegrationUninstallPreview> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const context = await integrationOwnerContext(scopedDb, workspaceId, capabilityId);
    if (!context) {
      return {
        capabilityId,
        installed: false,
        installationVersion: null,
        directOwner: null,
        remainingOwners: [],
        removesRuntimeIntegration: false,
      };
    }
    const owners = await integrationOwners(scopedDb, context.pluginInstallationId);
    const directOwner = owners.find((owner) => owner.kind === "direct" && owner.id === capabilityId);
    const remainingOwners = owners.filter(
      (owner) => !(owner.kind === "direct" && owner.id === capabilityId),
    );
    return {
      capabilityId,
      installed: true,
      installationVersion: context.installationVersion,
      directOwner: directOwner ?? null,
      remainingOwners,
      removesRuntimeIntegration: remainingOwners.length === 0,
    };
  });
}

export async function uninstallApiIntegration(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    capabilityId: string;
    expectedInstallationVersion: number;
  },
): Promise<UninstallApiIntegrationResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const context = await integrationOwnerContext(
          tx as unknown as Database,
          input.workspaceId,
          input.capabilityId,
          true,
        );
        if (!context) {
          return { capabilityId: input.capabilityId, status: "not_installed", remainingOwners: [] };
        }
        if (context.installationVersion !== input.expectedInstallationVersion) {
          throw new ApiIntegrationInstallationVersionConflictError(
            input.capabilityId,
            input.expectedInstallationVersion,
            context.installationVersion,
          );
        }
        await tx
          .delete(schema.capabilityComponentOwners)
          .where(
            and(
              eq(schema.capabilityComponentOwners.workspaceId, input.workspaceId),
              eq(schema.capabilityComponentOwners.ownerKind, "direct"),
              eq(schema.capabilityComponentOwners.ownerId, input.capabilityId),
              sql`${schema.capabilityComponentOwners.facetInstallationId} in (
                select id from ${schema.capabilityFacetInstallations}
                where plugin_installation_id = ${context.pluginInstallationId}
              )`,
            ),
          );
        const remainingOwners = await integrationOwners(
          tx as unknown as Database,
          context.pluginInstallationId,
        );
        const now = new Date();
        if (remainingOwners.length > 0) {
          await tx
            .update(schema.capabilityPluginInstallations)
            .set({ version: context.installationVersion + 1, updatedAt: now })
            .where(eq(schema.capabilityPluginInstallations.id, context.pluginInstallationId));
          return {
            capabilityId: input.capabilityId,
            status: "retained_by_other_owners",
            remainingOwners,
          };
        }
        await tx
          .delete(schema.capabilityFacetInstallations)
          .where(
            eq(schema.capabilityFacetInstallations.pluginInstallationId, context.pluginInstallationId),
          );
        await tx
          .update(schema.capabilityPluginInstallations)
          .set({
            status: "disabled",
            version: context.installationVersion + 1,
            updatedAt: now,
          })
          .where(eq(schema.capabilityPluginInstallations.id, context.pluginInstallationId));
        await tx
          .update(schema.capabilityInstallations)
          .set({ status: "disabled", updatedAt: now })
          .where(
            and(
              eq(schema.capabilityInstallations.workspaceId, input.workspaceId),
              eq(schema.capabilityInstallations.capabilityId, input.capabilityId),
            ),
          );
        return { capabilityId: input.capabilityId, status: "uninstalled", remainingOwners: [] };
      }),
  );
}

async function loadInstallConnection(
  db: Database,
  input: InstallApiIntegrationInput,
): Promise<typeof schema.connections.$inferSelect> {
  const [connection] = await db
    .select()
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, input.workspaceId),
        eq(schema.connections.id, input.connectionId!),
      ),
    )
    .limit(1);
  if (!connection || connection.accountId !== input.accountId) {
    throw new Error("API Integration connection was not found in this workspace");
  }
  if (connection.subjectId && connection.subjectId !== input.subjectId) {
    throw new Error("API Integration personal connection belongs to another subject");
  }
  if (connection.status !== "active") {
    throw new Error("API Integration connection is not active");
  }
  if (connection.providerDomain.toLowerCase() !== input.providerDomain.toLowerCase()) {
    throw new Error("API Integration connection provider does not match the destination");
  }
  const missing = normalizedStrings(input.requiredScopes ?? [], 256).filter(
    (scope) => !connection.grantedScopes.includes(scope),
  );
  if (missing.length > 0) {
    throw new Error("API Integration connection is missing required scopes");
  }
  return connection;
}

async function ensureFacet(
  db: Database,
  input: { pluginVersionId: string; facetKey: string; kind: "integration" | "api" },
): Promise<typeof schema.capabilityFacets.$inferSelect> {
  const [existing] = await db
    .select()
    .from(schema.capabilityFacets)
    .where(
      and(
        eq(schema.capabilityFacets.pluginVersionId, input.pluginVersionId),
        eq(schema.capabilityFacets.facetKey, input.facetKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.kind !== input.kind) throw new Error(`Capability facet ${input.facetKey} changed kind`);
    return existing;
  }
  const [created] = await db
    .insert(schema.capabilityFacets)
    .values({
      pluginVersionId: input.pluginVersionId,
      facetKey: input.facetKey,
      kind: input.kind,
      activationMode: "workspace_managed",
      required: true,
    })
    .returning();
  if (!created) throw new Error(`Failed to create capability facet ${input.facetKey}`);
  return created;
}

async function ensureFacetInstallation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    pluginInstallationId: string;
    facetId: string;
    connectionId: string | null;
    config: Record<string, unknown>;
  },
): Promise<{ row: typeof schema.capabilityFacetInstallations.$inferSelect; changed: boolean }> {
  const [existing] = await db
    .select()
    .from(schema.capabilityFacetInstallations)
    .where(
      and(
        eq(schema.capabilityFacetInstallations.pluginInstallationId, input.pluginInstallationId),
        eq(schema.capabilityFacetInstallations.facetId, input.facetId),
      ),
    )
    .limit(1);
  if (!existing) {
    const [created] = await db
      .insert(schema.capabilityFacetInstallations)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        pluginInstallationId: input.pluginInstallationId,
        facetId: input.facetId,
        connectionId: input.connectionId,
        status: "active",
        config: input.config,
      })
      .returning();
    if (!created) throw new Error("Failed to create capability facet installation");
    return { row: created, changed: true };
  }
  if (
    existing.connectionId === input.connectionId &&
    stableJson(existing.config) === stableJson(input.config) &&
    existing.status === "active"
  ) {
    return { row: existing, changed: false };
  }
  const [updated] = await db
    .update(schema.capabilityFacetInstallations)
    .set({
      connectionId: input.connectionId,
      status: "active",
      config: input.config,
      version: existing.version + 1,
      attentionCode: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.capabilityFacetInstallations.id, existing.id))
    .returning();
  if (!updated) throw new Error("Failed to update capability facet installation");
  return { row: updated, changed: true };
}

async function integrationOwnerContext(
  db: Database,
  workspaceId: string,
  capabilityId: string,
  lock = false,
): Promise<{ pluginInstallationId: string; installationVersion: number } | null> {
  let query = db
    .select({
      pluginInstallationId: schema.capabilityPluginInstallations.id,
      installationVersion: schema.capabilityPluginInstallations.version,
    })
    .from(schema.capabilityComponentOwners)
    .innerJoin(
      schema.capabilityFacetInstallations,
      eq(schema.capabilityFacetInstallations.id, schema.capabilityComponentOwners.facetInstallationId),
    )
    .innerJoin(
      schema.capabilityPluginInstallations,
      eq(schema.capabilityPluginInstallations.id, schema.capabilityFacetInstallations.pluginInstallationId),
    )
    .where(
      and(
        eq(schema.capabilityComponentOwners.workspaceId, workspaceId),
        eq(schema.capabilityComponentOwners.ownerKind, "direct"),
        eq(schema.capabilityComponentOwners.ownerId, capabilityId),
      ),
    )
    .limit(3);
  if (lock) query = query.for("update") as typeof query;
  const rows = await query;
  if (rows.length === 0) return null;
  const installationIds = new Set(rows.map((row) => row.pluginInstallationId));
  if (installationIds.size !== 1) throw new Error(`API Integration ${capabilityId} has split owners`);
  return rows[0]!;
}

async function integrationOwners(
  db: Database,
  pluginInstallationId: string,
): Promise<ApiIntegrationOwner[]> {
  const rows = await db
    .select({
      kind: schema.capabilityComponentOwners.ownerKind,
      id: schema.capabilityComponentOwners.ownerId,
      removable: schema.capabilityComponentOwners.removable,
    })
    .from(schema.capabilityComponentOwners)
    .innerJoin(
      schema.capabilityFacetInstallations,
      eq(schema.capabilityFacetInstallations.id, schema.capabilityComponentOwners.facetInstallationId),
    )
    .where(eq(schema.capabilityFacetInstallations.pluginInstallationId, pluginInstallationId))
    .orderBy(asc(schema.capabilityComponentOwners.ownerKind), asc(schema.capabilityComponentOwners.ownerId));
  const owners = new Map<string, ApiIntegrationOwner>();
  for (const row of rows) {
    if (row.kind !== "direct" && row.kind !== "plugin" && row.kind !== "pack" && row.kind !== "migration") {
      throw new Error(`Unknown API Integration owner kind: ${row.kind}`);
    }
    const key = `${row.kind}\0${row.id}`;
    const existing = owners.get(key);
    owners.set(key, {
      kind: row.kind,
      id: row.id,
      removable: (existing?.removable ?? true) && row.removable,
    });
  }
  return [...owners.values()];
}

function assertInstallInput(input: InstallApiIntegrationInput): void {
  if (input.revision.protocol !== input.protocol) throw new Error("API Integration protocol mismatch");
  if (input.revision.contentSha256.length !== 64 || !/^[0-9a-f]+$/.test(input.revision.contentSha256)) {
    throw new Error("API Integration revision digest is invalid");
  }
  if (input.revision.tools.length === 0 || input.revision.tools.length > 2_000) {
    throw new Error("API Integration revision must expose 1-2000 tools");
  }
  if (new Set(input.revision.tools.map((tool) => tool.id)).size !== input.revision.tools.length) {
    throw new Error("API Integration revision has duplicate tool ids");
  }
  const base = new URL(input.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.hash) {
    throw new Error("API Integration baseUrl must be a credential-free HTTPS URL");
  }
  if (base.hostname !== input.providerDomain && !base.hostname.endsWith(`.${input.providerDomain}`)) {
    throw new Error("API Integration providerDomain does not match baseUrl");
  }
  const authKind = objectValue(input.authScheme).kind;
  if (authKind !== undefined && authKind !== "none" && !input.connectionId) {
    throw new Error("Authenticated API Integrations require a Connection");
  }
}

function selectedToolIds(input: InstallApiIntegrationInput): string[] {
  const available = new Set(input.revision.tools.map((tool) => tool.id));
  const selected = input.allowedTools?.length
    ? normalizedStrings(input.allowedTools, 2_000)
    : [...available];
  if (selected.some((tool) => !available.has(tool))) {
    throw new Error("API Integration selected an unknown tool");
  }
  return selected;
}

function storedRevision(value: Record<string, unknown>): StoredApiIntegrationRevision {
  const protocol = value.protocol;
  const tools = value.tools;
  const bindings = value.bindings;
  if (
    (protocol !== "openapi" && protocol !== "graphql") ||
    typeof value.id !== "string" ||
    typeof value.integrationId !== "string" ||
    typeof value.contentSha256 !== "string" ||
    typeof value.title !== "string" ||
    !Array.isArray(tools) ||
    !bindings ||
    typeof bindings !== "object" ||
    Array.isArray(bindings)
  ) {
    throw new Error("Stored API Integration revision is invalid");
  }
  return value as StoredApiIntegrationRevision;
}

function normalizedStrings(values: string[], limit: number): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  if (normalized.length > limit) throw new Error(`String selection exceeds ${limit} entries`);
  return normalized;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? normalizedStrings(value.filter((entry): entry is string => typeof entry === "string"), 2_000)
    : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}