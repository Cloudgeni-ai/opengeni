import { createHash, randomBytes } from "node:crypto";
import {
  ToolGatewaySiteConsentReview,
  EDITABLE_ARTIFACT_MCP_CODEMODE_PATHS,
  ToolGatewayInvokeResponse,
  ToolGatewayTargetApprovalResponse,
  ToolGatewaySiteConsentResponse,
  type ToolGatewaySiteConsentRequest,
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
  getWorkspaceArtifactContentRef,
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
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "./http/api-error";
import {
  prepareWorkspaceToolGateway,
  requireWorkspaceSiteToolAuthorization,
  requireWorkspaceToolApprovalAuthorization,
  requireWorkspaceToolGatewayAuthorization,
  throwWorkspaceToolGatewayHttpError,
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
  routeSiteTool,
  siteToolConsentChoices,
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
  /** Observes the request's fence (statistics), never its authority. */
  onFence?: (fence: TargetAuthorityFence) => void;
};
const unavailable = () => new HTTPException(404, { message: "tool_unavailable" });
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
    let requested: ToolGatewayIdentity;
    if ("identity" in request.target) requested = request.target.identity;
    else {
      const path = request.target.path;
      const matches = declared.filter((item) => samePath(projectedPath(item), path));
      if (matches.length !== 1) throw notAuthorized();
      requested = matches[0]!;
    }
    return { visible, declared, requested };
  } catch (error) {
    // A missing, unseen or replaced Site version is a refusal; anything else
    // (a transient read, reauthorization) keeps its own status.
    if (error instanceof WorkspaceArtifactNotFoundError) throw notAuthorized();
    throw error;
  }
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
      tool = resolvedTool(prepared, target);
    } catch (error) {
      // A physical boundary that denied (or could not read) authority drops an
      // optional connector silently or fails a required one; report that
      // outcome instead of an opaque missing tool.
      return await fence.settle(error);
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
  const choices = siteToolConsentChoices(
    await (options.readAccounts ?? readSiteToolAccountInventory)(deps, authorization.grant),
    declared,
    requested,
  );
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
    accounts: choices.accounts.map(({ identity, connector, account }) => ({
      identity,
      connector,
      account,
    })),
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
