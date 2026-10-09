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
} from "@opengeni/core";
import {
  beginTargetToolGatewayCall,
  getWorkspaceArtifactContentRef,
  issueToolGatewayApproval,
  ToolGatewayApprovalOperationStartedError,
  ToolGatewayApprovalRateLimitError,
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
} from "./workspace-tool-gateway";
import { resolveSiteSessionOrigin } from "./site-session-origin";

export type TargetGatewayOptions = {
  signal?: AbortSignal;
  reauthorize?: () => Promise<void>;
  prepare?: typeof prepareWorkspaceToolGateway;
  begin?: typeof beginTargetToolGatewayCall;
  issue?: typeof issueToolGatewayApproval;
  authorizeSite?: typeof requireWorkspaceSiteToolAuthorization;
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

/** Site paths are matched to the stored allowlist before any provider work. */
async function siteTarget(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  request: ToolGatewayResolveRequest,
  options: TargetGatewayOptions,
): Promise<ToolGatewayTarget> {
  if (!request.siteArtifactId || !request.siteVersionId) return request.target;
  let identity: ToolGatewayIdentity;
  if ("identity" in request.target) identity = request.target.identity;
  else {
    try {
      const { status, version } = await getWorkspaceArtifactContentRef(
        deps.db,
        authorization.grant.workspaceId,
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
  await (options.authorizeSite ?? requireWorkspaceSiteToolAuthorization)(
    deps.db,
    authorization.grant,
    { siteArtifactId: request.siteArtifactId, siteVersionId: request.siteVersionId, identity },
  );
  return { identity };
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
    reauthorize: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  requireWorkspaceToolGatewayAuthorization(authorization);
  options.signal?.throwIfAborted();
  await options.reauthorize?.();
  const target = await siteTarget(deps, authorization, request, options);
  // Preparation installs this exact callback at credential/physical request
  // boundaries. A later outer check cannot fence an awaited native preflight.
  const authorizeTarget = async () => {
    options.signal?.throwIfAborted();
    await options.reauthorize?.();
    if (request.siteArtifactId && request.siteVersionId && "identity" in target)
      await (options.authorizeSite ?? requireWorkspaceSiteToolAuthorization)(
        deps.db,
        authorization.grant,
        {
          siteArtifactId: request.siteArtifactId,
          siteVersionId: request.siteVersionId,
          identity: target.identity,
        },
      );
    options.signal?.throwIfAborted();
  };
  const prepared = await (options.prepare ?? prepareWorkspaceToolGateway)(deps, authorization, {
    target,
    firstPartySettings: "caller",
    ...(options.signal ? { signal: options.signal } : {}),
    reauthorize: authorizeTarget,
  });
  try {
    options.signal?.throwIfAborted();
    const tool = resolvedTool(prepared, target);
    const reauthorize = async () => {
      await prepared.reauthorize?.();
      await authorizeTarget();
    };
    await reauthorize();
    return await use(prepared, tool, reauthorize);
  } finally {
    await closeTargetPreparation(deps, prepared);
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
  return await withTarget(deps, authorization, request, options, async (_prepared, tool) => tool);
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
  return await withTarget(
    deps,
    authorization,
    request,
    options,
    async (prepared, tool, reauthorize) => {
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
        await reauthorize();
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
              authorization.grant.workspaceId,
              request.siteArtifactId,
              request.siteVersionId,
            )
          : null;
      await reauthorize();
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
    },
  );
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
    async (prepared, tool, reauthorize) => {
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
        await reauthorize();
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

/** Compatibility discovery is bounded by requested identities, grouped per connector. */
export async function resolveWorkspaceToolManifest(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  request: ToolGatewayManifestRequest,
  options: TargetGatewayOptions = {},
) {
  requireWorkspaceToolGatewayAuthorization(authorization);
  options.signal?.throwIfAborted();
  await options.reauthorize?.();
  const identities = [
    ...new Map(request.identities.map((identity) => [key(identity), identity])).values(),
  ];
  const authorizeManifest = async () => {
    options.signal?.throwIfAborted();
    await options.reauthorize?.();
    if (identities.length === 0 && request.siteArtifactId && request.siteVersionId) {
      try {
        const { status, version } = await getWorkspaceArtifactContentRef(
          deps.db,
          authorization.grant.workspaceId,
          request.siteArtifactId,
          request.siteVersionId,
        );
        if (status !== "active" || version.id !== request.siteVersionId) throw unavailable();
      } catch {
        throw new HTTPException(403, { message: "site_tool_not_authorized" });
      }
    }
    for (const identity of identities)
      await siteTarget(deps, authorization, { ...request, target: { identity } }, options);
    options.signal?.throwIfAborted();
  };
  await authorizeManifest();
  const prepared = await (options.prepare ?? prepareWorkspaceToolGateway)(deps, authorization, {
    allowedIdentities: identities,
    firstPartySettings: "caller",
    ...(options.signal ? { signal: options.signal } : {}),
    reauthorize: authorizeManifest,
  });
  try {
    options.signal?.throwIfAborted();
    await prepared.reauthorize?.();
    await authorizeManifest();
    const tools = prepared.toolGatewayCatalog.entries.map((entry) => ({
      version: 1 as const,
      entry,
      definitionDigest: digestToolGatewayDefinition(prepared.toolGatewayCatalog, entry),
    }));
    return {
      version: 1 as const,
      digest: digestCanonicalJson({ domain: "opengeni.tool-manifest", version: 1, tools }),
      tools,
    };
  } finally {
    await closeTargetPreparation(deps, prepared);
  }
}
