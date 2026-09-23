import {
  CORE_INTEGRATION_DEFINITIONS,
  INTEGRATION_DEFINITION_PRESENTATIONS,
  createPinnedIntegrationTransport,
  integrationFacetDefinitions,
  type IntegrationCredentialResolver,
} from "@opengeni/capabilities";
import {
  ApiIntegrationPreview,
  OrganizationIntegrationDeniedError,
  ListIntegrationDefinitionsResponse,
  ApiIntegrationUninstallPreview,
  InstallApiIntegrationRequest,
  InstalledApiIntegration,
  ListApiIntegrationsResponse,
  PreviewApiIntegrationRequest,
  UninstallApiIntegrationRequest,
  UninstallApiIntegrationResult,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  requireAccessGrant,
  integrationSourceForOrganizationPolicy,
  type ApiRouteDeps,
} from "@opengeni/core";
import { withOrganizationIntegrationPolicyFence } from "@opengeni/db/organization-integration-policy";
import {
  ApiIntegrationInstallationVersionConflictError,
  buildConnectionTokenResolver,
  getApiIntegrationUninstallPreview,
  getConnectionMetadata,
  getApiIntegrationReconciliationSnapshot,
  installApiIntegration,
  IntegrationFacetBindingOwnershipConflictError,
  IntegrationFacetBindingVersionConflictError,
  IntegrationFacetBindingVersionRequiredError,
  listInstalledApiIntegrations,
  uninstallApiIntegration,
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

export type ApiIntegrationRouteOverrides = Readonly<{ fetchImpl?: FetchLike }>;

export function apiIntegrationRequiresConnection(authScheme: Record<string, unknown>): boolean {
  const authKind = authScheme.kind;
  return typeof authKind === "string" && authKind !== "none";
}

/** Shared native/embedded install validation. The caller must still authorize
 * capabilities:manage and commit under its own live-authority boundary. */
export function validatedIntegrationInstallInput(
  grant: AccessGrant,
  workspaceId: string,
  payload: InstallApiIntegrationRequest,
  resolved: ResolvedApiIntegrationPreview,
): Parameters<typeof installApiIntegration>[1] {
  if (
    resolved.preview.revisionId !== payload.expectedRevisionId ||
    resolved.preview.contentSha256 !== payload.expectedContentSha256
  ) {
    throw new HTTPException(409, {
      message:
        "The Integration source changed after preview. Review the new tools and permissions before installing.",
    });
  }
  if (resolved.preview.auth.kind !== "none" && !payload.connectionId)
    throw new HTTPException(422, {
      message: "Connect an account before installing this Integration.",
    });
  if (
    payload.ownership &&
    resolved.preview.connectionOwnership &&
    payload.ownership !== resolved.preview.connectionOwnership
  )
    throw new HTTPException(422, {
      message: "The selected Connection ownership does not match this install request.",
    });
  if (payload.ownership === "personal" && !resolved.preview.connectionOwnership)
    throw new HTTPException(422, {
      message: "Choose a Personal Connection before installing for yourself.",
    });
  return {
    accountId: grant.accountId,
    workspaceId,
    subjectId: grant.subjectId,
    capabilityId: resolved.preview.capabilityId,
    pluginKey: resolved.preview.pluginKey,
    serverId: resolved.preview.serverId,
    name: resolved.preview.name,
    description: resolved.preview.description,
    category: "integrations",
    tags: [resolved.preview.protocol, resolved.preview.provider ?? "custom"],
    definitionId: resolved.preview.definitionId,
    definitionProvenance: resolved.preview.definitionProvenance,
    ...(resolved.provider ? { provider: resolved.provider } : {}),
    providerDomain: resolved.preview.providerDomain,
    protocol: resolved.preview.protocol,
    baseUrl: resolved.preview.baseUrl,
    sourceUrl: resolved.preview.sourceUrl,
    authScheme: resolved.authScheme,
    ...(payload.connectionId ? { connectionId: payload.connectionId } : {}),
    ...(payload.instanceKey ? { instanceKey: payload.instanceKey } : {}),
    ...(payload.displayName ? { displayName: payload.displayName } : {}),
    ...(payload.expectedInstanceVersion !== undefined
      ? { expectedInstanceVersion: payload.expectedInstanceVersion }
      : {}),
    requiredScopes: resolved.requiredScopes,
    ownership: resolved.preview.connectionOwnership === "personal" ? "subject" : "workspace",
    ...(payload.allowedTools ? { allowedTools: payload.allowedTools } : {}),
    facetDefinitions: integrationFacetDefinitions(resolved.preview.definitionId),
    revision: resolved.revision,
  };
}

export function registerApiIntegrationRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  overrides: ApiIntegrationRouteOverrides = {},
): void {
  const transport = createPinnedIntegrationTransport({
    network: deps.settings,
    ...((overrides.fetchImpl ?? deps.apiIntegrationSourceFetch)
      ? { fetchImpl: overrides.fetchImpl ?? deps.apiIntegrationSourceFetch! }
      : {}),
  });

  app.get("/v1/workspaces/:workspaceId/integrations/definitions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json(
      ListIntegrationDefinitionsResponse.parse({
        definitions: CORE_INTEGRATION_DEFINITIONS.map((definition) => ({
          id: definition.id,
          name: definition.name,
          summary: definition.summary,
          protocol: definition.protocol,
          provider: { ...definition.provider },
          authentication: {
            kind: definition.authentication.kind,
            scopes: [...definition.authentication.scopes],
          },
          ...(INTEGRATION_DEFINITION_PRESENTATIONS[definition.id]
            ? { presentation: INTEGRATION_DEFINITION_PRESENTATIONS[definition.id] }
            : {}),
          facets: definition.facets.map((facet) => ({
            facetKey: facet.facetKey,
            kind: facet.kind,
            configSchema: { ...facet.configSchema },
            capabilities: { ...facet.capabilities },
          })),
        })),
      }),
    );
  });

  app.get("/v1/workspaces/:workspaceId/integrations", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const integrations = await listInstalledApiIntegrations(deps.db, workspaceId, grant.subjectId);
    return c.json(
      ListApiIntegrationsResponse.parse({
        integrations: integrations.map((integration) => {
          return {
            capabilityId: integration.capabilityId,
            pluginKey: integration.pluginKey,
            installationVersion: integration.installationVersion,
            instanceId: integration.instanceId,
            instanceKey: integration.instanceKey,
            displayName: integration.displayName,
            instanceVersion: integration.instanceVersion,
            serverId: integration.serverId,
            name: integration.name,
            description: integration.description,
            protocol: integration.protocol,
            definitionId: integration.definitionId,
            definitionProvenance: integration.definitionProvenance,
            providerDomain: integration.providerDomain,
            baseUrl: integration.baseUrl,
            sourceUrl: integration.sourceUrl,
            connected: integration.connectionRef !== null,
            requiresConnection: apiIntegrationRequiresConnection(integration.authScheme),
            connectionId: integration.connectionRef?.connectionId ?? null,
            ownership:
              integration.connectionRef?.subjectScope === "subject"
                ? "personal"
                : integration.connectionRef
                  ? "workspace"
                  : "none",
            allowedTools: integration.allowedTools,
            toolCount: integration.allowedTools.length,
            approvalRequiredToolCount:
              integration.requireApproval === true
                ? integration.allowedTools.length
                : integration.requireApproval.length,
            revisionId: integration.revision.id,
            contentSha256: integration.revision.contentSha256,
          };
        }),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/integrations/preview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const payload = PreviewApiIntegrationRequest.parse(await c.req.json());
    const resolved = await resolveForRoute({
      deps,
      transport,
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      payload,
    });
    return c.json(ApiIntegrationPreview.parse(resolved.preview));
  });

  app.post("/v1/workspaces/:workspaceId/integrations/install", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "capabilities:manage");
    const payload = InstallApiIntegrationRequest.parse(await c.req.json());
    const resolved = await resolveForRoute({
      deps,
      transport,
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      payload,
    });
    const installation = validatedIntegrationInstallInput(grant, workspaceId, payload, resolved);
    try {
      return c.json(
        InstalledApiIntegration.parse(await installApiIntegration(deps.db, installation)),
        payload.expectedInstanceVersion === undefined ? 201 : 200,
      );
    } catch (error) {
      if (
        error instanceof IntegrationFacetBindingVersionConflictError ||
        error instanceof IntegrationFacetBindingVersionRequiredError ||
        error instanceof IntegrationFacetBindingOwnershipConflictError
      ) {
        throw new HTTPException(409, {
          message:
            "The Integration instance changed or is shared by another owner. Refresh its details before updating it.",
        });
      }
      throw error;
    }
  });

  app.get(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/uninstall-preview",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
      return c.json(
        ApiIntegrationUninstallPreview.parse(
          await getApiIntegrationUninstallPreview(
            deps.db,
            workspaceId,
            grant.subjectId,
            decodeURIComponent(c.req.param("capabilityId")),
            decodeURIComponent(c.req.param("instanceKey")),
          ),
        ),
      );
    },
  );

  app.delete(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "capabilities:manage");
      const capabilityId = decodeURIComponent(c.req.param("capabilityId"));
      const instanceKey = decodeURIComponent(c.req.param("instanceKey"));
      const payload = UninstallApiIntegrationRequest.parse(await c.req.json());
      try {
        return c.json(
          UninstallApiIntegrationResult.parse(
            await uninstallApiIntegration(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              subjectId: grant.subjectId,
              capabilityId,
              instanceKey,
              expectedInstallationVersion: payload.expectedInstallationVersion,
              expectedInstanceVersion: payload.expectedInstanceVersion,
            }),
          ),
        );
      } catch (error) {
        if (
          error instanceof ApiIntegrationInstallationVersionConflictError ||
          error instanceof IntegrationFacetBindingVersionConflictError
        ) {
          throw new HTTPException(409, {
            message:
              "The Integration instance changed after preview. Review uninstall impact again.",
          });
        }
        throw error;
      }
    },
  );
}

export async function resolveForRoute(input: {
  deps: ApiRouteDeps;
  transport: ReturnType<typeof createPinnedIntegrationTransport>;
  accountId: string;
  workspaceId: string;
  subjectId: string;
  payload: PreviewApiIntegrationRequest | InstallApiIntegrationRequest;
}): ReturnType<typeof resolveApiIntegrationPreview> {
  const payload = structuredClone(input.payload);
  const preparation = await withOrganizationIntegrationPolicyFence(
    input.deps.db,
    input,
    async (tx, policy) => {
      try {
        return { source: integrationSourceForOrganizationPolicy(policy, payload.source) };
      } catch (error) {
        if (!(error instanceof OrganizationIntegrationDeniedError)) throw error;
        const install = InstallApiIntegrationRequest.safeParse(payload);
        if (install.success) {
          const resolved = await storedReconciliationPreview(
            { ...input, deps: { ...input.deps, db: tx } },
            install.data,
          );
          if (resolved) return { resolved };
        }
        throw error;
      }
    },
  );
  if (preparation.resolved) return preparation.resolved;
  const source = preparation.source!;
  try {
    const connection = payload.connectionId
      ? await requireVisibleConnection(
          input.deps,
          input.workspaceId,
          input.subjectId,
          payload.connectionId,
        )
      : null;
    return await resolveApiIntegrationPreview({
      source,
      connection: connectionDescriptor(connection),
      transport: input.transport,
      authority: {
        accountId: connection?.accountId ?? "preview",
        workspaceId: input.workspaceId,
        initiatingSubjectId: input.subjectId,
        ...(connection ? { connectionRef: connection.id } : {}),
      },
      ...(connection
        ? {
            credentialResolver: previewCredentialResolver(
              input.deps,
              input.workspaceId,
              input.subjectId,
              connection,
            ),
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(422, {
      message:
        error instanceof Error
          ? error.message
          : "The Integration source could not be detected safely",
    });
  }
}

async function storedReconciliationPreview(
  input: { deps: ApiRouteDeps; accountId: string; workspaceId: string; subjectId: string },
  payload: InstallApiIntegrationRequest,
): Promise<ResolvedApiIntegrationPreview | null> {
  const snapshot = await getApiIntegrationReconciliationSnapshot(input.deps.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    source: payload.source,
    expectedRevisionId: payload.expectedRevisionId,
    expectedContentSha256: payload.expectedContentSha256,
    ...(payload.connectionId !== undefined ? { connectionId: payload.connectionId } : {}),
    ...(payload.instanceKey !== undefined ? { instanceKey: payload.instanceKey } : {}),
    ...(payload.allowedTools !== undefined ? { allowedTools: payload.allowedTools } : {}),
  });
  if (!snapshot) return null;
  const { runtime, baseServerId, name, provider, requiredScopes } = snapshot;
  const connection = payload.connectionId
    ? await requireVisibleConnection(
        input.deps,
        input.workspaceId,
        input.subjectId,
        payload.connectionId,
      )
    : null;
  const scheme = runtime.authScheme;
  const auth = !apiIntegrationRequiresConnection(scheme)
    ? { kind: "none" }
    : scheme.kind === "oauth2"
      ? { kind: "oauth2", providerDomain: runtime.providerDomain, scopes: requiredScopes }
      : scheme.kind === "api_key"
        ? {
            kind: "api_key",
            providerDomain: runtime.providerDomain,
            carrier: scheme.carrier,
            name: scheme.name,
          }
        : scheme.kind === "http"
          ? { kind: "http", providerDomain: runtime.providerDomain, scheme: scheme.scheme }
          : null;
  if (!auth) return null;
  return {
    preview: ApiIntegrationPreview.parse({
      source: payload.source,
      definitionId: runtime.definitionId,
      definitionProvenance: runtime.definitionProvenance,
      protocol: runtime.protocol,
      capabilityId: runtime.capabilityId,
      pluginKey: runtime.pluginKey,
      serverId: baseServerId,
      name,
      description: runtime.description,
      provider,
      providerDomain: runtime.providerDomain,
      baseUrl: runtime.baseUrl,
      sourceUrl: runtime.sourceUrl,
      revisionId: runtime.revision.id,
      contentSha256: runtime.revision.contentSha256,
      auth,
      connectionId: connection?.id ?? null,
      connectionOwnership: connection ? (connection.subjectId ? "personal" : "workspace") : null,
      tools: runtime.revision.tools.map((tool) => ({
        id: tool.id,
        operationKey: tool.operationKey,
        name: tool.name,
        description: tool.description,
        safety: tool.safety,
        approvalMode: tool.approvalMode,
        deprecated: tool.deprecated,
      })),
      warnings: [],
    }),
    revision: runtime.revision,
    provider,
    requiredScopes,
    authScheme: runtime.authScheme,
  };
}

async function requireVisibleConnection(
  deps: ApiRouteDeps,
  workspaceId: string,
  subjectId: string,
  connectionId: string,
): Promise<ConnectionMetadataWithVerification> {
  const connection = await getConnectionMetadata(deps.db, workspaceId, connectionId, subjectId);
  if (!connection) throw new HTTPException(404, { message: "connection not found" });
  if (connection.status !== "active") {
    throw new HTTPException(422, { message: "connection is not active" });
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

function previewCredentialResolver(
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
        serverId: `preview_${connection.id}`,
        toolName: request.operationKey,
        connectionRef: {
          connectionId: connection.id,
          providerDomain: connection.providerDomain,
          kind: connection.kind,
          ...(connection.grantedScopes.length > 0 ? { scopes: [...connection.grantedScopes] } : {}),
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
        ...(result.expiresAt ? { expiresAt: result.expiresAt.toISOString() } : {}),
      };
    },
  };
}
