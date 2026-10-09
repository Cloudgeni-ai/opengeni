import { isVerifiedDelegatedHumanAuthorization, knowledgeContextForGateway } from "@opengeni/core";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withSiteSessionOrigin } from "@opengeni/core";
import { resolveSiteSessionOrigin } from "./site-session-origin";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { recordToolApproval } from "@opengeni/observability";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { IntegrationInvocationError } from "@opengeni/capabilities";
import type { Settings } from "@opengeni/config";
import {
  FIRST_PARTY_MCP_TOOL_NAMES,
  EDITABLE_ARTIFACT_MCP_CODEMODE_PATHS,
  ToolGatewayCallRequest,
  ToolGatewayCallResponse,
  ToolGatewayApprovalRequest,
  ToolGatewayApprovalResponse,
  ToolGatewayDeclarationsResponse,
  toolPolicyActionName,
  type AccessGrant,
  type ToolGatewayCatalog,
  type ToolGatewayIdentity,
  type ToolRef,
  type ToolGatewayTarget,
} from "@opengeni/contracts";
import {
  availableMcpAccountBindings,
  buildApiIntegrationMcpServers,
  expandApiIntegrationAccountRoutes,
  expandMcpAccountRoutes,
  hasPermission,
  externalActorContinuationForAuthorization,
  isVerifiedOrganizationServiceAuthorization,
  externalContinuationCommitAuthorizer,
  requireResolvedAccessGrantAuthorization,
  codexAppsRequestAuthForDesignation,
  resolveCodexAppsDesignationForRun,
  resolveWorkspaceCatalogSettings,
  settingsWithEnabledCapabilityMcpServers,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  buildSlackApiRateLimiter,
  lockActiveExternalOrganizationKeyAuthority,
  withAccountRls,
  requireWorkspace,
  consumeToolGatewayApproval,
  getWorkspaceArtifactContentRef,
  issueToolGatewayApproval,
  ToolGatewayApprovalOperationStartedError,
  ToolGatewayApprovalRateLimitError,
  WorkspaceArtifactNotFoundError,
  listConnectorToolPermissionPolicies,
  projectConnectorToolPermission,
  resolveConnectorActionPolicy,
  connectorActionPolicyDecision,
  type ApiIntegrationRuntime,
} from "@opengeni/db";
import {
  type LocalMcpServerRegistration,
  type PreparedWorkspaceToolGatewayTools,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
  prepareWorkspaceToolGatewayTools,
} from "@opengeni/runtime/workspace-tool-gateway";
import {
  ToolGatewayApprovalRequiredError,
  ToolGatewayBlockedError,
  ToolGatewayCatalogStaleError,
  ToolGatewayInputValidationError,
  ToolGatewayToolNotFoundError,
  digestCanonicalJson,
  generateToolGatewayDeclarations,
  safeNamespaceSegment,
  projectToolGatewayPath,
  type PreparedToolGatewayCall,
  type ToolGatewayDefinition,
} from "@opengeni/tool-gateway";
import { HTTPException } from "hono/http-exception";

import { ApiHttpError } from "./http/api-error";
import { buildDocumentsMcpServer } from "./mcp/documents";
import { buildFilesMcpServer } from "./mcp/files";
import { buildOpenGeniMcpServer } from "./mcp/server";
import { startWorkspaceToolGatewayObservation } from "./workspace-tool-gateway-observability";
import {
  digestWorkspaceToolGatewayCatalogEntry,
  type WorkspaceToolGatewayCatalogAttestations,
} from "./workspace-tool-gateway-attestations";
import type { Observability } from "@opengeni/observability";

export type PreparedWorkspaceToolGateway = Pick<
  PreparedWorkspaceToolGatewayTools,
  "toolGateway" | "toolGatewayCatalog" | "close"
> & {
  toolGateway: NonNullable<PreparedWorkspaceToolGatewayTools["toolGateway"]>;
  toolGatewayCatalog: NonNullable<PreparedWorkspaceToolGatewayTools["toolGatewayCatalog"]>;
  reauthorize?: () => Promise<void>;
};

type WorkspaceSiteToolContext = {
  siteArtifactId: string;
  siteVersionId: string;
  identity: { serverId: string; toolName: string };
};

type AuthorizeWorkspaceSiteTool = (
  db: ApiRouteDeps["db"],
  grant: AccessGrant,
  context: WorkspaceSiteToolContext,
) => Promise<void>;

export function grantUsesAttemptScopedMcp(grant: AccessGrant): boolean {
  return (
    grant.principalKind === "agent_attempt" ||
    grant.metadata?.delegated === true ||
    typeof grant.metadata?.sessionId === "string"
  );
}

export function requireWorkspaceToolGatewayGrant(grant: AccessGrant): void {
  if (
    grantUsesAttemptScopedMcp(grant) ||
    (grant.principalKind !== undefined && grant.principalKind !== "human_session")
  ) {
    throw new HTTPException(403, { message: "current-human tool access required" });
  }
}

export function requireWorkspaceToolGatewayAuthorization(
  authorization: AccessGrantAuthorization,
): AccessGrant {
  const grant = requireResolvedAccessGrantAuthorization(
    authorization,
    authorization.grant.workspaceId,
  );
  if (isVerifiedOrganizationServiceAuthorization(authorization)) {
    if (grantUsesAttemptScopedMcp(grant))
      throw new HTTPException(403, {
        message: "service tool access cannot carry attempt authority",
      });
    return grant;
  }
  requireWorkspaceToolGatewayGrant(grant);
  if (
    !authorization.canonicalManagedHumanSession &&
    !authorization.canonicalLocalHumanSession &&
    !isVerifiedDelegatedHumanAuthorization(authorization) &&
    !externalActorContinuationForAuthorization(authorization)
  ) {
    throw new HTTPException(403, { message: "current-human tool access required" });
  }
  return grant;
}

export async function prepareWorkspaceToolGateway(
  routeDeps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  options: {
    /**
     * Prepare only these exact (account-qualified) identities. Servers outside
     * them are never constructed, credentialed, connected, or listed; the
     * resulting catalog and digest describe only this subset.
     */
    allowedIdentities?: readonly ToolGatewayIdentity[];
  } & WorkspaceToolGatewayPreparationOptions = {},
): Promise<PreparedWorkspaceToolGateway> {
  const grant = requireWorkspaceToolGatewayAuthorization(authorization);
  const external = externalActorContinuationForAuthorization(authorization);
  const reauthorizeExternal = externalContinuationCommitAuthorizer(authorization);
  const service = isVerifiedOrganizationServiceAuthorization(authorization);
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
  };
  const permissions = [...grant.permissions];
  const reauthorize =
    external || service
      ? async () => {
          await withAccountRls(routeDeps.db, scope.accountId, async (tx) => {
            if (reauthorizeExternal) await reauthorizeExternal(tx);
            else {
              const live = await lockActiveExternalOrganizationKeyAuthority(
                tx,
                scope.accountId,
                scope.subjectId.slice("api_key:".length),
                scope.workspaceId,
              );
              const workspace = await requireWorkspace(tx, scope.workspaceId);
              if (
                !live ||
                permissions.some(
                  (permission) => !hasPermission(live.permissions, permission, live.permissionMode),
                ) ||
                workspace.accountId !== scope.accountId ||
                workspace.kind !== "shared"
              )
                throw new HTTPException(403, { message: "service gateway authority changed" });
            }
          });
        }
      : undefined;
  const reauthorizeCaller = async () => {
    options.signal?.throwIfAborted();
    await options.reauthorize?.();
    await reauthorize?.();
  };
  await reauthorizeCaller();
  const prepared = await prepareWorkspaceToolGatewayForGrantInternal(
    routeDeps,
    grant,
    options.allowedIdentities,
    reauthorizeCaller,
    options,
  );
  try {
    await reauthorizeCaller();
  } catch (error) {
    await prepared.close();
    throw error;
  }
  return {
    ...prepared,
    reauthorize: async () => {
      await reauthorizeCaller();
      await prepared.reauthorize?.();
    },
  };
}

/**
 * Bounded caller scope for catalog attestations. It binds the exact caller,
 * actor class, and permission set; attestations still grant no authority.
 */
export function workspaceToolGatewayAttestationScope(
  authorization: AccessGrantAuthorization,
): string {
  const grant = authorization.grant;
  const external = externalActorContinuationForAuthorization(authorization);
  return digestCanonicalJson({
    version: 1,
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    principalKind: grant.principalKind ?? null,
    permissions: [...new Set(grant.permissions)].sort(),
    actor: isVerifiedOrganizationServiceAuthorization(authorization)
      ? "service"
      : external
        ? { external: digestCanonicalJson(external) }
        : "human",
  });
}

export type WorkspaceToolGatewayPreparationScope = "complete" | "target";
export type WorkspaceToolGatewayAttestationOutcome = "hit" | "miss" | "mismatch" | "bypass";

export type WorkspaceToolGatewayTiming = {
  /** Wall time spent preparing gateways (all preparations, including fallback). */
  prepareMs: number;
  /** Wall time from the last successful preparation to the response. */
  callMs: number;
  scope: WorkspaceToolGatewayPreparationScope;
  attestation: WorkspaceToolGatewayAttestationOutcome;
};

/** Prepare one complete current-caller catalog and remember its content-free attestation. */
export async function prepareAttestedWorkspaceToolGateway(
  routeDeps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  attestations: WorkspaceToolGatewayCatalogAttestations | undefined,
  prepare: typeof prepareWorkspaceToolGateway = prepareWorkspaceToolGateway,
): Promise<PreparedWorkspaceToolGateway> {
  const prepared = await prepare(routeDeps, authorization);
  attestations?.record(
    workspaceToolGatewayAttestationScope(authorization),
    prepared.toolGatewayCatalog,
  );
  return prepared;
}

/**
 * HTTP/SDK/Site call adapter. When the caller's `catalogDigest` names a
 * complete catalog this process prepared for the same caller scope, only the
 * target identity's connector is prepared live and its entry must match the
 * attested entry exactly. Every other case (approval capability, unknown or
 * expired digest, missing/changed entry) prepares the complete catalog and
 * applies the unchanged stale-catalog contract.
 */
export async function callWorkspaceToolGatewayForCaller(
  routeDeps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  request: ToolGatewayCallRequest,
  options: {
    attestations?: WorkspaceToolGatewayCatalogAttestations;
    observability?: Observability;
    /** Must enforce current-caller gateway authorization before provider work. */
    prepare?: typeof prepareWorkspaceToolGateway;
    authorizeSiteTool?: AuthorizeWorkspaceSiteTool;
    resolveOrigin?: typeof resolveSiteSessionOrigin;
    /** Called once with the preparation split, whether the call succeeds or fails. */
    onPreparation?: (
      preparation: Pick<WorkspaceToolGatewayTiming, "prepareMs" | "scope" | "attestation">,
    ) => void;
  } = {},
): Promise<{ response: ToolGatewayCallResponse; timing: WorkspaceToolGatewayTiming }> {
  // `prepare` (prepareWorkspaceToolGateway in production) rejects any caller
  // without live current-caller gateway authority before provider work. The
  // attestation lookup below grants nothing and reveals nothing to a caller
  // that preparation then rejects.
  const grant = authorization.grant;
  const prepare = options.prepare ?? prepareWorkspaceToolGateway;
  const callGateway = (
    prepared: PreparedWorkspaceToolGateway,
    callRequest: ToolGatewayCallRequest,
  ) =>
    callWorkspaceToolGateway(
      prepared,
      grant,
      callRequest,
      routeDeps.db,
      undefined,
      options.observability,
      options.authorizeSiteTool,
      options.resolveOrigin,
    );
  const scope = workspaceToolGatewayAttestationScope(authorization);
  let prepareMs = 0;
  const timedPrepare = async (allowedIdentities?: readonly ToolGatewayIdentity[]) => {
    const startedAt = performance.now();
    try {
      return await prepare(
        routeDeps,
        authorization,
        // A target-only call must behave exactly like the complete call: only
        // provider construction narrows, never the settings first-party tools see.
        allowedIdentities ? { allowedIdentities, firstPartySettings: "caller" } : {},
      );
    } finally {
      prepareMs += performance.now() - startedAt;
    }
  };
  const attestedEntry =
    request.approvalToken === undefined
      ? options.attestations?.entryDigest(scope, request.catalogDigest, request.identity)
      : undefined;
  let attestation: WorkspaceToolGatewayAttestationOutcome =
    request.approvalToken !== undefined || !options.attestations
      ? "bypass"
      : attestedEntry
        ? "hit"
        : "miss";
  let preparedScope: WorkspaceToolGatewayPreparationScope = "complete";
  try {
    if (attestedEntry) {
      preparedScope = "target";
      const target = await timedPrepare([request.identity]);
      try {
        const entry = target.toolGatewayCatalog.entries.find(
          (candidate) =>
            candidate.identity.serverId === request.identity.serverId &&
            candidate.identity.toolName === request.identity.toolName,
        );
        if (entry && digestWorkspaceToolGatewayCatalogEntry(entry) === attestedEntry) {
          const callStartedAt = performance.now();
          // The target-only gateway verifies its own digest; the caller's
          // complete digest was verified through the exact attested entry.
          const response = await callGateway(target, {
            ...request,
            catalogDigest: target.toolGatewayCatalog.digest,
          });
          return {
            response: ToolGatewayCallResponse.parse({
              ...response,
              catalogDigest: request.catalogDigest,
            }),
            timing: {
              prepareMs,
              callMs: performance.now() - callStartedAt,
              scope: "target",
              attestation,
            },
          };
        }
        attestation = "mismatch";
        preparedScope = "complete";
      } finally {
        await target.close();
      }
    }
    const prepared = await timedPrepare();
    try {
      options.attestations?.record(scope, prepared.toolGatewayCatalog);
      const callStartedAt = performance.now();
      const response = await callGateway(prepared, request);
      return {
        response,
        timing: {
          prepareMs,
          callMs: performance.now() - callStartedAt,
          scope: "complete",
          attestation,
        },
      };
    } finally {
      await prepared.close();
    }
  } finally {
    try {
      options.onPreparation?.({ prepareMs, scope: preparedScope, attestation });
    } catch {
      // Telemetry must never change gateway execution truth.
    }
  }
}

/** Content-free Server-Timing for gateway preparation versus execution. */
export function workspaceToolGatewayServerTiming(timing: {
  prepareMs: number;
  callMs?: number;
  scope: WorkspaceToolGatewayPreparationScope;
  attestation?: WorkspaceToolGatewayAttestationOutcome;
}): string {
  const prepare = `gw-prepare;dur=${timing.prepareMs.toFixed(1)};desc="${timing.scope}${
    timing.attestation ? `/${timing.attestation}` : ""
  }"`;
  return timing.callMs === undefined
    ? prepare
    : `${prepare}, gw-call;dur=${timing.callMs.toFixed(1)}`;
}

export async function prepareMcpOAuthWorkspaceToolGateway(
  routeDeps: ApiRouteDeps,
  grant: AccessGrant,
  allowedIdentities: readonly { serverId: string; toolName: string }[],
): Promise<PreparedWorkspaceToolGateway> {
  if (grant.metadata?.mcpOAuth !== true || grant.principalKind !== "human_session") {
    throw new HTTPException(403, { message: "MCP OAuth authority is invalid" });
  }
  return await prepareWorkspaceToolGatewayForGrant(routeDeps, grant, allowedIdentities);
}

export async function prepareWorkspaceToolGatewayForGrant(
  routeDeps: ApiRouteDeps,
  grant: AccessGrant,
  allowedIdentities?: readonly { serverId: string; toolName: string }[],
  options: WorkspaceToolGatewayPreparationOptions = {},
): Promise<PreparedWorkspaceToolGateway> {
  return await prepareWorkspaceToolGatewayForGrantInternal(
    routeDeps,
    grant,
    allowedIdentities,
    undefined,
    options,
  );
}

export type WorkspaceToolGatewayPreparationOptions = {
  target?: ToolGatewayTarget;
  signal?: AbortSignal;
  /** Trusted transport callback, never a request-body field. */
  reauthorize?: () => Promise<void>;
  /**
   * Settings visible to first-party (opengeni/files/docs) tool handlers.
   * `prepared` (default, MCP OAuth): the identity-narrowed server set.
   * `caller`: the complete caller-authorized set, so a target-only call
   * executes exactly as it would from the complete gateway.
   */
  firstPartySettings?: "prepared" | "caller";
};

/** Keep live caller authority independent of native connection acquisition and refresh. */
export function withWorkspaceConnectionAuthorization(
  resolve: ReturnType<typeof buildConnectionTokenResolver>,
  reauthorize?: () => Promise<void>,
): ReturnType<typeof buildConnectionTokenResolver> {
  if (!reauthorize) return resolve;
  return async (input) => {
    await reauthorize();
    const result = await resolve(input);
    await reauthorize();
    if (result.status !== "ok") return result;
    return {
      ...result,
      authorizeProviderRequest: async () => {
        try {
          await reauthorize();
          return result.authorizeProviderRequest ? await result.authorizeProviderRequest() : true;
        } catch {
          return false;
        }
      },
    };
  };
}

async function prepareWorkspaceToolGatewayForGrantInternal(
  routeDeps: ApiRouteDeps,
  grant: AccessGrant,
  allowedIdentities?: readonly { serverId: string; toolName: string }[],
  reauthorize?: () => Promise<void>,
  options: WorkspaceToolGatewayPreparationOptions = {},
): Promise<PreparedWorkspaceToolGateway> {
  const catalogSourceSettings = routeDeps.catalogSourceSettings ?? routeDeps.settings;
  // Remote tools do not consume the model catalog. First-party handlers keep
  // the complete caller model/settings context (not a narrowed provider view).
  const targetNamespace =
    options.target &&
    ("identity" in options.target ? options.target.identity.serverId : options.target.path[0]);
  const needsModelContext =
    !targetNamespace || ["opengeni", "docs", "files", "artifacts"].includes(targetNamespace);
  const resolvedCatalog = needsModelContext
    ? await resolveWorkspaceCatalogSettings(routeDeps.db, catalogSourceSettings, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
      })
    : { settings: catalogSourceSettings };
  let integrations: readonly ApiIntegrationRuntime[] = [];
  // One designation read serves the catalog overlay and the Apps request
  // authentication below (every Apps request is rechecked by the database).
  let codexAppsDesignationRead: ReturnType<typeof resolveCodexAppsDesignationForRun> | null = null;
  const codexAppsDesignationForGrant = () =>
    (codexAppsDesignationRead ??= resolveCodexAppsDesignationForRun(
      routeDeps.db,
      grant.workspaceId,
      { accountId: grant.accountId },
    ));
  const settings = await settingsWithEnabledCapabilityMcpServers(
    routeDeps.db,
    grant.workspaceId,
    resolvedCatalog.settings,
    {
      subjectId: grant.subjectId,
      onResolvedApiIntegrations: (resolved) => {
        integrations = resolved;
      },
      ...(resolvedCatalog.settings.codexConnectedAppsEnabled
        ? { codexApps: codexAppsDesignationForGrant() }
        : {}),
    },
  );
  // Transport admission has already verified the current caller. A service
  // receives workspace accounts only; human transports use their exact subject.
  const accountBindings = await availableMcpAccountBindings({
    db: routeDeps.db,
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    settings,
    tools: allGatewayToolRefs(settings),
    source:
      grant.principalKind === "service" || grant.principalKind === "api_key"
        ? { kind: "none" }
        : { kind: "subject", accountId: grant.accountId, subjectId: grant.subjectId },
  });
  const accountRoutes = expandMcpAccountRoutes({
    settings,
    tools: allGatewayToolRefs(settings),
    bindings: accountBindings,
  });
  const callerSettings = workspaceToolGatewaySettingsForGrant(accountRoutes.settings, grant);
  const targetServerId = options.target
    ? workspaceToolGatewayTargetServer(callerSettings, options.target)
    : undefined;
  if (options.target && "identity" in options.target) allowedIdentities = [options.target.identity];
  // OAuth/Site identities are account-qualified. Intersect only after expansion;
  // canonical connector IDs are never aliases for an account's execution route.
  const gatewaySettings = workspaceToolGatewaySettingsForGrant(
    targetServerId
      ? {
          ...accountRoutes.settings,
          mcpServers: accountRoutes.settings.mcpServers.filter(
            (server) => server.id === targetServerId,
          ),
        }
      : accountRoutes.settings,
    grant,
    allowedIdentities,
  );
  const gatewayServerIds = new Set(gatewaySettings.mcpServers.map((server) => server.id));
  // Metadata only. Never construct/list another provider to recheck a target.
  const authorizeTargetMetadata = options.target
    ? async () => {
        await reauthorize?.();
        let currentIntegrations: readonly ApiIntegrationRuntime[] = [];
        const currentSettings = await settingsWithEnabledCapabilityMcpServers(
          routeDeps.db,
          grant.workspaceId,
          resolvedCatalog.settings,
          {
            subjectId: grant.subjectId,
            onResolvedApiIntegrations: (items) => {
              currentIntegrations = items;
            },
          },
        );
        const currentBindings = await availableMcpAccountBindings({
          db: routeDeps.db,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          settings: currentSettings,
          tools: allGatewayToolRefs(currentSettings),
          source:
            grant.principalKind === "service" || grant.principalKind === "api_key"
              ? { kind: "none" }
              : { kind: "subject", accountId: grant.accountId, subjectId: grant.subjectId },
        });
        const currentRoutes = expandMcpAccountRoutes({
          settings: currentSettings,
          tools: allGatewayToolRefs(currentSettings),
          bindings: currentBindings,
        });
        const current = workspaceToolGatewaySettingsForGrant(
          currentRoutes.settings,
          grant,
        ).mcpServers.filter((server) => gatewayServerIds.has(server.id));
        const integrationSnapshot = (
          items: readonly ApiIntegrationRuntime[],
          bindings: typeof accountBindings,
        ) =>
          expandApiIntegrationAccountRoutes({
            integrations: items,
            bindings,
            tools: allGatewayToolRefs(gatewaySettings),
          });
        if (
          digestCanonicalJson(current) !== digestCanonicalJson(gatewaySettings.mcpServers) ||
          digestCanonicalJson(integrationSnapshot(currentIntegrations, currentBindings)) !==
            digestCanonicalJson(integrationSnapshot(integrations, accountBindings))
        )
          throw new HTTPException(403, { message: "tool_access_changed" });
        options.signal?.throwIfAborted();
      }
    : undefined;
  const firstPartySettings =
    options.firstPartySettings === "caller" && (allowedIdentities || options.target)
      ? callerSettings
      : gatewaySettings;
  const deps = { ...routeDeps, catalogSourceSettings, settings: firstPartySettings };
  const nativeResolveConnection = buildConnectionTokenResolver(routeDeps.db, gatewaySettings);
  const resolveConnection = withWorkspaceConnectionAuthorization(
    options.target
      ? async (input) => {
          const result = await nativeResolveConnection(input);
          if (result.status !== "ok") return result;
          return {
            ...result,
            authorizeProviderRequest: async () => {
              await reauthorize?.();
              if (result.authorizeProviderRequest && !(await result.authorizeProviderRequest()))
                return false;
              const live = await nativeResolveConnection({
                ...input,
                forceRefresh: false,
                credentialResolutionMode: "preflight",
              });
              return (
                live.status === "ok" &&
                live.connectionId === result.connectionId &&
                live.connectionVersion === result.connectionVersion &&
                (!live.authorizeProviderRequest || (await live.authorizeProviderRequest()))
              );
            },
          };
        }
      : nativeResolveConnection,
    authorizeTargetMetadata ?? reauthorize,
  );
  const resolveCredential = async (
    input: ResolveConnectionCredentialInput,
  ): Promise<ResolveConnectionCredentialResult> =>
    await resolveConnection({
      ...input,
      ...(input.connectionRef.subjectScope === "subject" ? { subjectId: grant.subjectId } : {}),
    });
  const firstPartyServers = await Promise.all([
    ...(gatewayServerIds.has("opengeni")
      ? [inMemoryMcpRegistration("opengeni", buildOpenGeniMcpServer(deps, grant))]
      : []),
    ...(gatewayServerIds.has("files")
      ? [inMemoryMcpRegistration("files", buildFilesMcpServer(deps, grant))]
      : []),
    ...(gatewayServerIds.has("docs") && hasPermission(grant.permissions, "documents:search")
      ? [
          inMemoryMcpRegistration(
            "docs",
            buildDocumentsMcpServer(
              routeDeps.db,
              grant.accountId,
              grant.workspaceId,
              routeDeps.getDocumentServices(),
              {
                knowledge: await knowledgeContextForGateway(routeDeps, grant),
                settings: firstPartySettings,
              },
            ),
          ),
        ]
      : []),
  ]);
  const apiIntegrationServers = buildApiIntegrationMcpServers({
    settings: gatewaySettings,
    integrations: expandApiIntegrationAccountRoutes({
      integrations,
      bindings: accountBindings,
      tools: allGatewayToolRefs(gatewaySettings),
    }),
    authority: {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initiatingSubjectId: grant.subjectId,
    },
    resolveCredential: async (input) =>
      await resolveConnection({
        ...input,
        ...(input.connectionRef.subjectScope === "subject" ? { subjectId: grant.subjectId } : {}),
      }),
  });
  // Legacy designation without a Codex cutover row; the core designation
  // (rechecked by the database on every request) with an enabled cutover;
  // none with a disabled cutover.
  const codexAppsDesignation = gatewayServerIds.has("codex_apps")
    ? await codexAppsDesignationForGrant()
    : null;
  const codexAppsAuth = codexAppsDesignation
    ? codexAppsRequestAuthForDesignation(
        routeDeps.db,
        settings,
        grant.workspaceId,
        codexAppsDesignation,
      )
    : undefined;
  const localMcpServers = [...firstPartyServers, ...apiIntegrationServers];
  const policyTargets = new Map(
    gatewaySettings.mcpServers.map((config) => {
      const binding = accountBindings.find((candidate) => candidate.serverId === config.id);
      return [
        config.id,
        {
          connectionId:
            binding?.connectionId ??
            config.connectionRef?.connectionId ??
            `session-mcp:${config.id}:${createHash("sha256").update(config.url, "utf8").digest("hex")}`,
          serverId: binding?.canonicalServerId ?? config.id,
        },
      ] as const;
    }),
  );
  const policiesByServer = new Map(
    await Promise.all(
      [...policyTargets].map(
        async ([id, target]) =>
          [
            id,
            await listConnectorToolPermissionPolicies(routeDeps.db, {
              ...grant,
              connectionId: target.connectionId,
            }),
          ] as const,
      ),
    ),
  );
  const recommendations = new Map<string, "allow" | "ask">();
  const prepared = await prepareWorkspaceToolGatewayTools(
    gatewaySettings,
    allGatewayToolRefs(gatewaySettings),
    {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      ...(options.signal ? { requestSignal: options.signal } : {}),
      ...(authorizeTargetMetadata ? { authorizeProviderRequest: authorizeTargetMetadata } : {}),
      credentialSubjectId: grant.subjectId,
      mcpAccountLabels: accountRoutes.accountLabels,
      resolveCredential,
      slackRateLimit: buildSlackApiRateLimiter(routeDeps.db, gatewaySettings),
      localMcpServers,
      ...(codexAppsAuth ? { codexAppsAuth } : {}),
      workspaceToolGateway: {
        mapDefinition: (definition) => {
          const recommendation = definition.approval === "human" ? "ask" : "allow";
          recommendations.set(workspaceToolGatewayIdentityKey(definition.identity), recommendation);
          const target = policyTargets.get(definition.identity.serverId);
          if (!target) return definition;
          const permission = projectConnectorToolPermission(
            policiesByServer.get(definition.identity.serverId) ?? [],
            {
              ...target,
              toolName: definition.identity.toolName,
              defaultDecision: recommendation,
            },
          );
          // A transport without a verified approval round trip omits any tool
          // which could ask. Its execution still resolves the exact arguments.
          return { ...definition, approval: permission.approvalRequired ? "human" : "policy" };
        },
        resolveApproval: async ({ call, entry }) => {
          const defaultDecision =
            recommendations.get(workspaceToolGatewayIdentityKey(entry.identity)) ??
            (entry.approval === "human" ? "ask" : "allow");
          const target = policyTargets.get(entry.identity.serverId);
          if (!target) return defaultDecision;
          const policies = await listConnectorToolPermissionPolicies(routeDeps.db, {
            ...grant,
            connectionId: target.connectionId,
          });
          const resolved = resolveConnectorActionPolicy(policies, {
            ...target,
            toolName: entry.identity.toolName,
            defaultDecision,
            actionName: toolPolicyActionName(
              entry.identity.toolName,
              entry.inputSchema,
              call.arguments,
            ),
          });
          const decision = !resolved.managed
            ? defaultDecision
            : connectorActionPolicyDecision(resolved);
          recordToolApproval(decision, resolved.managed ? resolved.source : "default");
          return decision;
        },
        filterDefinition: (definition) => {
          if (!workspaceToolGatewayDefinitionFilter(gatewaySettings, allowedIdentities)(definition))
            return false;
          const target = options.target;
          if (!target || "identity" in target) return true;
          const path = projectToolGatewayPath(definition);
          return (
            path.length === target.path.length &&
            path.every((part, index) => part === target.path[index])
          );
        },
      },
    },
  );
  if (!prepared.toolGateway || !prepared.toolGatewayCatalog) {
    await prepared.close().catch(() => undefined);
    throw new Error("workspace tool gateway preparation did not produce a gateway");
  }
  if (options.signal?.aborted) {
    await prepared.close();
    options.signal.throwIfAborted();
  }
  return {
    toolGateway: prepared.toolGateway,
    toolGatewayCatalog: prepared.toolGatewayCatalog,
    close: prepared.close,
    ...(authorizeTargetMetadata ? { reauthorize: authorizeTargetMetadata } : {}),
  };
}

/** Select one authorized connector without constructing any provider. */
export function workspaceToolGatewayTargetServer(
  settings: Pick<Settings, "mcpServers">,
  target: ToolGatewayTarget,
): string {
  if ("identity" in target) {
    if (settings.mcpServers.some((server) => server.id === target.identity.serverId))
      return target.identity.serverId;
  } else {
    const candidates = new Set(
      settings.mcpServers
        .filter((server) => safeNamespaceSegment(server.id) === target.path[0])
        .map((server) => server.id),
    );
    if (
      Object.values(EDITABLE_ARTIFACT_MCP_CODEMODE_PATHS).some(
        (path) =>
          path.length === target.path.length &&
          path.every((part, index) => part === target.path[index]),
      ) &&
      settings.mcpServers.some((server) => server.id === "opengeni")
    )
      candidates.add("opengeni");
    if (candidates.size === 1) return [...candidates][0]!;
  }
  throw new HTTPException(404, { message: "tool_unavailable" });
}

export function workspaceToolGatewayDefinitionFilter(
  settings: Pick<Settings, "allowedFirstPartyMcpTools">,
  allowedIdentities?: readonly ToolGatewayIdentity[],
): (definition: ToolGatewayDefinition) => boolean {
  const allowedFirstPartyTools: ReadonlySet<string> = new Set(
    settings.allowedFirstPartyMcpTools ?? FIRST_PARTY_MCP_TOOL_NAMES,
  );
  const frozenIdentityKeys = allowedIdentities
    ? new Set(allowedIdentities.map(workspaceToolGatewayIdentityKey))
    : null;
  return (definition) => {
    if (
      definition.identity.serverId === "opengeni" &&
      !allowedFirstPartyTools.has(definition.identity.toolName)
    ) {
      return false;
    }
    if (
      definition.approval === "human" &&
      definition.requiresProviderPreflight === true &&
      !definition.preflightCall
    ) {
      return false;
    }
    return frozenIdentityKeys?.has(workspaceToolGatewayIdentityKey(definition.identity)) ?? true;
  };
}

function workspaceToolGatewayIdentityKey(identity: ToolGatewayIdentity): string {
  return JSON.stringify([identity.serverId, identity.toolName]);
}

export function workspaceToolGatewaySettingsForGrant(
  settings: Settings,
  grant: AccessGrant,
  allowedIdentities?: readonly { serverId: string; toolName: string }[],
): Settings {
  const allowedServerIds = allowedIdentities
    ? new Set(allowedIdentities.map((identity) => identity.serverId))
    : null;
  return {
    ...settings,
    mcpServers: settings.mcpServers.filter((server) => {
      if (allowedServerIds && !allowedServerIds.has(server.id)) return false;
      if (server.id === "docs" && !hasPermission(grant.permissions, "documents:search")) {
        return false;
      }
      if (server.id === "files" && !hasPermission(grant.permissions, "files:read")) return false;
      return true;
    }),
  };
}

export function buildWorkspaceToolGatewayMcpServer(
  prepared: PreparedWorkspaceToolGateway,
  grant: AccessGrant,
  observability?: Observability,
): Server {
  const callableEntries = prepared.toolGatewayCatalog.entries.filter(
    (entry) => entry.approval !== "human",
  );
  const server = new Server(
    { name: "opengeni-tool-gateway", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await prepared.reauthorize?.();
    return {
      tools: callableEntries.map((entry) => ({
        name: entry.modelName,
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        inputSchema: entry.inputSchema,
        ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
        ...(entry.annotations ? { annotations: entry.annotations } : {}),
        ...(entry.icons ? { icons: entry.icons } : {}),
        _meta: {
          "opengeni/identity": entry.identity,
          "opengeni/path": entry.codemodePath,
          "opengeni/source": entry.source,
          "opengeni/approval": entry.approval,
          "opengeni/catalogDigest": prepared.toolGatewayCatalog.digest,
        },
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const entry = callableEntries.find((candidate) => candidate.modelName === request.params.name);
    if (!entry) throw new ToolGatewayToolNotFoundError();
    const observation = startWorkspaceToolGatewayObservation(observability, {
      adapter: "mcp",
      operation: "call",
      source: entry.source,
    });
    try {
      await prepared.reauthorize?.();
      const call = await prepared.toolGateway.prepareCall(
        {
          operationId: crypto.randomUUID(),
          catalogDigest: prepared.toolGatewayCatalog.digest,
          identity: entry.identity,
          arguments: request.params.arguments ?? {},
          caller: { kind: "mcp", subjectId: grant.subjectId },
        },
        { signal: extra.signal },
      );
      await prepared.reauthorize?.();
      const result = (await call.execute()) as CallToolResult;
      observation.end(result.isError ? "tool_error" : "ok");
      return result;
    } catch (error) {
      observation.end(workspaceToolGatewayOutcome(error));
      throw error;
    }
  });
  return server;
}

export async function callWorkspaceToolGateway(
  prepared: PreparedWorkspaceToolGateway,
  grant: AccessGrant,
  input: unknown,
  db?: ApiRouteDeps["db"],
  consumeApproval: typeof consumeToolGatewayApproval = consumeToolGatewayApproval,
  observability?: Observability,
  authorizeSiteTool: AuthorizeWorkspaceSiteTool = requireWorkspaceSiteToolAuthorization,
  resolveOrigin: typeof resolveSiteSessionOrigin = resolveSiteSessionOrigin,
) {
  const request = ToolGatewayCallRequest.parse(input);
  const operationId = request.operationId ?? crypto.randomUUID();
  const entry = prepared.toolGatewayCatalog.entries.find(
    (candidate) =>
      candidate.identity.serverId === request.identity.serverId &&
      candidate.identity.toolName === request.identity.toolName,
  );
  const observation = startWorkspaceToolGatewayObservation(observability, {
    adapter: "http",
    operation: "call",
    source: entry?.source ?? "aggregate",
  });
  try {
    const siteContext =
      request.siteArtifactId && request.siteVersionId
        ? {
            siteArtifactId: request.siteArtifactId,
            siteVersionId: request.siteVersionId,
            identity: request.identity,
          }
        : null;
    await prepared.reauthorize?.();
    if (siteContext) {
      if (!db) throw new HTTPException(503, { message: "site_tool_authorization_unavailable" });
      await authorizeSiteTool(db, grant, siteContext);
    }
    // Approval is adapter-owned. Prepare provisionally so provider preflight can
    // run, then require the ordinary single-use capability before execution.
    const transportMeta: Record<string, unknown> = { approvalConfirmed: true };
    const preparedCall = await prepared.toolGateway.prepareCall(
      {
        operationId,
        catalogDigest: request.catalogDigest,
        identity: request.identity,
        arguments: request.arguments,
        caller: { kind: "http", subjectId: grant.subjectId },
      },
      { transportMeta },
    );
    await prepared.reauthorize?.();
    let approvalConfirmed = false;
    const approvalRequired =
      preparedCall.approvalDecision === "ask" ||
      (preparedCall.approvalDecision === undefined && preparedCall.entry.approval === "human");
    if (approvalRequired && request.approvalToken && db) {
      approvalConfirmed = await consumeApproval(db, {
        tokenHash: hashOpaqueValue(request.approvalToken),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        operationId,
        catalogDigest: request.catalogDigest,
        identity: request.identity,
        argumentsDigest: digestCanonicalJson(request.arguments),
        approvalAuthorityDigest: preparedCall.approvalAuthorityDigest,
      });
    }
    if (approvalRequired && !approvalConfirmed) {
      throw new HTTPException(409, { message: "tool_gateway_approval_required" });
    }
    transportMeta.approvalConfirmed = approvalConfirmed;
    const origin =
      siteContext && db
        ? await resolveOrigin(
            db,
            grant.workspaceId,
            siteContext.siteArtifactId,
            siteContext.siteVersionId,
          )
        : null;
    await prepared.reauthorize?.();
    const result = await (origin
      ? withSiteSessionOrigin(origin, () => preparedCall.execute())
      : preparedCall.execute());
    observation.end(result.isError ? "tool_error" : "ok");
    return ToolGatewayCallResponse.parse({
      operationId,
      catalogDigest: prepared.toolGatewayCatalog.digest,
      result,
    });
  } catch (error) {
    observation.end(workspaceToolGatewayOutcome(error));
    throwWorkspaceToolGatewayHttpError(error);
  }
}

export async function approveWorkspaceToolGatewayCall(
  prepared: PreparedWorkspaceToolGateway,
  grant: AccessGrant,
  db: ApiRouteDeps["db"],
  input: unknown,
  issueApproval: typeof issueToolGatewayApproval = issueToolGatewayApproval,
  observability?: Observability,
) {
  const request = ToolGatewayApprovalRequest.parse(input);
  let preparedCall: PreparedToolGatewayCall;
  try {
    await prepared.reauthorize?.();
    preparedCall = await prepared.toolGateway.prepareCall(
      {
        operationId: request.operationId,
        catalogDigest: request.catalogDigest,
        identity: request.identity,
        arguments: request.arguments,
        caller: { kind: "http", subjectId: grant.subjectId },
      },
      { transportMeta: { approvalConfirmed: true } },
    );
  } catch (error) {
    throwWorkspaceToolGatewayHttpError(error);
  }
  if (
    preparedCall.approvalDecision !== "ask" &&
    !(preparedCall.approvalDecision === undefined && preparedCall.entry.approval === "human")
  ) {
    throw new HTTPException(422, { message: "tool_does_not_require_human_approval" });
  }
  const observation = startWorkspaceToolGatewayObservation(observability, {
    adapter: "http",
    operation: "approval",
    source: preparedCall.entry.source,
  });
  const approvalToken = `ogta_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  try {
    await prepared.reauthorize?.();
    await issueApproval(db, {
      tokenHash: hashOpaqueValue(approvalToken),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      operationId: request.operationId,
      catalogDigest: request.catalogDigest,
      identity: request.identity,
      argumentsDigest: digestCanonicalJson(request.arguments),
      approvalAuthorityDigest: preparedCall.approvalAuthorityDigest,
      expiresAt,
    });
  } catch (error) {
    if (error instanceof ToolGatewayApprovalRateLimitError) {
      observation.end("rate_limited");
      throw new HTTPException(429, { message: "tool_approval_rate_limited", cause: error });
    }
    if (error instanceof ToolGatewayApprovalOperationStartedError) {
      observation.end("failed");
      throw new ApiHttpError(409, {
        code: "conflict",
        message:
          "This tool operation may already have started and cannot be approved again. Reconcile its outcome before creating a new operation.",
        retryable: false,
        outcomeUnknown: true,
        details: {
          code: "tool_gateway_operation_already_started",
          operationId: request.operationId,
        },
      });
    }
    observation.end("failed");
    throw error;
  }
  observation.end("ok");
  return ToolGatewayApprovalResponse.parse({
    operationId: request.operationId,
    catalogDigest: request.catalogDigest,
    identity: preparedCall.entry.identity,
    approvalToken,
    expiresAt: expiresAt.toISOString(),
  });
}

function catalogStaleHttpError(): ApiHttpError {
  return new ApiHttpError(409, {
    code: "conflict",
    message: "The workspace tool catalog changed; retry with the current catalog.",
    retryable: true,
    details: { code: "catalog_stale" },
  });
}

export function throwWorkspaceToolGatewayHttpError(error: unknown): never {
  if (error instanceof ToolGatewayCatalogStaleError) {
    throw catalogStaleHttpError();
  }
  if (error instanceof ToolGatewayToolNotFoundError) {
    throw new HTTPException(404, { message: error.code, cause: error });
  }
  if (error instanceof ToolGatewayInputValidationError) {
    // The same value-free summary the model sees: which properties are missing
    // or mistyped, never the submitted argument values.
    throw new ApiHttpError(422, {
      code: "validation_failed",
      message: error.message,
      retryable: false,
      details: {
        code: error.code,
        issues: error.issues,
        omittedIssueCount: error.omittedIssueCount,
      },
    });
  }
  if (error instanceof ToolGatewayApprovalRequiredError) {
    throw new HTTPException(409, { message: error.code, cause: error });
  }
  if (error instanceof ToolGatewayBlockedError) {
    throw new HTTPException(403, { message: error.code, cause: error });
  }
  if (error instanceof IntegrationInvocationError && error.outcome === "unknown") {
    throw new ApiHttpError(502, {
      code: "upstream_unavailable",
      message:
        "The integration call ended without a confirmed provider result. Inspect the external system before retrying.",
      retryable: false,
      outcomeUnknown: true,
      details: { code: "tool_outcome_unknown", providerCode: error.code },
    });
  }
  throw error;
}

export async function requireWorkspaceSiteToolAuthorization(
  db: ApiRouteDeps["db"],
  grant: AccessGrant,
  context: WorkspaceSiteToolContext,
  resolveVersion = getWorkspaceArtifactContentRef,
): Promise<void> {
  try {
    const { status, version } = await resolveVersion(
      db,
      grant.workspaceId,
      context.siteArtifactId,
      context.siteVersionId,
    );
    const requested = version.requestedTools.some(
      (identity) =>
        identity.serverId === context.identity.serverId &&
        identity.toolName === context.identity.toolName,
    );
    if (status !== "active" || version.id !== context.siteVersionId || !requested) {
      throw new HTTPException(403, { message: "site_tool_not_authorized" });
    }
  } catch (error) {
    if (error instanceof WorkspaceArtifactNotFoundError) {
      throw new HTTPException(403, { message: "site_tool_not_authorized" });
    }
    throw error;
  }
}

function hashOpaqueValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function workspaceToolGatewayOutcome(error: unknown) {
  if (error instanceof ToolGatewayApprovalRequiredError) return "approval_required" as const;
  if (error instanceof ToolGatewayCatalogStaleError) return "catalog_stale" as const;
  if (error instanceof ToolGatewayInputValidationError) return "invalid_input" as const;
  if (error instanceof ToolGatewayToolNotFoundError) return "not_found" as const;
  return "failed" as const;
}

function allGatewayToolRefs(settings: Settings): ToolRef[] {
  return settings.mcpServers.map((server) => ({
    kind: "mcp" as const,
    id: server.id,
    ...(server.connectionRef ? { optional: true } : {}),
  }));
}

async function inMemoryMcpRegistration(
  id: string,
  server: McpServer,
): Promise<LocalMcpServerRegistration> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `opengeni-tool-gateway-${id}`, version: "1.0.0" });
  let connected = false;
  let closed = false;
  type RuntimeMcpServer = LocalMcpServerRegistration["server"];
  type RuntimeMcpTools = Awaited<ReturnType<RuntimeMcpServer["listTools"]>>;
  type RuntimeMcpCallResult = Awaited<ReturnType<NonNullable<RuntimeMcpServer["callToolResult"]>>>;
  return {
    id,
    server: {
      name: `opengeni-tool-gateway-local:${id}`,
      cacheToolsList: false,
      connect: async () => {
        if (closed) throw new Error(`Local MCP server ${id} is closed`);
        if (connected) return;
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        connected = true;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await Promise.allSettled([client.close(), server.close()]);
      },
      listTools: async () => (await client.listTools()).tools as unknown as RuntimeMcpTools,
      callTool: async (toolName, args, _meta, options) =>
        (
          (await client.callTool(
            { name: toolName, arguments: args ?? {} },
            undefined,
            options?.signal ? { signal: options.signal } : undefined,
          )) as CallToolResult
        ).content,
      callToolResult: async (toolName, args, _meta, options) =>
        (await client.callTool(
          { name: toolName, arguments: args ?? {} },
          undefined,
          options?.signal ? { signal: options.signal } : undefined,
        )) as unknown as RuntimeMcpCallResult,
      invalidateToolsCache: async () => undefined,
    },
  };
}

export function toolGatewayCatalogResponse(catalog: ToolGatewayCatalog): ToolGatewayCatalog {
  return catalog;
}

export function workspaceToolGatewayDeclarations(
  prepared: PreparedWorkspaceToolGateway,
): ToolGatewayDeclarationsResponse {
  const moduleSpecifier = "@opengeni/sdk";
  return ToolGatewayDeclarationsResponse.parse({
    catalogDigest: prepared.toolGatewayCatalog.digest,
    moduleSpecifier,
    source: generateToolGatewayDeclarations(prepared.toolGatewayCatalog, { moduleSpecifier }),
  });
}
