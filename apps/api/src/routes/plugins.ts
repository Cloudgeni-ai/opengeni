import { createHash } from "node:crypto";

import {
  createPinnedIntegrationTransport,
  fetchIntegrationSourceDocument,
  type IntegrationCredentialResolver,
} from "@opengeni/capabilities";
import type { McpServerConfig } from "@opengeni/config";
import {
  InstallPluginRequest,
  InstalledPlugin,
  ListInstalledPluginsResponse,
  PluginManifest,
  PluginPreview,
  PluginUninstallPreview,
  PreviewPluginRequest,
  UninstallPluginRequest,
  UninstallPluginResult,
  stableJson,
  type PluginComponentPreview,
} from "@opengeni/contracts";
import {
  portableSkillCapabilityId,
  portableSkillPluginKey,
  requireAccessGrant,
  resolveSkillImport,
  type ApiRouteDeps,
  type GitHubSkillSourceClient,
} from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  CapabilityComponentVersionConflictError,
  checkpointPluginPackageOperation,
  deferPluginPackageOperation,
  finalizePluginPackageInstall,
  getConnectionMetadata,
  getInstalledPluginPackage,
  getPluginPackageUninstallPreview,
  integrationBindingKey,
  installApiIntegration,
  installPluginMcpReference,
  installPortableSkill,
  listInstalledPluginPackages,
  PluginInstallationVersionConflictError,
  PluginInstallationVersionRequiredError,
  PluginOperationIdempotencyError,
  preparePluginPackageInstall,
  uninstallPluginPackage,
  type ConnectionMetadataWithVerification,
} from "@opengeni/db";
import type { FetchLike } from "@opengeni/network";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  resolveApiIntegrationPreview,
  type ApiIntegrationConnectionDescriptor,
  type ResolvedApiIntegrationPreview,
} from "../integrations/api-integrations";
import { createGitHubSkillSourceClient } from "../integrations/github-skill-source";

const MAX_PLUGIN_MANIFEST_BYTES = 1024 * 1024;

export type PluginRouteOverrides = Readonly<{
  fetchImpl?: FetchLike;
  github?: GitHubSkillSourceClient;
}>;

type ResolvedPluginComponent = {
  preview: PluginComponentPreview;
  install(ownerPluginInstallationId: string): Promise<{
    facetInstallationIds: string[];
    bindingIds?: string[];
  }>;
};

type ResolvedPluginPackage = {
  preview: PluginPreview;
  storedManifest: Record<string, unknown>;
  components: ResolvedPluginComponent[];
};

export function registerPluginRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  overrides: PluginRouteOverrides = {},
): void {
  const github = overrides.github ?? createGitHubSkillSourceClient(deps.settings);
  const transport = createPinnedIntegrationTransport({
    network: deps.settings,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });

  app.get("/v1/workspaces/:workspaceId/plugins", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json(
      ListInstalledPluginsResponse.parse({
        plugins: await listInstalledPluginPackages(deps.db, workspaceId),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/plugins/preview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const payload = PreviewPluginRequest.parse(await c.req.json());
    const resolved = await resolvePluginPackage({
      deps,
      github,
      transport,
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      url: payload.url,
      bindings: payload.bindings,
    });
    return c.json(PluginPreview.parse(resolved.preview));
  });

  app.post("/v1/workspaces/:workspaceId/plugins/install", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = InstallPluginRequest.parse(await c.req.json());
    const resolved = await resolvePluginPackage({
      deps,
      github,
      transport,
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      url: payload.url,
      bindings: payload.bindings,
    });
    if (resolved.preview.manifestDigest !== payload.expectedManifestDigest) {
      throw new HTTPException(409, {
        message: "The Plugin manifest changed after preview. Review the new components.",
      });
    }
    const expected = new Map(
      payload.expectedComponents.map((component) => [component.key, component.digest]),
    );
    if (
      expected.size !== resolved.components.length ||
      resolved.components.some(
        (component) => expected.get(component.preview.key) !== component.preview.digest,
      )
    ) {
      throw new HTTPException(409, {
        message: "A Plugin component changed after preview. Review the updated bill of materials.",
      });
    }
    const requestDigest = sha256(
      stableJson({
        url: payload.url,
        expectedManifestDigest: payload.expectedManifestDigest,
        expectedComponents: [...expected.entries()].sort(),
        bindings: payload.bindings,
        expectedInstallationVersion: payload.expectedInstallationVersion ?? null,
      }),
    );
    let prepared;
    try {
      prepared = await preparePluginPackageInstall(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        pluginKey: resolved.preview.manifest.pluginKey,
        version: resolved.preview.manifest.version,
        name: resolved.preview.manifest.name,
        description: resolved.preview.manifest.description,
        category: resolved.preview.manifest.category,
        tags: resolved.preview.manifest.tags,
        manifestDigest: resolved.preview.manifestDigest,
        manifest: resolved.storedManifest,
        idempotencyKey: payload.idempotencyKey,
        requestDigest,
        ...(payload.expectedInstallationVersion !== undefined
          ? { expectedInstallationVersion: payload.expectedInstallationVersion }
          : {}),
      });
    } catch (error) {
      throw pluginMutationHttpError(error);
    }
    if (prepared.replayResult?.status === "installed") {
      return c.json(InstalledPlugin.parse(prepared.replayResult), 200);
    }
    const retainedFacetInstallationIds: string[] = [];
    const retainedBindingIds: string[] = [];
    const completedKeys: string[] = [];
    let activeComponentKey = "none";
    try {
      for (const component of resolved.components) {
        activeComponentKey = component.preview.key;
        const installed = await component.install(prepared.pluginInstallationId);
        retainedFacetInstallationIds.push(...installed.facetInstallationIds);
        retainedBindingIds.push(...(installed.bindingIds ?? []));
        completedKeys.push(component.preview.key);
        await checkpointPluginPackageOperation(deps.db, {
          workspaceId,
          operationId: prepared.operationId,
          phase: `component:${component.preview.key}`,
          completedKeys,
        });
      }
      const result = InstalledPlugin.parse({
        pluginKey: prepared.pluginKey,
        version: prepared.version,
        pluginId: prepared.pluginId,
        pluginVersionId: prepared.pluginVersionId,
        pluginInstallationId: prepared.pluginInstallationId,
        installationVersion: prepared.installationVersion,
        componentCount: resolved.components.length,
        status: "installed",
      });
      await finalizePluginPackageInstall(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        operationId: prepared.operationId,
        pluginInstallationId: prepared.pluginInstallationId,
        retainedFacetInstallationIds,
        retainedBindingIds,
        result,
      });
      return c.json(result, resolved.preview.installed ? 200 : 201);
    } catch (error) {
      await deferPluginPackageOperation(deps.db, {
        workspaceId,
        operationId: prepared.operationId,
        phase: `component_failed:${activeComponentKey}`,
        errorCode: pluginFailureCode(error),
      }).catch(() => undefined);
      if (error instanceof HTTPException) throw error;
      if (error instanceof CapabilityComponentVersionConflictError) {
        throw new HTTPException(409, {
          message: `Plugin component ${activeComponentKey} is pinned to another version by an installed owner. Update or remove that owner before retrying with the same idempotency key.`,
        });
      }
      throw new HTTPException(422, {
        message: `Plugin component ${activeComponentKey} could not be installed. No Plugin-owned component is active until installation completes; retry with the same idempotency key.`,
      });
    }
  });

  app.get("/v1/workspaces/:workspaceId/plugins/:pluginKey/uninstall-preview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const pluginKey = decodeURIComponent(c.req.param("pluginKey"));
    const preview = await getPluginPackageUninstallPreview(deps.db, workspaceId, pluginKey);
    return c.json(PluginUninstallPreview.parse({ pluginKey, ...preview }));
  });

  app.delete("/v1/workspaces/:workspaceId/plugins/:pluginKey", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const pluginKey = decodeURIComponent(c.req.param("pluginKey"));
    const payload = UninstallPluginRequest.parse(await c.req.json());
    try {
      return c.json(
        UninstallPluginResult.parse({
          pluginKey,
          ...(await uninstallPluginPackage(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            subjectId: grant.subjectId,
            pluginKey,
            expectedInstallationVersion: payload.expectedInstallationVersion,
            idempotencyKey: payload.idempotencyKey,
          })),
        }),
      );
    } catch (error) {
      throw pluginMutationHttpError(error);
    }
  });
}

async function resolvePluginPackage(input: {
  deps: ApiRouteDeps;
  github: GitHubSkillSourceClient;
  transport: ReturnType<typeof createPinnedIntegrationTransport>;
  accountId: string;
  workspaceId: string;
  subjectId: string;
  url: string;
  bindings: Record<
    string,
    {
      connectionId?: string | undefined;
      instanceKey?: string | undefined;
      displayName?: string | undefined;
    }
  >;
}): Promise<ResolvedPluginPackage> {
  let manifest;
  try {
    const bytes = await fetchIntegrationSourceDocument(
      input.transport,
      input.url,
      MAX_PLUGIN_MANIFEST_BYTES,
    );
    manifest = PluginManifest.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(422, {
      message: error instanceof Error ? error.message : "Plugin manifest is invalid",
    });
  }
  const manifestDigest = sha256(stableJson(manifest));
  const components: ResolvedPluginComponent[] = [];
  for (const component of manifest.components) {
    if (component.kind === "skill") {
      const resolved = await resolveSkillImport(component.url, input.github);
      const capabilityId = portableSkillCapabilityId(resolved.preview);
      const digest = sha256(
        stableJson({
          capabilityId,
          sourceCommit: resolved.preview.sourceCommit,
          sourcePath: resolved.preview.sourcePath,
          contentSha256: resolved.preview.contentSha256,
        }),
      );
      components.push({
        preview: {
          key: component.key,
          kind: "skill",
          name: resolved.preview.name,
          capabilityId,
          digest,
          connectionRequired: false,
          connectionId: null,
          instanceKey: null,
          displayName: null,
          facts: {
            sourceCommit: resolved.preview.sourceCommit,
            sourcePath: resolved.preview.sourcePath,
            fileCount: resolved.preview.files.length,
            totalBytes: resolved.preview.totalBytes,
          },
        },
        install: async (ownerPluginInstallationId) => {
          const summaries = new Map(
            resolved.preview.files.map((file) => [file.path, file] as const),
          );
          const installed = await installPortableSkill(input.deps.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            capabilityId,
            pluginKey: portableSkillPluginKey(resolved.preview),
            source: resolved.preview.source,
            sourceUrl: resolved.preview.sourceUrl,
            repositoryUrl: resolved.preview.repositoryUrl,
            sourceCommit: resolved.preview.sourceCommit,
            sourcePath: resolved.preview.sourcePath,
            name: resolved.preview.name,
            description: resolved.preview.description,
            contentSha256: resolved.preview.contentSha256,
            totalBytes: resolved.preview.totalBytes,
            files: resolved.files.map((file) => {
              const summary = summaries.get(file.path)!;
              return { ...file, byteSize: summary.byteSize, contentSha256: summary.contentSha256 };
            }),
            owner: { kind: "plugin", id: ownerPluginInstallationId, removable: true },
          });
          return { facetInstallationIds: [installed.facetInstallationId] };
        },
      });
      continue;
    }
    if (component.kind === "integration") {
      const requestedBinding = input.bindings[component.key];
      const connection = await optionalConnection(
        input.deps,
        input.workspaceId,
        input.subjectId,
        requestedBinding?.connectionId,
      );
      const resolved = await resolveApiIntegrationPreview({
        source: component.source,
        connection: connectionDescriptor(connection),
        transport: input.transport,
        authority: {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          initiatingSubjectId: input.subjectId,
          ...(connection ? { connectionRef: connection.id } : {}),
        },
        ...(connection
          ? {
              credentialResolver: pluginCredentialResolver(
                input.deps,
                input.workspaceId,
                input.subjectId,
                connection,
              ),
            }
          : {}),
      });
      const digest = integrationDigest(resolved);
      const instanceKey = integrationBindingKey(connection?.id, requestedBinding?.instanceKey);
      const displayName =
        requestedBinding?.displayName?.trim() ||
        (instanceKey === "default"
          ? resolved.preview.name
          : `${resolved.preview.name} — connected account`);
      components.push({
        preview: {
          key: component.key,
          kind: "integration",
          name: resolved.preview.name,
          capabilityId: resolved.preview.capabilityId,
          digest,
          connectionRequired: resolved.preview.auth.kind !== "none",
          connectionId: connection?.id ?? null,
          instanceKey,
          displayName,
          facts: {
            protocol: resolved.preview.protocol,
            providerDomain: resolved.preview.providerDomain,
            revisionId: resolved.preview.revisionId,
            contentSha256: resolved.preview.contentSha256,
            toolCount: resolved.preview.tools.length,
          },
        },
        install: async (ownerPluginInstallationId) => {
          if (resolved.preview.auth.kind !== "none" && !connection) {
            throw new HTTPException(422, {
              message: `Plugin component ${component.key} requires a Connection binding`,
            });
          }
          const installed = await installApiIntegration(input.deps.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            capabilityId: resolved.preview.capabilityId,
            pluginKey: resolved.preview.pluginKey,
            serverId: resolved.preview.serverId,
            name: resolved.preview.name,
            description: resolved.preview.description,
            category: "integrations",
            tags: [resolved.preview.protocol, resolved.preview.provider ?? "custom", "plugin"],
            presetId: resolved.preview.presetId,
            ...(resolved.provider ? { provider: resolved.provider } : {}),
            providerDomain: resolved.preview.providerDomain,
            protocol: resolved.preview.protocol,
            baseUrl: resolved.preview.baseUrl,
            sourceUrl: resolved.preview.sourceUrl,
            authScheme: resolved.authScheme,
            ...(connection ? { connectionId: connection.id } : {}),
            instanceKey,
            displayName,
            requiredScopes: resolved.requiredScopes,
            ownership: connection?.subjectId ? "subject" : "workspace",
            revision: resolved.revision,
            owner: { kind: "plugin", id: ownerPluginInstallationId, removable: true },
          });
          return {
            facetInstallationIds: [
              installed.integrationFacetInstallationId,
              installed.apiFacetInstallationId,
            ],
            bindingIds: [installed.instanceId],
          };
        },
      });
      continue;
    }
    const server = configuredMcpServer(input.deps.settings.mcpServers, component.serverId);
    const digest = sha256(stableJson(safeMcpFacts(server)));
    components.push({
      preview: {
        key: component.key,
        kind: "mcp",
        name: server.name ?? server.id,
        capabilityId: `mcp:configured:${server.id}`,
        digest,
        connectionRequired: Boolean(server.connectionRef),
        connectionId: server.connectionRef?.connectionId ?? null,
        instanceKey: null,
        displayName: null,
        facts: {
          serverId: server.id,
          allowedToolCount: server.allowedTools?.length ?? 0,
          approvalRequired:
            server.requireApproval !== false && server.requireApproval !== undefined,
        },
      },
      install: async (ownerPluginInstallationId) => {
        const installed = await installPluginMcpReference(input.deps.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          ownerPluginInstallationId,
          serverId: server.id,
          name: server.name ?? server.id,
          url: server.url,
          allowedTools: server.allowedTools ?? [],
          ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
          cacheToolsList: server.cacheToolsList,
          ...(server.requireApproval !== undefined
            ? { requireApproval: server.requireApproval }
            : {}),
          ...(server.connectionRef
            ? { connectionRef: server.connectionRef as unknown as Record<string, unknown> }
            : {}),
          authKind:
            server.connectionRef?.kind === "oauth2" || server.connectionRef?.kind === "api_key"
              ? server.connectionRef.kind
              : server.connectionRef
                ? "unknown"
                : "none",
          digest,
        });
        return { facetInstallationIds: [installed.facetInstallationId] };
      },
    });
  }
  const installed = await getInstalledPluginPackage(
    input.deps.db,
    input.workspaceId,
    manifest.pluginKey,
  );
  const bom = components.map((component) => ({
    key: component.preview.key,
    kind: component.preview.kind,
    capabilityId: component.preview.capabilityId,
    digest: component.preview.digest,
  }));
  const previousBom = pluginBom(installed?.manifest);
  const diff = pluginDiff(installed?.version ?? null, manifest.version, previousBom, bom);
  return {
    preview: PluginPreview.parse({
      sourceUrl: input.url,
      manifest,
      manifestDigest,
      installed: Boolean(installed && installed.status !== "disabled"),
      installationVersion: installed?.installationVersion ?? null,
      components: components.map((component) => component.preview),
      diff,
    }),
    storedManifest: { ...manifest, sourceUrl: input.url, manifestDigest, bom },
    components,
  };
}

async function optionalConnection(
  deps: ApiRouteDeps,
  workspaceId: string,
  subjectId: string,
  connectionId: string | undefined,
): Promise<ConnectionMetadataWithVerification | null> {
  if (!connectionId) return null;
  const connection = await getConnectionMetadata(deps.db, workspaceId, connectionId, subjectId);
  if (!connection) throw new HTTPException(404, { message: "Plugin Connection was not found" });
  if (connection.status !== "active") {
    throw new HTTPException(422, { message: "Plugin Connection is not active" });
  }
  return connection;
}

function connectionDescriptor(
  connection: ConnectionMetadataWithVerification | null,
): ApiIntegrationConnectionDescriptor | null {
  return connection
    ? {
        id: connection.id,
        kind: connection.kind,
        providerDomain: connection.providerDomain,
        scopes: [...connection.grantedScopes],
        ownership: connection.subjectId ? "personal" : "workspace",
      }
    : null;
}

function pluginCredentialResolver(
  deps: ApiRouteDeps,
  workspaceId: string,
  subjectId: string,
  connection: ConnectionMetadataWithVerification,
): IntegrationCredentialResolver {
  const resolve = buildConnectionTokenResolver(deps.db, deps.settings);
  return {
    resolve: async (request) => {
      const result = await resolve({
        workspaceId,
        ...(connection.subjectId ? { subjectId } : {}),
        serverId: `plugin_preview_${connection.id}`,
        toolName: request.operationKey,
        connectionRef: {
          connectionId: connection.id,
          providerDomain: connection.providerDomain,
          kind: connection.kind,
          ...(connection.grantedScopes.length > 0 ? { scopes: connection.grantedScopes } : {}),
          subjectScope: connection.subjectId ? "subject" : "workspace",
        },
        destinationUrl: request.destinationUrl,
        credentialTarget: "http_api",
        forceRefresh: request.forceRefresh === true,
      });
      if (result.status === "auth_needed") return null;
      const destination = new URL(request.destinationUrl);
      return {
        audience: { origin: destination.origin, pathPrefix: "/" },
        placements:
          result.placements ??
          Object.entries(result.headers).map(([name, value]) => ({
            carrier: "header" as const,
            name,
            value,
          })),
      };
    },
  };
}

function configuredMcpServer(servers: McpServerConfig[], id: string): McpServerConfig {
  const server = servers.find((candidate) => candidate.id === id);
  if (!server) {
    throw new HTTPException(422, {
      message: `Plugin references MCP server ${id}, which is not configured by this deployment`,
    });
  }
  if (server.headers && Object.keys(server.headers).length > 0) {
    throw new HTTPException(422, {
      message: `Plugin MCP reference ${id} cannot copy deployment header credentials`,
    });
  }
  if (server.connectionRef?.subjectScope === "subject") {
    throw new HTTPException(422, {
      message: `Plugin MCP reference ${id} cannot auto-activate a Personal Connection`,
    });
  }
  return server;
}

function safeMcpFacts(server: McpServerConfig): Record<string, unknown> {
  return {
    serverId: server.id,
    name: server.name ?? null,
    url: server.url,
    allowedTools: server.allowedTools ?? [],
    timeoutMs: server.timeoutMs ?? null,
    cacheToolsList: server.cacheToolsList,
    requireApproval: server.requireApproval ?? false,
    connectionRef: server.connectionRef ?? null,
  };
}

function integrationDigest(resolved: ResolvedApiIntegrationPreview): string {
  return sha256(
    stableJson({
      capabilityId: resolved.preview.capabilityId,
      revisionId: resolved.preview.revisionId,
      contentSha256: resolved.preview.contentSha256,
      requiredScopes: resolved.requiredScopes,
    }),
  );
}

function pluginBom(value: unknown): Array<{
  key: string;
  kind: "skill" | "integration" | "mcp";
  capabilityId: string;
  digest: string;
}> {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  if (!Array.isArray(record.bom)) return [];
  return record.bom.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (
      typeof item.key !== "string" ||
      (item.kind !== "skill" && item.kind !== "integration" && item.kind !== "mcp") ||
      typeof item.capabilityId !== "string" ||
      typeof item.digest !== "string"
    ) {
      return [];
    }
    return [
      { key: item.key, kind: item.kind, capabilityId: item.capabilityId, digest: item.digest },
    ];
  });
}

function pluginDiff(
  fromVersion: string | null,
  toVersion: string,
  previous: ReturnType<typeof pluginBom>,
  next: ReturnType<typeof pluginBom>,
) {
  const previousByKey = new Map(previous.map((component) => [component.key, component]));
  const nextByKey = new Map(next.map((component) => [component.key, component]));
  return {
    fromVersion,
    toVersion,
    added: [...nextByKey.keys()].filter((key) => !previousByKey.has(key)).sort(),
    removed: [...previousByKey.keys()].filter((key) => !nextByKey.has(key)).sort(),
    changed: [...nextByKey.entries()]
      .filter(([key, component]) => {
        const before = previousByKey.get(key);
        return Boolean(
          before && (before.kind !== component.kind || before.digest !== component.digest),
        );
      })
      .map(([key]) => key)
      .sort(),
    unchanged: [...nextByKey.entries()]
      .filter(([key, component]) => {
        const before = previousByKey.get(key);
        return Boolean(
          before && before.kind === component.kind && before.digest === component.digest,
        );
      })
      .map(([key]) => key)
      .sort(),
  };
}

function pluginMutationHttpError(error: unknown): HTTPException {
  if (error instanceof PluginOperationIdempotencyError) {
    return new HTTPException(409, { message: "Plugin idempotency key was already used" });
  }
  if (error instanceof PluginInstallationVersionConflictError) {
    return new HTTPException(409, { message: "Plugin installation changed after preview" });
  }
  if (error instanceof PluginInstallationVersionRequiredError) {
    return new HTTPException(400, {
      message: "Updating a Plugin requires the previewed installation version",
    });
  }
  if (error instanceof HTTPException) return error;
  return new HTTPException(422, {
    message: error instanceof Error ? error.message : "Plugin mutation failed",
  });
}

function pluginFailureCode(error: unknown): string {
  if (error instanceof HTTPException) return `http_${error.status}`;
  return "component_install_failed";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
