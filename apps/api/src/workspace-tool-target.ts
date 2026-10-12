import { createHash, randomBytes } from "node:crypto";
import {
  EDITABLE_ARTIFACT_MCP_CODEMODE_PATHS,
  ToolGatewayInvokeResponse,
  ToolGatewayTargetApprovalResponse,
  type ToolGatewayIdentity,
  type ToolGatewayResolveRequest,
  type ToolGatewayInvokeRequest,
  type ToolGatewayTargetApprovalRequest,
  type ToolGatewayResolvedTool,
  type ToolGatewayManifestRequest,
  type ToolGatewayTarget,
} from "@opengeni/contracts";
import {
  type AccessGrantAuthorization,
  type ApiRouteDeps,
  withSiteSessionOrigin,
  siteViewerForGrant,
} from "@opengeni/core";
import {
  beginTargetToolGatewayCall,
  getWorkspaceArtifactContentRef,
  issueToolGatewayApproval,
  ToolGatewayApprovalOperationStartedError,
  ToolGatewayApprovalRateLimitError,
  WorkspaceArtifactNotFoundError,
  type Database,
} from "@opengeni/db";
import {
  digestCanonicalJson,
  digestToolGatewayDefinition,
  projectToolGatewayPath,
  type PreparedToolGatewayCall,
} from "@opengeni/tool-gateway";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "./http/api-error";
import {
  prepareWorkspaceToolGateway,
  requireWorkspaceSiteToolAuthorization,
  requireWorkspaceToolGatewayAuthorization,
  throwWorkspaceToolGatewayHttpError,
  type PreparedWorkspaceToolGateway,
  type WorkspaceSiteVersionResolver,
} from "./workspace-tool-gateway";
import { resolveSiteSessionOrigin } from "./site-session-origin";
import { TargetAuthorityFence, targetFenceCaller } from "./workspace-tool-target-fence";

export type TargetGatewayOptions = {
  signal?: AbortSignal;
  /** The route's fresh human grant; organization keys and external actors use their own reads. */
  reauthorize?: () => Promise<void>;
  prepare?: typeof prepareWorkspaceToolGateway;
  begin?: typeof beginTargetToolGatewayCall;
  issue?: typeof issueToolGatewayApproval;
  authorizeSite?: typeof requireWorkspaceSiteToolAuthorization;
  /** Observes the request's fence (statistics), never its authority. */
  onFence?: (fence: TargetAuthorityFence) => void;
};
const unavailable = () => new HTTPException(404, { message: "tool_unavailable" });
const key = (identity: ToolGatewayIdentity) =>
  JSON.stringify([identity.serverId, identity.toolName]);
const samePath = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((part, index) => part === b[index]);

function projectedPath(identity: ToolGatewayIdentity) {
  const alias =
    identity.serverId === "opengeni"
      ? EDITABLE_ARTIFACT_MCP_CODEMODE_PATHS[
          identity.toolName as keyof typeof EDITABLE_ARTIFACT_MCP_CODEMODE_PATHS
        ]
      : undefined;
  return projectToolGatewayPath({ identity, ...(alias ? { codemodePath: alias } : {}) });
}

/**
 * Reads a pinned Site as the request's caller may see it. Targeted routes admit
 * no attempt-scoped grant (`requireWorkspaceToolGatewayAuthorization`), so whom
 * a caller reads Sites as follows from its grant alone and is resolved once per
 * request. Every read still filters by it, so an audience change applies at
 * the next evaluation.
 */
async function siteVersionReader(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
): Promise<WorkspaceSiteVersionResolver> {
  const viewer = await siteViewerForGrant(deps.db, authorization.grant);
  return async (db, grant, artifactId, versionId) =>
    await getWorkspaceArtifactContentRef(db, grant.workspaceId, viewer, artifactId, versionId);
}

/** Site paths are matched to the stored allowlist before any provider work. */
async function siteTarget(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  request: ToolGatewayResolveRequest,
  options: TargetGatewayOptions,
): Promise<{
  target: ToolGatewayTarget;
  site?: {
    context: { siteArtifactId: string; siteVersionId: string; identity: ToolGatewayIdentity };
    visible: WorkspaceSiteVersionResolver;
  };
}> {
  if (!request.siteArtifactId || !request.siteVersionId) return { target: request.target };
  const visible = await siteVersionReader(deps, authorization);
  let identity: ToolGatewayIdentity;
  if ("identity" in request.target) identity = request.target.identity;
  else {
    try {
      const { status, version } = await visible(
        deps.db,
        authorization.grant,
        request.siteArtifactId,
        request.siteVersionId,
      );
      const path = request.target.path;
      const matches = version.requestedTools.filter((item) => samePath(projectedPath(item), path));
      if (status !== "active" || version.id !== request.siteVersionId || matches.length !== 1)
        throw unavailable();
      identity = matches[0]!;
    } catch {
      throw new HTTPException(403, { message: "site_tool_not_authorized" });
    }
  }
  const context = {
    siteArtifactId: request.siteArtifactId,
    siteVersionId: request.siteVersionId,
    identity,
  };
  await (options.authorizeSite ?? requireWorkspaceSiteToolAuthorization)(
    deps.db,
    authorization.grant,
    context,
    visible,
  );
  return { target: { identity }, site: { context, visible } };
}

/**
 * The request's single live fence. The owner closes it strictly after the
 * awaited preparation cleanup. `targeted` requests must install their route.
 */
export function createTargetFence(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  options: TargetGatewayOptions,
  targeted: boolean,
): TargetAuthorityFence {
  const fence = new TargetAuthorityFence({
    db: deps.db,
    targeted,
    caller: targetFenceCaller(deps, authorization, options.reauthorize),
    signal: options.signal,
  });
  options.onFence?.(fence);
  return fence;
}

function resolvedTool(
  prepared: PreparedWorkspaceToolGateway,
  target: ToolGatewayTarget,
): ToolGatewayResolvedTool {
  const matches = prepared.toolGatewayCatalog.entries.filter((entry) =>
    "identity" in target
      ? key(entry.identity) === key(target.identity)
      : samePath(entry.codemodePath, target.path),
  );
  if (matches.length !== 1) throw unavailable();
  const entry = matches[0]!;
  return {
    version: 1,
    entry,
    definitionDigest: digestToolGatewayDefinition(prepared.toolGatewayCatalog, entry),
  };
}

async function withTarget<T>(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  request: ToolGatewayResolveRequest,
  options: TargetGatewayOptions,
  use: (
    prepared: PreparedWorkspaceToolGateway,
    tool: ToolGatewayResolvedTool,
    fence: TargetAuthorityFence,
  ) => Promise<T>,
): Promise<T> {
  requireWorkspaceToolGatewayAuthorization(authorization);
  options.signal?.throwIfAborted();
  const fence = createTargetFence(deps, authorization, options, true);
  let prepared: PreparedWorkspaceToolGateway | undefined;
  try {
    // Admission: the live caller, then the exact pinned Site entry.
    await fence.admit();
    const { target, site } = await siteTarget(deps, authorization, request, options);
    if (site)
      fence.setSite(async (db) => {
        await (options.authorizeSite ?? requireWorkspaceSiteToolAuthorization)(
          db,
          authorization.grant,
          site.context,
          site.visible,
        );
      });
    let tool: ToolGatewayResolvedTool;
    try {
      // Preparation installs the route part before any provider is built and
      // evaluates the fence once at every physical-request boundary.
      prepared = await (options.prepare ?? prepareWorkspaceToolGateway)(deps, authorization, {
        target,
        firstPartySettings: "caller",
        ...(options.signal ? { signal: options.signal } : {}),
        fence,
      });
      options.signal?.throwIfAborted();
      tool = resolvedTool(prepared, target);
    } catch (error) {
      // A physical boundary that denied (or could not read) authority drops an
      // optional connector silently or fails a required one; report that
      // outcome instead of an opaque missing tool.
      return await fence.settle(error);
    }
    return await use(prepared, tool, fence);
  } finally {
    if (prepared) await closeTargetPreparation(deps, prepared);
    // Strictly after the awaited cleanup (whose session DELETE stays fenced):
    // nothing is authorized once the request scope ends.
    fence.close();
  }
}

async function closeTargetPreparation(deps: ApiRouteDeps, prepared: PreparedWorkspaceToolGateway) {
  try {
    await prepared.close();
  } catch {
    // Cleanup cannot replace a confirmed result or an outcome-unknown receipt.
    // Neither provider exception text nor tool/caller content belongs in logs.
    try {
      deps.observability?.warn("target_tool_cleanup_failed");
    } catch {
      /* Observability is not settlement authority. */
    }
  }
}

export async function resolveWorkspaceToolTarget(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  request: ToolGatewayResolveRequest,
  options: TargetGatewayOptions = {},
) {
  return await withTarget(deps, authorization, request, options, async (_prepared, tool, fence) => {
    // The definition is disclosed only while the complete fence still holds.
    await fence.check({ retryable: true });
    return tool;
  });
}

function assertDefinition(tool: ToolGatewayResolvedTool, expected: string | undefined) {
  if (expected !== undefined && expected !== tool.definitionDigest)
    throw new ApiHttpError(409, {
      code: "conflict",
      message: "The tool definition changed before execution.",
      retryable: true,
      outcomeUnknown: false,
      details: { code: "tool_definition_stale" },
    });
}

function approvalBinding(
  call: PreparedToolGatewayCall,
  request: { siteArtifactId?: string | undefined; siteVersionId?: string | undefined },
) {
  if (!call.effectDigest)
    throw new HTTPException(503, { message: "tool_effect_binding_unavailable" });
  return digestCanonicalJson({
    domain: "opengeni.target-tool-approval",
    version: 2,
    effectDigest: call.effectDigest,
    siteArtifactId: request.siteArtifactId ?? null,
    siteVersionId: request.siteVersionId ?? null,
  });
}
const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");

function approvalError(error: unknown): never {
  if (error instanceof ToolGatewayApprovalOperationStartedError)
    throw new ApiHttpError(409, {
      code: "conflict",
      message:
        "This operation may already have executed. Reconcile its outcome before creating another operation.",
      retryable: false,
      outcomeUnknown: true,
      details: { code: "tool_gateway_operation_already_started" },
    });
  if (error instanceof ToolGatewayApprovalRateLimitError)
    throw new HTTPException(429, { message: "tool_approval_rate_limited" });
  throwWorkspaceToolGatewayHttpError(error);
}

export async function invokeWorkspaceToolTarget(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  request: ToolGatewayInvokeRequest,
  options: TargetGatewayOptions = {},
) {
  return await withTarget(deps, authorization, request, options, async (prepared, tool, fence) => {
    assertDefinition(tool, request.expectedDefinitionDigest);
    const meta: Record<string, unknown> = { approvalConfirmed: true, targetedCall: true };
    let call: PreparedToolGatewayCall;
    try {
      call = await prepared.toolGateway.prepareCall(
        {
          operationId: request.operationId,
          catalogDigest: prepared.toolGatewayCatalog.digest,
          identity: tool.entry.identity,
          arguments: request.arguments,
          caller: { kind: "http", subjectId: authorization.grant.subjectId },
        },
        { transportMeta: meta, ...(options.signal ? { signal: options.signal } : {}) },
      );
      // Caller, Site, route and the decided action policy, before admission.
      await fence.check({ retryable: true });
      const approvalRequired =
        call.approvalDecision === "ask" ||
        (call.approvalDecision === undefined && tool.entry.approval === "human");
      const accepted = await (options.begin ?? beginTargetToolGatewayCall)(deps.db, {
        ...authorization.grant,
        operationId: request.operationId,
        identity: tool.entry.identity,
        targetBindingDigest: approvalBinding(call, request),
        argumentsDigest: digestCanonicalJson(request.arguments),
        approvalAuthorityDigest: call.approvalAuthorityDigest,
        approvalRequired,
        ...(request.approvalToken ? { tokenHash: hashToken(request.approvalToken) } : {}),
      });
      if (!accepted) throw new HTTPException(409, { message: "tool_gateway_approval_required" });
      meta.approvalConfirmed = approvalRequired || request.approvalToken !== undefined;
    } catch (error) {
      approvalError(error);
    }
    const origin =
      request.siteArtifactId && request.siteVersionId
        ? await resolveSiteSessionOrigin(
            deps.db,
            authorization.grant,
            request.siteArtifactId,
            request.siteVersionId,
          )
        : null;
    // The last application-level fence before dispatch. A remote provider
    // request is fenced again at its own physical boundary.
    try {
      await fence.check({ retryable: false });
    } catch (error) {
      throwWorkspaceToolGatewayHttpError(error);
    }
    // Once dispatched, even output validation or cancellation cannot prove nonexecution.
    try {
      const result = await (origin
        ? withSiteSessionOrigin(origin, () => call.execute())
        : call.execute());
      return ToolGatewayInvokeResponse.parse({ operationId: request.operationId, tool, result });
    } catch {
      throw new ApiHttpError(502, {
        code: "upstream_unavailable",
        message: "The tool call ended without a confirmed result. Reconcile before retrying.",
        retryable: false,
        outcomeUnknown: true,
        details: { code: "tool_outcome_unknown" },
      });
    }
  });
}

export async function approveWorkspaceToolTarget(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  request: ToolGatewayTargetApprovalRequest,
  options: TargetGatewayOptions = {},
) {
  return await withTarget(
    deps,
    authorization,
    { ...request, target: { identity: request.identity } },
    options,
    async (prepared, tool, fence) => {
      assertDefinition(tool, request.expectedDefinitionDigest);
      try {
        const call = await prepared.toolGateway.prepareCall(
          {
            operationId: request.operationId,
            catalogDigest: prepared.toolGatewayCatalog.digest,
            identity: tool.entry.identity,
            arguments: request.arguments,
            caller: { kind: "http", subjectId: authorization.grant.subjectId },
          },
          {
            transportMeta: { approvalConfirmed: true },
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        if (
          call.approvalDecision !== "ask" &&
          !(call.approvalDecision === undefined && tool.entry.approval === "human")
        )
          throw new HTTPException(422, { message: "tool_does_not_require_human_approval" });
        await fence.check({ retryable: true });
        const approvalToken = `ogta_${randomBytes(32).toString("base64url")}`;
        const expiresAt = new Date(Date.now() + 5 * 60_000);
        await (options.issue ?? issueToolGatewayApproval)(deps.db, {
          ...authorization.grant,
          bindingVersion: 2,
          targetBindingDigest: approvalBinding(call, request),
          tokenHash: hashToken(approvalToken),
          operationId: request.operationId,
          identity: tool.entry.identity,
          argumentsDigest: digestCanonicalJson(request.arguments),
          approvalAuthorityDigest: call.approvalAuthorityDigest,
          expiresAt,
        });
        return ToolGatewayTargetApprovalResponse.parse({
          bindingVersion: 2,
          operationId: request.operationId,
          tool,
          approvalToken,
          expiresAt: expiresAt.toISOString(),
        });
      } catch (error) {
        approvalError(error);
      }
    },
  );
}

/**
 * Every requested identity must still be on the pinned Site version; with none
 * requested, the version itself must still be the active one. Each evaluation
 * reads the Site once, as the caller may see it, and checks every identity
 * against that read.
 */
function manifestSiteCheck(
  authorization: AccessGrantAuthorization,
  site: { siteArtifactId: string; siteVersionId: string },
  identities: readonly ToolGatewayIdentity[],
  visible: WorkspaceSiteVersionResolver,
  options: TargetGatewayOptions,
) {
  return async (db: Database) => {
    let read: ReturnType<WorkspaceSiteVersionResolver> | undefined;
    const pinned = () =>
      (read ??= visible(db, authorization.grant, site.siteArtifactId, site.siteVersionId));
    if (identities.length === 0) {
      let status: string;
      let versionId: string;
      try {
        const content = await pinned();
        status = content.status;
        versionId = content.version.id;
      } catch (error) {
        if (error instanceof WorkspaceArtifactNotFoundError)
          throw new HTTPException(403, { message: "site_tool_not_authorized" });
        throw error;
      }
      if (status !== "active" || versionId !== site.siteVersionId)
        throw new HTTPException(403, { message: "site_tool_not_authorized" });
    }
    for (const identity of identities)
      await (options.authorizeSite ?? requireWorkspaceSiteToolAuthorization)(
        db,
        authorization.grant,
        { ...site, identity },
        pinned,
      );
  };
}

/** Compatibility discovery is bounded by requested identities, grouped per connector. */
export async function resolveWorkspaceToolManifest(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  request: ToolGatewayManifestRequest,
  options: TargetGatewayOptions = {},
) {
  requireWorkspaceToolGatewayAuthorization(authorization);
  options.signal?.throwIfAborted();
  const identities = [
    ...new Map(request.identities.map((identity) => [key(identity), identity])).values(),
  ];
  const fence = createTargetFence(deps, authorization, options, false);
  let prepared: PreparedWorkspaceToolGateway | undefined;
  try {
    // Admission: the live caller, then the pinned Site entries.
    await fence.admit();
    const { siteArtifactId, siteVersionId } = request;
    if (siteArtifactId && siteVersionId) {
      const authorizeSite = manifestSiteCheck(
        authorization,
        { siteArtifactId, siteVersionId },
        identities,
        await siteVersionReader(deps, authorization),
        options,
      );
      await authorizeSite(deps.db);
      fence.setSite(authorizeSite);
    }
    try {
      prepared = await (options.prepare ?? prepareWorkspaceToolGateway)(deps, authorization, {
        allowedIdentities: identities,
        firstPartySettings: "caller",
        ...(options.signal ? { signal: options.signal } : {}),
        fence,
      });
      options.signal?.throwIfAborted();
      // Definitions are disclosed only while the fence still holds.
      await fence.check({ retryable: true });
      // A requested tool dropped because a boundary denied or could not read
      // authority reports that outcome, never a silently partial manifest.
      const listed = new Set(
        prepared.toolGatewayCatalog.entries.map((entry) => key(entry.identity)),
      );
      if (identities.some((identity) => !listed.has(key(identity)))) {
        const failure = await fence.failure();
        if (failure) throw failure;
      }
    } catch (error) {
      return await fence.settle(error);
    }
    const catalog = prepared.toolGatewayCatalog;
    const tools = catalog.entries.map((entry) => ({
      version: 1 as const,
      entry,
      definitionDigest: digestToolGatewayDefinition(catalog, entry),
    }));
    return {
      version: 1 as const,
      digest: digestCanonicalJson({ domain: "opengeni.tool-manifest", version: 1, tools }),
      tools,
    };
  } finally {
    if (prepared) await closeTargetPreparation(deps, prepared);
    fence.close();
  }
}
