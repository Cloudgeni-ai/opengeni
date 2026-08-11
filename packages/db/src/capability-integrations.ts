import { createHash } from "node:crypto";

import { stableJson, type McpServerConnectionRef } from "@opengeni/contracts";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";

import {
  assertCapabilityComponentVersionCanChange,
  lockCapabilityComponentIdentity,
} from "./capability-components";
import {
  setSubjectRlsContext,
  withRlsContext,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type Database,
} from "./database";
import {
  ensureIntegrationFeatureFacet,
  integrationBindingKey,
  integrationDefinitionHasBindingOwner,
  integrationRuntimeKey,
  listIntegrationFeatureBindingOwners,
  removeIntegrationFeatureBindingOwner,
  upsertIntegrationFeatureBinding,
  type IntegrationFeatureBindingOwner,
} from "./integration-bindings";
import * as schema from "./schema";

export type ApiIntegrationProtocol = "openapi" | "graphql";
export type ApiIntegrationToolSafety = "read" | "write" | "destructive";
export type ApiIntegrationApprovalMode = "never" | "ask";

export type ApiIntegrationFeatureDefinition = {
  readonly featureKey: string;
  readonly kind: "knowledge_source" | "inbound_trigger" | "delivery_destination" | "identity_link";
  readonly configSchema: Readonly<Record<string, unknown>>;
  readonly capabilities: Readonly<Record<string, unknown>>;
};

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
  readonly source: {
    readonly url?: string;
    readonly provider?: string;
    readonly fetchedAt?: string;
  };
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
  presetId?: string | null;
  provider?: string;
  providerDomain: string;
  protocol: ApiIntegrationProtocol;
  baseUrl: string;
  sourceUrl?: string | null;
  authScheme?: Record<string, unknown>;
  connectionId?: string | null;
  instanceKey?: string;
  displayName?: string;
  expectedInstanceVersion?: number;
  requiredScopes?: string[];
  ownership?: "workspace" | "subject" | "either";
  allowedTools?: string[];
  featureDefinitions?: readonly ApiIntegrationFeatureDefinition[];
  revision: StoredApiIntegrationRevision;
  owner?: ApiIntegrationOwner;
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
  instanceId: string;
  instanceKey: string;
  displayName: string;
  instanceVersion: number;
  revisionId: string;
  serverId: string;
  status: "installed";
};

export type ApiIntegrationRuntime = {
  capabilityId: string;
  pluginKey: string;
  pluginInstallationId: string;
  installationVersion: number;
  instanceId: string;
  instanceKey: string;
  displayName: string;
  instanceVersion: number;
  serverId: string;
  name: string;
  description: string | null;
  protocol: ApiIntegrationProtocol;
  presetId: string | null;
  baseUrl: string;
  sourceUrl: string | null;
  providerDomain: string;
  authScheme: Record<string, unknown>;
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
  instanceKey: string;
  displayName: string | null;
  installed: boolean;
  installationVersion: number | null;
  instanceVersion: number | null;
  directOwner: ApiIntegrationOwner | null;
  remainingOwners: ApiIntegrationOwner[];
  removesRuntimeIntegration: boolean;
  removesDefinition: boolean;
};

export type UninstallApiIntegrationResult = {
  capabilityId: string;
  instanceKey: string;
  status: "not_installed" | "uninstalled" | "retained_by_other_owners";
  remainingOwners: ApiIntegrationOwner[];
  definitionStatus: "retained" | "disabled";
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
        await lockCapabilityComponentIdentity(
          tx as unknown as Database,
          input.workspaceId,
          input.pluginKey,
        );
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
          presetId: input.presetId ?? null,
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
          throw new Error(
            `API Integration revision ${input.revision.id} conflicts with stored content`,
          );
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

        const owner: IntegrationFeatureBindingOwner = input.owner ?? {
          kind: "direct",
          id: input.capabilityId,
          removable: true,
        };
        const instanceKey = integrationBindingKey(input.connectionId, input.instanceKey);
        const runtimeServerId = integrationRuntimeKey(input.serverId, instanceKey);
        const displayName =
          input.displayName?.trim() ||
          (instanceKey === "default" ? input.name : `${input.name} — connected account`);
        const toolsFeature = await ensureIntegrationFeatureFacet(tx as unknown as Database, {
          integrationFacetId: integrationFacet.id,
          featureKey: "tools",
          kind: "tools",
          configSchema: {
            type: "object",
            properties: {
              allowedTools: { type: "array", items: { type: "string" } },
              requireApproval: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
          capabilities: { protocol: input.protocol, runtime: "mcp" },
        });
        const featureFacets = new Map<string, typeof schema.integrationFeatureFacets.$inferSelect>([
          [toolsFeature.featureKey, toolsFeature],
        ]);
        for (const feature of input.featureDefinitions ?? []) {
          const facet = await ensureIntegrationFeatureFacet(tx as unknown as Database, {
            integrationFacetId: integrationFacet.id,
            featureKey: feature.featureKey,
            kind: feature.kind,
            configSchema: { ...feature.configSchema },
            capabilities: { ...feature.capabilities },
          });
          featureFacets.set(facet.featureKey, facet);
        }

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
        const oldFacetInstallations = pluginInstallation
          ? await installedFacetRows(tx as unknown as Database, pluginInstallation.id)
          : [];
        let pluginInstallationGenerationAdvanced = false;
        if (pluginInstallation && pluginInstallation.pluginVersionId !== pluginVersion.id) {
          await assertCapabilityComponentVersionCanChange(tx as unknown as Database, {
            workspaceId: input.workspaceId,
            pluginKey: input.pluginKey,
            pluginInstallationId: pluginInstallation.id,
            owner: {
              kind: owner.kind,
              id: owner.id,
            },
          });
        }
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
            connectionId: null,
            config: {},
          },
        );
        const integrationFacetInstallation = integrationFacetInstallationResult.row;
        const selectedTools = selectedToolIds(input);
        const apiFacetInstallationResult = await ensureFacetInstallation(
          tx as unknown as Database,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            pluginInstallationId: pluginInstallation.id,
            facetId: apiFacet.id,
            connectionId: null,
            config: {
              baseServerId: input.serverId,
            },
          },
        );
        const apiFacetInstallation = apiFacetInstallationResult.row;
        if (pluginInstallationGenerationAdvanced) {
          await migrateApiIntegrationFacetInstallations(tx as unknown as Database, {
            workspaceId: input.workspaceId,
            oldFacetInstallations,
            integrationFacetInstallationId: integrationFacetInstallation.id,
            apiFacetInstallationId: apiFacetInstallation.id,
            featureFacets,
            excludedRuntimeKey: runtimeServerId,
            revision: input.revision,
          });
        }
        const approvalRequiredTools = input.revision.tools
          .filter((tool) => selectedTools.includes(tool.id) && tool.approvalMode === "ask")
          .map((tool) => tool.id);
        const bindingResult = await upsertIntegrationFeatureBinding(tx as unknown as Database, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          integrationFacetInstallationId: integrationFacetInstallation.id,
          featureFacetId: toolsFeature.id,
          bindingKey: instanceKey,
          displayName,
          runtimeKey: runtimeServerId,
          connectionId: input.connectionId ?? null,
          config: {
            baseServerId: input.serverId,
            allowedTools: selectedTools,
            requireApproval: approvalRequiredTools,
            connectionKind: connection?.kind ?? null,
            subjectScope: connection?.subjectId ? "subject" : connection ? "workspace" : "none",
          },
          createdBySubjectId: input.subjectId,
          owner,
          ...(input.expectedInstanceVersion !== undefined
            ? { expectedVersion: input.expectedInstanceVersion }
            : {}),
        });
        if (
          existingPluginInstallation &&
          !pluginInstallationGenerationAdvanced &&
          (integrationFacetInstallationResult.changed ||
            apiFacetInstallationResult.changed ||
            bindingResult.changed)
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
              ownerKind: owner.kind,
              ownerId: owner.id,
              removable: owner.removable,
            })
            .onConflictDoNothing();
        }
        if (pluginInstallationGenerationAdvanced && oldFacetInstallations.length > 0) {
          await tx.delete(schema.capabilityFacetInstallations).where(
            inArray(
              schema.capabilityFacetInstallations.id,
              oldFacetInstallations.map((row) => row.id),
            ),
          );
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
          baseServerId: input.serverId,
          multiInstance: true,
          provenance: "workspace_import",
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
            authModel: objectValue(input.authScheme ?? {}).kind
              ? String(objectValue(input.authScheme ?? {}).kind)
              : null,
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
              authModel: objectValue(input.authScheme ?? {}).kind
                ? String(objectValue(input.authScheme ?? {}).kind)
                : null,
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
            config: { baseServerId: input.serverId, multiInstance: true },
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
              config: { baseServerId: input.serverId, multiInstance: true },
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
          instanceId: bindingResult.row.id,
          instanceKey: bindingResult.row.bindingKey,
          displayName: bindingResult.row.displayName,
          instanceVersion: bindingResult.row.version,
          revisionId: input.revision.id,
          serverId: runtimeServerId,
          status: "installed",
        };
      });
    },
  );
}

export async function listInstalledApiIntegrations(
  db: Database,
  workspaceId: string,
  subjectId?: string,
): Promise<ApiIntegrationRuntime[]> {
  const load = async (scopedDb: Database): Promise<ApiIntegrationRuntime[]> => {
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
        authScheme: schema.capabilityApiFacets.authScheme,
        providerDomain: schema.capabilityIntegrationFacets.providerDomain,
        requiredScopes: schema.capabilityIntegrationFacets.requiredScopes,
        instanceId: schema.integrationFeatureBindings.id,
        instanceKey: schema.integrationFeatureBindings.bindingKey,
        displayName: schema.integrationFeatureBindings.displayName,
        instanceVersion: schema.integrationFeatureBindings.version,
        runtimeKey: schema.integrationFeatureBindings.runtimeKey,
        bindingConfig: schema.integrationFeatureBindings.config,
        connectionId: schema.integrationFeatureBindings.connectionId,
        revision: schema.integrationSpecRevisions.spec,
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
      .innerJoin(
        schema.capabilityApiFacets,
        eq(
          schema.capabilityApiFacets.integrationFacetId,
          schema.capabilityIntegrationFacets.facetId,
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
          eq(schema.integrationFeatureFacets.kind, "tools"),
          eq(schema.integrationFeatureBindings.status, "active"),
          sql`${schema.integrationFeatureBindings.runtimeKey} is not null`,
          sql`exists (
            select 1 from ${schema.capabilityComponentOwners} owner
            where owner.facet_installation_id = ${schema.capabilityFacetInstallations.id}
              and (
                owner.owner_kind <> 'plugin'
                or exists (
                  select 1 from ${schema.capabilityPluginInstallations} owning_plugin
                  where owning_plugin.id::text = owner.owner_id
                    and owning_plugin.workspace_id = ${workspaceId}
                    and owning_plugin.status = 'active'
                )
              )
          )`,
          sql`exists (
            select 1 from ${schema.integrationFeatureBindingOwners} owner
            where owner.binding_id = ${schema.integrationFeatureBindings.id}
              and (
                owner.owner_kind <> 'plugin'
                or exists (
                  select 1 from ${schema.capabilityPluginInstallations} owning_plugin
                  where owning_plugin.id::text = owner.owner_id
                    and owning_plugin.workspace_id = ${workspaceId}
                    and owning_plugin.status = 'active'
                )
              )
          )`,
          sql`exists (
            select 1 from ${schema.capabilityFacetInstallations} api_installation
            where api_installation.plugin_installation_id = ${schema.capabilityPluginInstallations.id}
              and api_installation.facet_id = ${schema.capabilityApiFacets.facetId}
              and api_installation.status = 'active'
          )`,
          ...(subjectId
            ? [
                sql`(
                  ${schema.integrationFeatureBindings.connectionId} is null
                  or exists (
                    select 1 from ${schema.connections} connection
                    where connection.id = ${schema.integrationFeatureBindings.connectionId}
                      and (connection.subject_id is null or connection.subject_id = ${subjectId})
                  )
                )`,
              ]
            : []),
        ),
      )
      .orderBy(
        asc(schema.capabilityPlugins.name),
        asc(schema.integrationFeatureBindings.displayName),
        asc(schema.integrationFeatureBindings.bindingKey),
      );

    return rows.flatMap((row): ApiIntegrationRuntime[] => {
      const revision = storedRevision(row.revision);
      const config = objectValue(row.bindingConfig);
      const manifest = objectValue(row.manifest);
      const capabilityId = stringValue(manifest.capabilityId);
      const presetId = stringValue(manifest.presetId) ?? null;
      const serverId = row.runtimeKey;
      if (!capabilityId || !serverId || row.protocol !== revision.protocol) {
        throw new Error(
          `Installed API Integration ${row.pluginKey} has invalid immutable metadata`,
        );
      }
      const allowedTools =
        stringArray(config.allowedTools) ?? revision.tools.map((tool) => tool.id);
      const requireApproval =
        stringArray(config.requireApproval) ??
        revision.tools.filter((tool) => tool.approvalMode === "ask").map((tool) => tool.id);
      const connectionKind = stringValue(config.connectionKind);
      const subjectScope = stringValue(config.subjectScope);
      const connectionRef: McpServerConnectionRef | null = row.connectionId
        ? {
            connectionId: row.connectionId,
            providerDomain: row.providerDomain,
            ...(stringValue(manifest.provider)
              ? { provider: stringValue(manifest.provider)! }
              : {}),
            ...(connectionKind === "oauth2" ||
            connectionKind === "api_key" ||
            connectionKind === "app_install" ||
            connectionKind === "delegated"
              ? { kind: connectionKind }
              : {}),
            ...(row.requiredScopes.length > 0 ? { scopes: [...row.requiredScopes] } : {}),
            subjectScope: subjectScope === "subject" ? "subject" : "workspace",
          }
        : null;
      return [
        {
          capabilityId,
          pluginKey: row.pluginKey,
          pluginInstallationId: row.pluginInstallationId,
          installationVersion: row.installationVersion,
          instanceId: row.instanceId,
          instanceKey: row.instanceKey,
          displayName: row.displayName,
          instanceVersion: row.instanceVersion,
          serverId,
          name: row.displayName,
          description: row.pluginDescription,
          protocol: revision.protocol,
          presetId,
          baseUrl: row.baseUrl,
          sourceUrl: row.sourceUrl,
          providerDomain: row.providerDomain,
          authScheme: objectValue(row.authScheme),
          connectionRef,
          allowedTools,
          requireApproval,
          revision,
        },
      ];
    });
  };
  return subjectId
    ? await withWorkspaceSubjectRls(db, workspaceId, subjectId, load)
    : await withWorkspaceRls(db, workspaceId, load);
}

export async function getApiIntegrationUninstallPreview(
  db: Database,
  workspaceId: string,
  capabilityId: string,
  instanceKey: string,
): Promise<ApiIntegrationUninstallPreview> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const context = await integrationInstanceContext(
      scopedDb,
      workspaceId,
      capabilityId,
      instanceKey,
    );
    if (!context) {
      return {
        capabilityId,
        instanceKey,
        displayName: null,
        installed: false,
        installationVersion: null,
        instanceVersion: null,
        directOwner: null,
        remainingOwners: [],
        removesRuntimeIntegration: false,
        removesDefinition: false,
      };
    }
    const owners = await listIntegrationFeatureBindingOwners(scopedDb, context.instanceId);
    const directOwner = owners.find(
      (owner) => owner.kind === "direct" && owner.id === capabilityId,
    );
    const remainingOwners = owners.filter(
      (owner) => !(owner.kind === "direct" && owner.id === capabilityId),
    );
    const definitionOwners = await integrationOwners(scopedDb, context.pluginInstallationId);
    const remainingDefinitionOwners = definitionOwners.filter(
      (owner) => !(owner.kind === "direct" && owner.id === capabilityId),
    );
    const hasOtherDirectInstance = await integrationDefinitionHasOtherBindingOwner(scopedDb, {
      workspaceId,
      pluginInstallationId: context.pluginInstallationId,
      excludedBindingId: context.instanceId,
      owner: { kind: "direct", id: capabilityId },
    });
    return {
      capabilityId,
      instanceKey,
      displayName: context.displayName,
      installed: true,
      installationVersion: context.installationVersion,
      instanceVersion: context.instanceVersion,
      directOwner: directOwner ?? null,
      remainingOwners,
      removesRuntimeIntegration: remainingOwners.length === 0,
      removesDefinition:
        remainingOwners.length === 0 &&
        !hasOtherDirectInstance &&
        remainingDefinitionOwners.length === 0,
    };
  });
}

export async function uninstallApiIntegration(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    expectedInstallationVersion: number;
    expectedInstanceVersion: number;
  },
): Promise<UninstallApiIntegrationResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.subjectId);
      return await scopedDb.transaction(async (tx) => {
        const context = await integrationInstanceContext(
          tx as unknown as Database,
          input.workspaceId,
          input.capabilityId,
          input.instanceKey,
          true,
        );
        if (!context) {
          return {
            capabilityId: input.capabilityId,
            instanceKey: input.instanceKey,
            status: "not_installed",
            remainingOwners: [],
            definitionStatus: "retained",
          };
        }
        if (context.installationVersion !== input.expectedInstallationVersion) {
          throw new ApiIntegrationInstallationVersionConflictError(
            input.capabilityId,
            input.expectedInstallationVersion,
            context.installationVersion,
          );
        }
        const bindingOwners = await listIntegrationFeatureBindingOwners(
          tx as unknown as Database,
          context.instanceId,
        );
        if (
          !bindingOwners.some((owner) => owner.kind === "direct" && owner.id === input.capabilityId)
        ) {
          return {
            capabilityId: input.capabilityId,
            instanceKey: input.instanceKey,
            status: "not_installed",
            remainingOwners: bindingOwners,
            definitionStatus: "retained",
          };
        }
        const removed = await removeIntegrationFeatureBindingOwner(tx as unknown as Database, {
          workspaceId: input.workspaceId,
          bindingId: context.instanceId,
          owner: { kind: "direct", id: input.capabilityId },
          expectedVersion: input.expectedInstanceVersion,
        });
        const hasAnotherDirectInstance = await integrationDefinitionHasBindingOwner(
          tx as unknown as Database,
          {
            workspaceId: input.workspaceId,
            pluginInstallationId: context.pluginInstallationId,
            owner: { kind: "direct", id: input.capabilityId },
          },
        );
        if (!hasAnotherDirectInstance) {
          await tx.delete(schema.capabilityComponentOwners).where(
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
        }
        const remainingDefinitionOwners = await integrationOwners(
          tx as unknown as Database,
          context.pluginInstallationId,
        );
        const now = new Date();
        if (remainingDefinitionOwners.length > 0 || hasAnotherDirectInstance) {
          await tx
            .update(schema.capabilityPluginInstallations)
            .set({ version: context.installationVersion + 1, updatedAt: now })
            .where(eq(schema.capabilityPluginInstallations.id, context.pluginInstallationId));
          return {
            capabilityId: input.capabilityId,
            instanceKey: input.instanceKey,
            status: removed.remainingOwners.length > 0 ? "retained_by_other_owners" : "uninstalled",
            remainingOwners: removed.remainingOwners,
            definitionStatus: "retained",
          };
        }
        await tx
          .delete(schema.capabilityFacetInstallations)
          .where(
            eq(
              schema.capabilityFacetInstallations.pluginInstallationId,
              context.pluginInstallationId,
            ),
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
        return {
          capabilityId: input.capabilityId,
          instanceKey: input.instanceKey,
          status: removed.remainingOwners.length > 0 ? "retained_by_other_owners" : "uninstalled",
          remainingOwners: removed.remainingOwners,
          definitionStatus: "disabled",
        };
      });
    },
  );
}

type InstalledFacetRow = {
  id: string;
  kind: string;
};

async function installedFacetRows(
  db: Database,
  pluginInstallationId: string,
): Promise<InstalledFacetRow[]> {
  return await db
    .select({
      id: schema.capabilityFacetInstallations.id,
      kind: schema.capabilityFacets.kind,
    })
    .from(schema.capabilityFacetInstallations)
    .innerJoin(
      schema.capabilityFacets,
      eq(schema.capabilityFacets.id, schema.capabilityFacetInstallations.facetId),
    )
    .where(eq(schema.capabilityFacetInstallations.pluginInstallationId, pluginInstallationId));
}

async function migrateApiIntegrationFacetInstallations(
  db: Database,
  input: {
    workspaceId: string;
    oldFacetInstallations: InstalledFacetRow[];
    integrationFacetInstallationId: string;
    apiFacetInstallationId: string;
    featureFacets: ReadonlyMap<string, typeof schema.integrationFeatureFacets.$inferSelect>;
    excludedRuntimeKey: string;
    revision: StoredApiIntegrationRevision;
  },
): Promise<void> {
  if (input.oldFacetInstallations.length === 0) return;
  const oldIntegration = input.oldFacetInstallations.find((row) => row.kind === "integration");
  const targetByKind = new Map<string, string>([
    ["integration", input.integrationFacetInstallationId],
    ["api", input.apiFacetInstallationId],
  ]);
  const oldIds = input.oldFacetInstallations.map((row) => row.id);
  const owners = await db
    .select({
      facetInstallationId: schema.capabilityComponentOwners.facetInstallationId,
      accountId: schema.capabilityComponentOwners.accountId,
      workspaceId: schema.capabilityComponentOwners.workspaceId,
      ownerKind: schema.capabilityComponentOwners.ownerKind,
      ownerId: schema.capabilityComponentOwners.ownerId,
      removable: schema.capabilityComponentOwners.removable,
    })
    .from(schema.capabilityComponentOwners)
    .where(inArray(schema.capabilityComponentOwners.facetInstallationId, oldIds));
  const kindByOldId = new Map(input.oldFacetInstallations.map((row) => [row.id, row.kind]));
  for (const owner of owners) {
    const targetId = targetByKind.get(kindByOldId.get(owner.facetInstallationId) ?? "");
    if (!targetId) continue;
    await db
      .insert(schema.capabilityComponentOwners)
      .values({
        accountId: owner.accountId,
        workspaceId: owner.workspaceId,
        facetInstallationId: targetId,
        ownerKind: owner.ownerKind,
        ownerId: owner.ownerId,
        removable: owner.removable,
      })
      .onConflictDoNothing();
  }
  if (!oldIntegration) return;
  const bindings = await db
    .select({
      binding: schema.integrationFeatureBindings,
      featureKey: schema.integrationFeatureFacets.featureKey,
      featureKind: schema.integrationFeatureFacets.kind,
    })
    .from(schema.integrationFeatureBindings)
    .innerJoin(
      schema.integrationFeatureFacets,
      eq(schema.integrationFeatureFacets.id, schema.integrationFeatureBindings.featureFacetId),
    )
    .where(
      and(
        eq(schema.integrationFeatureBindings.workspaceId, input.workspaceId),
        eq(schema.integrationFeatureBindings.integrationFacetInstallationId, oldIntegration.id),
        or(
          sql`${schema.integrationFeatureBindings.runtimeKey} is null`,
          ne(schema.integrationFeatureBindings.runtimeKey, input.excludedRuntimeKey),
        ),
      ),
    )
    .for("update");
  const available = new Set(input.revision.tools.map((tool) => tool.id));
  for (const row of bindings) {
    const binding = row.binding;
    const targetFeature = input.featureFacets.get(row.featureKey);
    if (!targetFeature || targetFeature.kind !== row.featureKind) {
      throw new Error(`API Integration update would remove configured feature ${row.featureKey}`);
    }
    const config = objectValue(binding.config);
    const toolsConfig = row.featureKind === "tools";
    const selected = toolsConfig
      ? (stringArray(config.allowedTools) ?? []).filter((tool) => available.has(tool))
      : [];
    const requireApproval = toolsConfig
      ? input.revision.tools
          .filter((tool) => selected.includes(tool.id) && tool.approvalMode === "ask")
          .map((tool) => tool.id)
      : [];
    await db
      .update(schema.integrationFeatureBindings)
      .set({
        integrationFacetInstallationId: input.integrationFacetInstallationId,
        featureFacetId: targetFeature.id,
        config: toolsConfig ? { ...config, allowedTools: selected, requireApproval } : config,
        status: toolsConfig && selected.length === 0 ? "needs_attention" : binding.status,
        lastErrorCode:
          toolsConfig && selected.length === 0 ? "selected_tools_removed" : binding.lastErrorCode,
        version: binding.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.integrationFeatureBindings.id, binding.id));
  }
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
  assertConnectionKindMatchesAuth(input.authScheme, connection.kind);
  const missing = normalizedStrings(input.requiredScopes ?? [], 256).filter(
    (scope) => !connection.grantedScopes.includes(scope),
  );
  if (missing.length > 0) {
    throw new Error("API Integration connection is missing required scopes");
  }
  return connection;
}

function assertConnectionKindMatchesAuth(
  authScheme: Record<string, unknown> | undefined,
  connectionKind: string,
): void {
  const auth = objectValue(authScheme);
  const authKind = stringValue(auth.kind);
  if (authKind === undefined || authKind === "none") return;
  if (authKind === "oauth2") {
    if (connectionKind !== "oauth2") {
      throw new Error("API Integration requires an OAuth Connection");
    }
    return;
  }
  if (authKind === "api_key" || authKind === "http") {
    if (connectionKind !== "api_key") {
      throw new Error("API Integration requires a credential Connection, not OAuth");
    }
    return;
  }
  throw new Error("API Integration auth scheme is unsupported");
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
    if (existing.kind !== input.kind)
      throw new Error(`Capability facet ${input.facetKey} changed kind`);
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

type IntegrationInstanceContext = {
  instanceId: string;
  instanceVersion: number;
  displayName: string;
  pluginInstallationId: string;
  installationVersion: number;
};

async function integrationInstanceContext(
  db: Database,
  workspaceId: string,
  capabilityId: string,
  instanceKey: string,
  lock = false,
): Promise<IntegrationInstanceContext | null> {
  let query = db
    .select({
      instanceId: schema.integrationFeatureBindings.id,
      instanceVersion: schema.integrationFeatureBindings.version,
      displayName: schema.integrationFeatureBindings.displayName,
      pluginInstallationId: schema.capabilityPluginInstallations.id,
      installationVersion: schema.capabilityPluginInstallations.version,
    })
    .from(schema.integrationFeatureBindings)
    .innerJoin(
      schema.integrationFeatureFacets,
      eq(schema.integrationFeatureFacets.id, schema.integrationFeatureBindings.featureFacetId),
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
        eq(schema.integrationFeatureFacets.kind, "tools"),
        sql`${schema.capabilityPluginVersions.manifest} ->> 'capabilityId' = ${capabilityId}`,
      ),
    )
    .limit(2);
  if (lock) query = query.for("update") as typeof query;
  const rows = await query;
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error(`API Integration ${capabilityId} instance is ambiguous`);
  return rows[0]!;
}

async function integrationDefinitionHasOtherBindingOwner(
  db: Database,
  input: {
    workspaceId: string;
    pluginInstallationId: string;
    excludedBindingId: string;
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
        ne(schema.integrationFeatureBindingOwners.bindingId, input.excludedBindingId),
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
      eq(
        schema.capabilityFacetInstallations.id,
        schema.capabilityComponentOwners.facetInstallationId,
      ),
    )
    .where(
      and(
        eq(schema.capabilityFacetInstallations.pluginInstallationId, pluginInstallationId),
        sql`(
          ${schema.capabilityComponentOwners.ownerKind} <> 'plugin'
          or exists (
            select 1 from ${schema.capabilityPluginInstallations} owning_plugin
            where owning_plugin.id::text = ${schema.capabilityComponentOwners.ownerId}
              and owning_plugin.status = 'active'
          )
        )`,
      ),
    )
    .orderBy(
      asc(schema.capabilityComponentOwners.ownerKind),
      asc(schema.capabilityComponentOwners.ownerId),
    );
  const owners = new Map<string, ApiIntegrationOwner>();
  for (const row of rows) {
    if (
      row.kind !== "direct" &&
      row.kind !== "plugin" &&
      row.kind !== "pack" &&
      row.kind !== "migration"
    ) {
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
  if (input.revision.protocol !== input.protocol)
    throw new Error("API Integration protocol mismatch");
  if (
    input.revision.contentSha256.length !== 64 ||
    !/^[0-9a-f]+$/.test(input.revision.contentSha256)
  ) {
    throw new Error("API Integration revision digest is invalid");
  }
  if (input.revision.tools.length === 0 || input.revision.tools.length > 2_000) {
    throw new Error("API Integration revision must expose 1-2000 tools");
  }
  if (new Set(input.revision.tools.map((tool) => tool.id)).size !== input.revision.tools.length) {
    throw new Error("API Integration revision has duplicate tool ids");
  }
  const featureDefinitions = input.featureDefinitions ?? [];
  if (featureDefinitions.length > 128) {
    throw new Error("API Integration exposes too many feature definitions");
  }
  if (
    new Set(featureDefinitions.map((feature) => feature.featureKey)).size !==
    featureDefinitions.length
  ) {
    throw new Error("API Integration has duplicate feature keys");
  }
  const base = new URL(input.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.hash) {
    throw new Error("API Integration baseUrl must be a credential-free HTTPS URL");
  }
  if (
    base.hostname !== input.providerDomain &&
    !base.hostname.endsWith(`.${input.providerDomain}`)
  ) {
    throw new Error("API Integration providerDomain does not match baseUrl");
  }
  const authKind = objectValue(input.authScheme).kind;
  if (authKind !== undefined && authKind !== "none" && !input.connectionId) {
    throw new Error("Authenticated API Integrations require a Connection");
  }
}

function selectedToolIds(input: InstallApiIntegrationInput): string[] {
  const available = new Set(input.revision.tools.map((tool) => tool.id));
  const selected =
    input.allowedTools === undefined
      ? [...available]
      : normalizedStrings(input.allowedTools, 2_000);
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
    ? normalizedStrings(
        value.filter((entry): entry is string => typeof entry === "string"),
        2_000,
      )
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
