import { createHash, randomBytes } from "node:crypto";
import {
  ToolGatewaySiteConsentReview,
  EDITABLE_ARTIFACT_MCP_CODEMODE_PATHS,
  ToolGatewayInvokeResponse,
  ToolGatewayTargetApprovalResponse,
  ToolGatewaySiteConsentResponse,
  ToolGatewaySiteReadinessResponse,
  ToolGatewaySiteAllowancesResetResponse,
  type ToolGatewaySiteAllowancesResetRequest,
  type ToolGatewaySiteConsentRequest,
  type ToolGatewaySiteReadinessRequest,
  type ToolGatewaySiteReadinessTool,
  type ToolGatewayIdentity,
  type ToolGatewayResolveRequest,
  type ToolGatewayInvokeRequest,
  type ToolGatewayTargetApprovalRequest,
  type ToolGatewayResolvedTool,
  type ToolGatewayManifestRequest,
  type ToolGatewayTarget,
  type ToolReviewContext,
} from "@opengeni/contracts";
import {
  type AccessGrantAuthorization,
  type ApiRouteDeps,
  isVerifiedDelegatedHumanAuthorization,
  withSiteSessionOrigin,
  siteViewerForGrant,
} from "@opengeni/core";
import {
  beginTargetToolGatewayCall,
  clearSiteToolAllowances,
  getWorkspaceArtifactContentRef,
  listConnectorToolPermissionPolicies,
  projectConnectorToolPermission,
  hasSiteToolAllowance,
  issueToolGatewayApproval,
  listSiteToolAllowances,
  recordSiteToolAllowance,
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
import {
  isMcpRequestNotSentError,
  isMcpServerUnreachableError,
  mcpToolScopeNeed,
  sessionMcpApprovalConnectionId,
} from "@opengeni/runtime/workspace-tool-gateway";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "./http/api-error";
import {
  prepareWorkspaceToolGateway,
  requireWorkspaceSiteToolAuthorization,
  requireWorkspaceToolApprovalAuthorization,
  requireWorkspaceToolGatewayAuthorization,
  throwWorkspaceToolGatewayHttpError,
  toolServerUnreachableError,
  ToolReviewAuthNeededError,
  type PreparedWorkspaceToolGateway,
  type WorkspaceSiteVersionResolver,
  type WorkspaceToolGatewayAuthorization,
} from "./workspace-tool-gateway";
import {
  isPublishedSiteToolAuthorization,
  publishedSiteToolAuthority,
} from "./site-publishing/page-tool-authority";
import { resolveSiteSessionOrigin } from "./site-session-origin";
import {
  readSiteToolAccountInventory,
  readSiteToolReconnectAccounts,
  routeSiteTool,
  siteToolConsentChoices,
  siteToolNotAvailableForViewer,
  type SiteToolAccount,
  type SiteToolRouting,
} from "./site-tool-routing";
import { TargetAuthorityFence, targetFenceCaller } from "./workspace-tool-target-fence";

export type TargetGatewayOptions = {
  signal?: AbortSignal;
  /** The route's fresh human grant; organization keys and external actors use their own reads. */
  reauthorize?: () => Promise<void>;
  prepare?: typeof prepareWorkspaceToolGateway;
  begin?: typeof beginTargetToolGatewayCall;
  issue?: typeof issueToolGatewayApproval;
  authorizeSite?: typeof requireWorkspaceSiteToolAuthorization;
  /** Reads the pinned Site version as the caller may see it (default: the caller's own read). */
  readSiteVersion?: WorkspaceSiteVersionResolver;
  /** The viewer's own connector accounts, for routing Site calls. */
  readAccounts?: typeof readSiteToolAccountInventory;
  hasAllowance?: typeof hasSiteToolAllowance;
  listAllowances?: typeof listSiteToolAllowances;
  recordAllowance?: typeof recordSiteToolAllowance;
  clearAllowances?: typeof clearSiteToolAllowances;
  /** The viewer's accounts that must sign in again (readiness only). */
  readReconnect?: typeof readSiteToolReconnectAccounts;
  /** A connection's saved tool permissions (readiness reads them; calls decide in the gateway). */
  listPolicies?: typeof listConnectorToolPermissionPolicies;
  /** Observes the request's fence (statistics), never its authority. */
  onFence?: (fence: TargetAuthorityFence) => void;
};
const unavailable = () => new HTTPException(404, { message: "tool_unavailable" });
const isToolUnavailable = (error: unknown) =>
  error instanceof HTTPException &&
  !(error instanceof ApiHttpError) &&
  error.status === 404 &&
  error.message === "tool_unavailable";
const key = (identity: ToolGatewayIdentity) =>
  JSON.stringify([identity.serverId, identity.toolName]);
const sameIdentity = (a: ToolGatewayIdentity, b: ToolGatewayIdentity) => key(a) === key(b);
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
  authorization: WorkspaceToolGatewayAuthorization,
): Promise<WorkspaceSiteVersionResolver> {
  if (isPublishedSiteToolAuthorization(authorization))
    return publishedSiteToolAuthority(authorization).readVersion;
  const viewer = await siteViewerForGrant(deps.db, authorization.grant);
  return async (db, grant, artifactId, versionId) =>
    await getWorkspaceArtifactContentRef(db, grant.workspaceId, viewer, artifactId, versionId);
}

type DirectSiteRouting = Extract<SiteToolRouting, { kind: "direct" }>;
/** What the Site request is for: a resolve may use any of the viewer's accounts. */
type SiteTargetMode = "resolve" | "invoke" | "approve";

/**
 * A provider review that stopped before anything ran, as the typed answer the
 * Site's viewer can act on, or null when the review failed for another reason.
 * The connector's own auth-needed report says whether the account must allow
 * more access or sign in again; a provider refusal for this account (for
 * example a connection whose access can't grow) says it isn't available to it.
 */
function siteToolReviewRefusal(error: unknown): ApiHttpError | null {
  if (error instanceof ToolReviewAuthNeededError) {
    const { payload } = error;
    // An account whose access is fixed can't be given more, and signing in
    // again would not help: the action isn't available to it.
    if (payload.accountReason === "account_scope_fixed") return unavailableForAccount();
    if (payload.reason === "insufficient_scope" && payload.connectionId)
      return new ApiHttpError(409, {
        code: "conflict",
        message: "Give this account more access in Opengeni, then try again.",
        retryable: false,
        outcomeUnknown: false,
        details: {
          code: "tool_connection_needs_more_access",
          connectionId: payload.connectionId,
          scopes: payload.scopes ?? [],
        },
      });
    return new ApiHttpError(409, {
      code: "conflict",
      message: "Reconnect this account in Opengeni, then try again.",
      retryable: false,
      outcomeUnknown: false,
      details: {
        code: "tool_connection_needs_attention",
        reason: payload.reason,
        ...(payload.connectionId ? { connectionId: payload.connectionId } : {}),
      },
    });
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "access_denied"
  )
    return unavailableForAccount();
  return null;
}

function unavailableForAccount(): ApiHttpError {
  return new ApiHttpError(403, {
    code: "forbidden",
    message: "This action isn't available for this account.",
    retryable: false,
    outcomeUnknown: false,
    details: { code: "tool_unavailable_for_account" },
  });
}

/** A Site call that needs the person in the Opengeni frame (consent, account or connection). */
function siteConsentError(
  authorization: WorkspaceToolGatewayAuthorization,
  code:
    | "tool_gateway_approval_required"
    | "site_tool_account_required"
    | "site_tool_connection_required",
): ApiHttpError {
  // A published hostname has no Opengeni frame, and its page shares an origin
  // with its tool endpoint, so an in-page confirmation could be spoofed.
  if (isPublishedSiteToolAuthorization(authorization))
    return new ApiHttpError(409, {
      code: "conflict",
      message: "Open this Site in Opengeni to confirm this action.",
      retryable: false,
      outcomeUnknown: false,
      details: { code: "site_tool_consent_requires_opengeni" },
    });
  return new ApiHttpError(409, {
    code: "conflict",
    message:
      code === "tool_gateway_approval_required"
        ? "tool_gateway_approval_required"
        : code === "site_tool_account_required"
          ? "Choose which of your accounts to use."
          : "Connect your account to use this.",
    retryable: false,
    outcomeUnknown: false,
    details: { code },
  });
}

function directRouting(
  account: SiteToolAccount,
  declaredIdentity: ToolGatewayIdentity,
): DirectSiteRouting {
  return {
    kind: "direct",
    identity: account.identity,
    declaredIdentity,
    allowance: {
      serverId: account.canonicalServerId,
      toolName: account.identity.toolName,
      connectionId: account.connectionId,
    },
    account,
  };
}

const approvalRequiredError = () =>
  new ApiHttpError(409, {
    code: "conflict",
    message: "tool_gateway_approval_required",
    retryable: false,
    outcomeUnknown: false,
    details: { code: "tool_gateway_approval_required" },
  });

function siteAllowanceKey(
  authorization: WorkspaceToolGatewayAuthorization,
  request: { siteArtifactId?: string | undefined },
  routing: DirectSiteRouting,
) {
  return {
    accountId: authorization.grant.accountId,
    workspaceId: authorization.grant.workspaceId,
    subjectId: authorization.grant.subjectId,
    siteId: request.siteArtifactId!,
    ...routing.allowance,
  };
}

/** The pinned active Site version's declarations, read as the caller may see it. */
async function readSiteVersionDeclarations(
  deps: ApiRouteDeps,
  authorization: WorkspaceToolGatewayAuthorization,
  request: { siteArtifactId: string; siteVersionId: string },
  options: TargetGatewayOptions,
) {
  const visible = options.readSiteVersion ?? (await siteVersionReader(deps, authorization));
  try {
    const { status, version } = await visible(
      deps.db,
      authorization.grant,
      request.siteArtifactId,
      request.siteVersionId,
    );
    if (status !== "active" || version.id !== request.siteVersionId) throw notAuthorized();
    const declared: readonly ToolGatewayIdentity[] = version.requestedTools;
    return { visible, declared };
  } catch (error) {
    // A missing, unseen or replaced Site version is a refusal; anything else
    // (a transient read, reauthorization) keeps its own status.
    if (error instanceof WorkspaceArtifactNotFoundError) throw notAuthorized();
    throw error;
  }
}

/** The declared identity a target names; a path must match exactly one declaration. */
function declaredTarget(
  declared: readonly ToolGatewayIdentity[],
  target: ToolGatewayTarget,
): ToolGatewayIdentity {
  if ("identity" in target) return target.identity;
  const matches = declared.filter((item) => samePath(projectedPath(item), target.path));
  if (matches.length !== 1) throw notAuthorized();
  return matches[0]!;
}

async function readSiteDeclaration(
  deps: ApiRouteDeps,
  authorization: WorkspaceToolGatewayAuthorization,
  request: {
    siteArtifactId: string;
    siteVersionId: string;
    target: ToolGatewayTarget;
  },
  options: TargetGatewayOptions,
) {
  const { visible, declared } = await readSiteVersionDeclarations(
    deps,
    authorization,
    request,
    options,
  );
  return { visible, declared, requested: declaredTarget(declared, request.target) };
}
const notAuthorized = () => new HTTPException(403, { message: "site_tool_not_authorized" });

/**
 * "Always allow for this Site" is the person's own standing choice, made in an
 * Opengeni frame: a signed-in session, or a product embedding Opengeni for
 * that person. Never a service key or an external actor's continuation.
 */
function mayRememberForSite(authorization: WorkspaceToolGatewayAuthorization) {
  if (isPublishedSiteToolAuthorization(authorization)) return false;
  return Boolean(
    authorization.canonicalManagedHumanSession ||
    authorization.canonicalLocalHumanSession ||
    isVerifiedDelegatedHumanAuthorization(authorization),
  );
}

/**
 * Site paths are matched to the stored allowlist before any provider work.
 * The declared identity is then routed to the viewer's own account
 * (`site-tool-routing.ts`); never another member's personal connection.
 */
async function siteTarget(
  deps: ApiRouteDeps,
  authorization: WorkspaceToolGatewayAuthorization,
  request: ToolGatewayResolveRequest,
  options: TargetGatewayOptions,
  mode: SiteTargetMode,
): Promise<{
  target: ToolGatewayTarget;
  site?: {
    context: {
      siteArtifactId: string;
      siteVersionId: string;
      identity: ToolGatewayIdentity;
      declaredIdentity?: ToolGatewayIdentity;
    };
    visible: WorkspaceSiteVersionResolver;
    routing: DirectSiteRouting;
  };
}> {
  if (!request.siteArtifactId || !request.siteVersionId) return { target: request.target };
  const { visible, declared, requested } = await readSiteDeclaration(
    deps,
    authorization,
    {
      siteArtifactId: request.siteArtifactId,
      siteVersionId: request.siteVersionId,
      target: request.target,
    },
    options,
  );
  const routed = routeSiteTool(
    await (options.readAccounts ?? readSiteToolAccountInventory)(deps, authorization.grant),
    declared,
    requested,
  );
  let routing: DirectSiteRouting;
  if (routed.kind === "connect")
    throw siteConsentError(authorization, "site_tool_connection_required");
  else if (routed.kind === "accounts") {
    let account = routed.accounts.length === 1 ? routed.accounts[0] : undefined;
    if (!account) {
      // "Always allow for this Site" on exactly one of the viewer's accounts
      // also chooses that account for later calls.
      const allowances = await (options.listAllowances ?? listSiteToolAllowances)(deps.db, {
        workspaceId: authorization.grant.workspaceId,
        subjectId: authorization.grant.subjectId,
        siteId: request.siteArtifactId,
      });
      const remembered = routed.accounts.filter((candidate) =>
        allowances.some(
          (allowance) =>
            allowance.serverId === candidate.canonicalServerId &&
            allowance.toolName === candidate.identity.toolName &&
            allowance.connectionId === candidate.connectionId,
        ),
      );
      if (remembered.length === 1) account = remembered[0];
    }
    // A definition is the same on every account; only running needs one.
    if (!account && mode !== "resolve")
      throw siteConsentError(authorization, "site_tool_account_required");
    routing = directRouting(account ?? routed.accounts[0]!, routed.declaredIdentity);
  } else routing = routed;
  const context = {
    siteArtifactId: request.siteArtifactId,
    siteVersionId: request.siteVersionId,
    identity: routing.identity,
    // Only when a declared connector was routed to the viewer's own account.
    ...(sameIdentity(routing.identity, routing.declaredIdentity)
      ? {}
      : { declaredIdentity: routing.declaredIdentity }),
  };
  await (options.authorizeSite ?? requireWorkspaceSiteToolAuthorization)(
    deps.db,
    authorization.grant,
    context,
    visible,
  );
  return {
    target: { identity: routing.identity },
    site: { context, visible, routing },
  };
}

/**
 * The request's single live fence. The owner closes it strictly after the
 * awaited preparation cleanup. `targeted` requests must install their route.
 */
export function createTargetFence(
  deps: ApiRouteDeps,
  authorization: WorkspaceToolGatewayAuthorization,
  options: TargetGatewayOptions,
  targeted: boolean,
): TargetAuthorityFence {
  const fence = new TargetAuthorityFence({
    db: deps.db,
    targeted,
    caller: isPublishedSiteToolAuthorization(authorization)
      ? { standalone: publishedSiteToolAuthority(authorization).reauthorize }
      : targetFenceCaller(deps, authorization, options.reauthorize),
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

/** Whether the server a target needs dropped out of the preparation as unreachable. */
function unreachableTarget(prepared: PreparedWorkspaceToolGateway, target: ToolGatewayTarget) {
  // A path names no server until it resolves, so it can't say which server
  // was missing; it keeps the plain unavailable answer.
  return "identity" in target && prepared.unreachable?.has(target.identity.serverId) === true;
}

async function withTarget<T>(
  deps: ApiRouteDeps,
  authorization: WorkspaceToolGatewayAuthorization,
  request: ToolGatewayResolveRequest,
  options: TargetGatewayOptions,
  mode: SiteTargetMode,
  use: (
    prepared: PreparedWorkspaceToolGateway,
    tool: ToolGatewayResolvedTool,
    fence: TargetAuthorityFence,
    routing: DirectSiteRouting | undefined,
  ) => Promise<T>,
): Promise<T> {
  requireWorkspaceToolGatewayAuthorization(authorization);
  options.signal?.throwIfAborted();
  const fence = createTargetFence(deps, authorization, options, true);
  let prepared: PreparedWorkspaceToolGateway | undefined;
  try {
    // Admission: the live caller, then the exact pinned Site entry.
    await fence.admit();
    const { target, site } = await siteTarget(deps, authorization, request, options, mode);
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
        ...(site
          ? {
              siteRoute: {
                identity: site.routing.identity,
                declaredIdentity: site.routing.declaredIdentity,
              },
            }
          : {}),
        firstPartySettings: "caller",
        ...(options.signal ? { signal: options.signal } : {}),
        fence,
      });
      options.signal?.throwIfAborted();
      try {
        tool = resolvedTool(prepared, target);
      } catch (error) {
        // The tool is missing because its server could not be reached, not
        // because it does not exist: nothing was sent, so try again.
        if (isToolUnavailable(error) && unreachableTarget(prepared, target))
          throw toolServerUnreachableError();
        throw error;
      }
    } catch (error) {
      // A physical boundary that denied (or could not read) authority drops an
      // optional connector silently or fails a required one; report that
      // outcome instead of an opaque missing tool.
      return await fence.settle(
        // A declared Site tool nothing in the viewer's inventory explains says
        // so, instead of the bare unavailable-tool answer.
        site?.routing.unresolved && isToolUnavailable(error)
          ? siteToolNotAvailableForViewer()
          : // A required server that could not be reached fails its preparation.
            !(error instanceof HTTPException) && isMcpServerUnreachableError(error)
            ? toolServerUnreachableError()
            : error,
      );
    }
    return await use(prepared, tool, fence, site?.routing);
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
  authorization: WorkspaceToolGatewayAuthorization,
  request: ToolGatewayResolveRequest,
  options: TargetGatewayOptions = {},
) {
  return await withTarget(
    deps,
    authorization,
    request,
    options,
    "resolve",
    async (_prepared, tool, fence) => {
      // The definition is disclosed only while the complete fence still holds.
      await fence.check({ retryable: true });
      return tool;
    },
  );
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
  authorization: WorkspaceToolGatewayAuthorization,
  request: ToolGatewayInvokeRequest,
  options: TargetGatewayOptions = {},
) {
  return await withTarget(
    deps,
    authorization,
    request,
    options,
    "invoke",
    async (prepared, tool, fence, routing) => {
      assertDefinition(tool, request.expectedDefinitionDigest);
      const meta: Record<string, unknown> = {
        approvalConfirmed: true,
        targetedCall: true,
      };
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
          {
            transportMeta: meta,
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        // Caller, Site, route and the decided action policy, before admission.
        await fence.check({ retryable: true });
        // A call without a trustworthy effect binding fails closed before it
        // can ask anyone, use a standing allowance or reach admission.
        const targetBindingDigest = approvalBinding(call, request);
        let approvalRequired =
          call.approvalDecision === "ask" ||
          (call.approvalDecision === undefined && tool.entry.approval === "human");
        let allowedForSite = false;
        if (approvalRequired && request.approvalToken === undefined) {
          // A Site call asks its viewer in the Opengeni frame, unless this person
          // chose "Always allow for this Site" for this tool and connection.
          // A Block never reaches here (`prepareCall` refuses it).
          if (!routing) throw approvalRequiredError();
          allowedForSite = await (options.hasAllowance ?? hasSiteToolAllowance)(deps.db, {
            ...siteAllowanceKey(authorization, request, routing),
          });
          if (!allowedForSite)
            throw siteConsentError(authorization, "tool_gateway_approval_required");
          approvalRequired = false;
        }
        const accepted = await (options.begin ?? beginTargetToolGatewayCall)(deps.db, {
          ...authorization.grant,
          operationId: request.operationId,
          identity: tool.entry.identity,
          targetBindingDigest,
          argumentsDigest: digestCanonicalJson(request.arguments),
          approvalAuthorityDigest: call.approvalAuthorityDigest,
          approvalRequired,
          ...(request.approvalToken ? { tokenHash: hashToken(request.approvalToken) } : {}),
        });
        if (!accepted) throw approvalRequiredError();
        meta.approvalConfirmed =
          approvalRequired || allowedForSite || request.approvalToken !== undefined;
      } catch (error) {
        if (error instanceof ApiHttpError) throw error;
        approvalError(error);
      }
      const origin = isPublishedSiteToolAuthorization(authorization)
        ? publishedSiteToolAuthority(authorization).origin
        : request.siteArtifactId && request.siteVersionId
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
        return ToolGatewayInvokeResponse.parse({
          operationId: request.operationId,
          tool,
          result,
        });
      } catch (error) {
        // Only a request that provably never left is known not to have run.
        if (isMcpRequestNotSentError(error)) throw toolServerUnreachableError();
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
  requireWorkspaceToolApprovalAuthorization(authorization);
  return await withTarget(
    deps,
    authorization,
    { ...request, target: { identity: request.identity } },
    options,
    "approve",
    async (prepared, tool, fence, routing) => {
      assertDefinition(tool, request.expectedDefinitionDigest);
      if (request.rememberForSite && !mayRememberForSite(authorization))
        throw new HTTPException(403, { message: "site_tool_allowance_requires_person" });
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
        ) {
          // Nothing to approve; "Always allow" still remembers the account the
          // viewer chose for this Site.
          if (request.rememberForSite && routing?.account) {
            await fence.check({ retryable: true });
            await (options.recordAllowance ?? recordSiteToolAllowance)(
              deps.db,
              siteAllowanceKey(authorization, request, routing),
            );
          }
          throw new HTTPException(422, { message: "tool_does_not_require_human_approval" });
        }
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
        // "Always allow for this Site": this person, this Site, this tool on
        // this connection. The connection-wide permission is untouched.
        if (request.rememberForSite) {
          if (!routing) throw new HTTPException(400, { message: "site_context_required" });
          await (options.recordAllowance ?? recordSiteToolAllowance)(
            deps.db,
            siteAllowanceKey(authorization, request, routing),
          );
        }
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

/**
 * What the Opengeni frame shows before a Site call: the viewer's own accounts
 * that may run the declared tool, or the connector to connect. Read-only and
 * never on a published hostname, which has no Opengeni frame.
 */
export async function describeWorkspaceSiteToolConsent(
  deps: ApiRouteDeps,
  authorization: WorkspaceToolGatewayAuthorization,
  request: ToolGatewaySiteConsentRequest,
  options: TargetGatewayOptions = {},
): Promise<ToolGatewaySiteConsentResponse> {
  requireWorkspaceToolGatewayAuthorization(authorization);
  if (isPublishedSiteToolAuthorization(authorization))
    throw siteConsentError(authorization, "tool_gateway_approval_required");
  options.signal?.throwIfAborted();
  await options.reauthorize?.();
  const { declared, requested } = await readSiteDeclaration(
    deps,
    authorization,
    {
      siteArtifactId: request.siteArtifactId,
      siteVersionId: request.siteVersionId,
      target: { identity: request.identity },
    },
    options,
  );
  const inventory = await (options.readAccounts ?? readSiteToolAccountInventory)(
    deps,
    authorization.grant,
  );
  const choices = siteToolConsentChoices(inventory, declared, requested);
  // What the call would do, read by the provider on the account the frame
  // preselects; the Site's own description of its arguments is not enough.
  const route = choices.connect
    ? null
    : (choices.selected ?? choices.accounts[0]?.identity ?? requested);
  const review =
    request.arguments && route
      ? await reviewSiteToolCall(
          deps,
          authorization,
          {
            identity: route,
            siteArtifactId: request.siteArtifactId,
            siteVersionId: request.siteVersionId,
            arguments: request.arguments,
          },
          options,
        )
      : null;
  return ToolGatewaySiteConsentResponse.parse({
    version: 1,
    // The viewer's own connection and its capability, so the frame can offer
    // Reconnect for that same account when it stops working.
    accounts: choices.accounts.map(
      ({ identity, connector, account, connectionId, canonicalServerId, shared }) => ({
        identity,
        connector,
        account,
        connectionId,
        capabilityId: inventory.canonical.get(canonicalServerId)?.capabilityId ?? null,
        shared: shared === true,
      }),
    ),
    selected: choices.selected,
    review,
    connect: choices.connect,
  });
}

/**
 * The provider's review of the exact arguments on one of the viewer's routes,
 * through the same fenced preparation as the call. A provider that cannot read
 * what the call would do (a missing draft, an unreadable message) refuses: the
 * frame never asks about an action it cannot describe.
 */
async function reviewSiteToolCall(
  deps: ApiRouteDeps,
  authorization: WorkspaceToolGatewayAuthorization,
  request: {
    identity: ToolGatewayIdentity;
    siteArtifactId: string;
    siteVersionId: string;
    arguments: Record<string, unknown>;
  },
  options: TargetGatewayOptions,
): Promise<ToolGatewaySiteConsentReview | null> {
  return await withTarget(
    deps,
    authorization,
    {
      target: { identity: request.identity },
      siteArtifactId: request.siteArtifactId,
      siteVersionId: request.siteVersionId,
    },
    options,
    "resolve",
    async (prepared, tool) => {
      let context: Partial<ToolReviewContext>;
      try {
        context = prepared.review
          ? await prepared.review(tool.entry.identity, request.arguments)
          : {};
      } catch (error) {
        if (error instanceof ApiHttpError || error instanceof HTTPException) throw error;
        const typed = siteToolReviewRefusal(error);
        if (typed) throw typed;
        throw new ApiHttpError(422, {
          code: "validation_failed",
          message: "Opengeni couldn't read what this action would do, so it was not run.",
          retryable: false,
          outcomeUnknown: false,
          details: { code: "site_tool_review_unavailable" },
        });
      }
      // Only an email review changes what the frame shows; other reviews
      // (labels, events) keep the action's own wording.
      const email = context.email;
      if (!email) return null;
      return ToolGatewaySiteConsentReview.parse({
        kind: "gmail",
        email: {
          from: email.from,
          to: email.to,
          cc: email.cc,
          bcc: email.bcc,
          subject: email.subject,
          attachments: email.attachments.length,
        },
      });
    },
  );
}

type SiteReadinessConfirm = ToolGatewaySiteReadinessTool["confirm"];

/**
 * Whether a tool on one approval identity asks first, from the same saved
 * permissions and recommendation inputs the gateway decides with. A tool's own
 * recommendation is read from its provider, which readiness never contacts,
 * so unless a saved choice or the server's own setting decides, it is `maybe`.
 */
function siteToolPermission(
  policies: Parameters<typeof projectConnectorToolPermission>[0],
  target: { connectionId: string; serverId: string; toolName: string },
  recommendsApproval: boolean,
): "block" | SiteReadinessConfirm {
  const defaults: Array<"allow" | "ask"> = recommendsApproval ? ["ask"] : ["allow", "ask"];
  const projections = defaults.map((defaultDecision) =>
    projectConnectorToolPermission(policies, { ...target, defaultDecision }),
  );
  if (projections.some((projection) => projection.conditional)) return "maybe";
  const permissions = new Set(projections.map((projection) => projection.permission));
  if (permissions.size !== 1) return "maybe";
  const [permission] = [...permissions];
  return permission === "block" ? "block" : permission === "ask" ? "always" : "never";
}

/**
 * What the viewer can do with each of a pinned Site's declared tools before
 * anything runs: whether it runs, asks first, needs an account chosen,
 * connected or reconnected, is blocked, or needs Opengeni. Read-only and
 * advisory: the same declarations, account routing, saved permissions and
 * "Always allow" choices a call uses, without preparing a call or contacting
 * a provider. Every call is still checked in full.
 */
export async function describeWorkspaceSiteToolReadiness(
  deps: ApiRouteDeps,
  authorization: WorkspaceToolGatewayAuthorization,
  request: ToolGatewaySiteReadinessRequest,
  options: TargetGatewayOptions = {},
): Promise<ToolGatewaySiteReadinessResponse> {
  const grant = requireWorkspaceToolGatewayAuthorization(authorization);
  options.signal?.throwIfAborted();
  await options.reauthorize?.();
  const published = isPublishedSiteToolAuthorization(authorization);
  const { declared } = await readSiteVersionDeclarations(deps, authorization, request, options);
  const inventory = await (options.readAccounts ?? readSiteToolAccountInventory)(deps, grant);
  // Only a person's own standing choices; a published page has none.
  const allowances = published
    ? []
    : await (options.listAllowances ?? listSiteToolAllowances)(deps.db, {
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        siteId: request.siteArtifactId,
      });
  const policiesByConnection = new Map<
    string,
    Promise<Awaited<ReturnType<typeof listConnectorToolPermissionPolicies>>>
  >();
  const policiesFor = (connectionId: string) => {
    let read = policiesByConnection.get(connectionId);
    if (!read) {
      read = (options.listPolicies ?? listConnectorToolPermissionPolicies)(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        connectionId,
      });
      policiesByConnection.set(connectionId, read);
    }
    return read;
  };
  const allowed = (allowance: DirectSiteRouting["allowance"]) =>
    allowances.some(
      (candidate) =>
        candidate.serverId === allowance.serverId &&
        candidate.toolName === allowance.toolName &&
        candidate.connectionId === allowance.connectionId,
    );
  // Asking needs a person in an Opengeni frame; a service key has no one to ask.
  const mayConfirm = (() => {
    try {
      requireWorkspaceToolApprovalAuthorization(authorization);
      return true;
    } catch {
      return false;
    }
  })();
  // Read only when some target needs a connector the viewer has no working account for.
  let reconnect: ReturnType<typeof readSiteToolReconnectAccounts> | undefined;
  const reconnectFor = async (canonicalServerId: string) => {
    reconnect ??= (options.readReconnect ?? readSiteToolReconnectAccounts)(deps, grant, [
      ...inventory.canonical.keys(),
    ]);
    return (await reconnect).find((account) => account.canonicalServerId === canonicalServerId);
  };
  const tools: ToolGatewaySiteReadinessTool[] = [];
  for (const target of request.targets) {
    options.signal?.throwIfAborted();
    const entry = (
      state: ToolGatewaySiteReadinessTool["state"],
      rest: Partial<Omit<ToolGatewaySiteReadinessTool, "target" | "state">> = {},
    ): ToolGatewaySiteReadinessTool => ({
      target,
      state,
      confirm: rest.confirm ?? "maybe",
      runsAs: rest.runsAs ?? null,
      connector: rest.connector ?? null,
      ...(rest.scopes ? { scopes: rest.scopes } : {}),
      ...(rest.unavailableReason ? { unavailableReason: rest.unavailableReason } : {}),
    });
    let routed: SiteToolRouting;
    try {
      routed = routeSiteTool(inventory, declared, declaredTarget(declared, target));
    } catch (error) {
      // Not declared by this version: it can't run on this Site.
      if (error instanceof HTTPException && error.status === 403) {
        tools.push(entry("unavailable"));
        continue;
      }
      throw error;
    }
    if (routed.kind === "connect") {
      const stale = await reconnectFor(routed.declaredIdentity.serverId);
      const connector = routed.connect.name;
      if (stale)
        tools.push(
          entry(published ? "open_in_opengeni" : "reconnect", {
            connector,
            runsAs: { connector, account: stale.account, shared: stale.shared },
          }),
        );
      else tools.push(entry(published ? "open_in_opengeni" : "connect", { connector }));
      continue;
    }
    let routing: DirectSiteRouting;
    if (routed.kind === "accounts") {
      let account = routed.accounts.length === 1 ? routed.accounts[0] : undefined;
      if (!account) {
        const remembered = routed.accounts.filter((candidate) =>
          allowed(directRouting(candidate, routed.declaredIdentity).allowance),
        );
        if (remembered.length === 1) account = remembered[0];
      }
      if (!account) {
        tools.push(
          entry(published ? "open_in_opengeni" : "choose_account", {
            connector: routed.accounts[0]!.connector,
          }),
        );
        continue;
      }
      routing = directRouting(account, routed.declaredIdentity);
    } else routing = routed;
    if (routing.unresolved) {
      tools.push(entry("unavailable"));
      continue;
    }
    const account = routing.account;
    const connector = account?.connector ?? null;
    const runsAs = account
      ? { connector: account.connector, account: account.account, shared: account.shared === true }
      : null;
    // The approval identity the gateway decides with (`policyTargets`).
    const server = inventory.servers?.get(routing.identity.serverId);
    const policyServerId = account?.canonicalServerId ?? routing.identity.serverId;
    const connectionId =
      account?.connectionId ??
      server?.connectionId ??
      (server?.url ? sessionMcpApprovalConnectionId(routing.identity.serverId, server.url) : null);
    const settingsServer = inventory.servers?.get(policyServerId) ?? server;
    const recommendsApproval =
      settingsServer?.requireApproval === true ||
      (Array.isArray(settingsServer?.requireApproval) &&
        settingsServer.requireApproval.includes(routing.identity.toolName));
    let permission: "block" | SiteReadinessConfirm = recommendsApproval ? "always" : "maybe";
    if (connectionId)
      permission = siteToolPermission(
        await policiesFor(connectionId),
        { connectionId, serverId: policyServerId, toolName: routing.identity.toolName },
        recommendsApproval,
      );
    if (permission === "block") {
      tools.push(entry("blocked", { confirm: "never", runsAs, connector }));
      continue;
    }
    // Access the account must allow first, from the grants it records (the
    // provider is never asked here). An account whose access is fixed can't
    // be given more, so the tool is not available on it.
    const missingScopes =
      account?.grantedScopes && settingsServer?.url
        ? mcpToolScopeNeed(
            {
              url: settingsServer.url,
              ...(settingsServer.connectionRef
                ? { connectionRef: settingsServer.connectionRef }
                : {}),
            },
            routing.identity.toolName,
            account.grantedScopes,
          )
        : null;
    if (missingScopes) {
      tools.push(
        account?.fixedAccess
          ? entry("unavailable", {
              confirm: "never",
              runsAs,
              connector,
              unavailableReason: "account",
            })
          : entry(published ? "open_in_opengeni" : "grant", {
              runsAs,
              connector,
              scopes: [...missingScopes],
            }),
      );
      continue;
    }
    // "Always allow for this Site" answers any question this call would ask.
    const confirm: SiteReadinessConfirm =
      permission !== "never" && allowed(routing.allowance) ? "remembered" : permission;
    const state =
      confirm !== "always"
        ? "ready"
        : published
          ? "open_in_opengeni"
          : mayConfirm
            ? "confirm"
            : "unavailable";
    tools.push(entry(state, { confirm, runsAs, connector }));
  }
  return ToolGatewaySiteReadinessResponse.parse({ version: 1, tools });
}

/**
 * Removes every "Always allow for this Site" choice the caller made on one
 * Site they can still see: their own choices only, made in an Opengeni frame.
 * The next call asks again (and chooses an account again where it has several).
 */
export async function resetWorkspaceSiteToolAllowances(
  deps: ApiRouteDeps,
  authorization: WorkspaceToolGatewayAuthorization,
  request: ToolGatewaySiteAllowancesResetRequest,
  options: TargetGatewayOptions = {},
): Promise<ToolGatewaySiteAllowancesResetResponse> {
  const grant = requireWorkspaceToolGatewayAuthorization(authorization);
  if (!mayRememberForSite(authorization))
    throw new HTTPException(403, { message: "site_tool_allowance_requires_person" });
  options.signal?.throwIfAborted();
  await options.reauthorize?.();
  // The Site must still be one this person can see.
  await readSiteVersionDeclarations(deps, authorization, request, options);
  const removed = await (options.clearAllowances ?? clearSiteToolAllowances)(deps.db, {
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    siteId: request.siteArtifactId,
  });
  return ToolGatewaySiteAllowancesResetResponse.parse({ version: 1, removed });
}
