import {
  SITE_FRAME_HEADER,
  SITE_FRAME_ID_HEADER,
  SITE_ID_HEADER,
  SITE_VERSION_HEADER,
  siteFrameBodyRefusal,
  siteFrameOperation,
  siteRequestHeaders,
} from "@opengeni/contracts/site-session-http";
import { OpenGeniApiError } from "./errors";
import { createSharedCatalogLoader } from "./shared-catalog-loader";
import { siteSessionPath, type SiteHttpRequest } from "./site-http";
import type { OpenGeniSiteToolCatalog } from "./site";
import type { OpenGeniWorkspaceTools } from "./tools";
import type {
  ToolGatewayCallRequest,
  ToolGatewayCallResponse,
  ToolGatewayIdentity,
  ToolGatewayResolveRequest,
  ToolGatewayResolvedTool,
  ToolGatewayInvokeRequest,
  ToolGatewayInvokeResponse,
  ToolGatewaySiteConsentAccount,
  ToolGatewaySiteConsentResponse,
  ToolGatewaySiteConsentReview,
  ToolGatewayTargetApprovalRequest,
  ToolGatewayTargetApprovalResponse,
} from "./types";

/**
 * What the Opengeni frame asks the viewer before a Site's tool call runs. Host
 * UI only: Site code can neither open, answer, nor skip it.
 */
export type SiteToolConsentPrompt = {
  /** The tool, resolved on the preselected account. */
  tool: ToolGatewayResolvedTool;
  arguments: Record<string, unknown>;
  /** The viewer's own accounts that may run it; empty when it needs none. */
  accounts: ToolGatewaySiteConsentAccount[];
  /** The preselected account route, when there are accounts. */
  selected: ToolGatewayIdentity | null;
  /**
   * The provider's own reading of the call on `selected` (for Gmail, the
   * message as it would be sent). Null when the provider has none; then the
   * call's arguments are what it sends.
   */
  review: ToolGatewaySiteConsentReview | null;
  /** The provider's review on another of `accounts`, when the viewer picks it. */
  reviewFor: (identity: ToolGatewayIdentity) => Promise<ToolGatewaySiteConsentReview | null>;
  signal: AbortSignal;
};
/** `null` cancels. `identity` picks one of `accounts`. */
export type SiteToolConsentDecision = {
  identity?: ToolGatewayIdentity;
  /** "Always allow for this Site": this person, this Site, this tool and connection. */
  alwaysAllow?: boolean;
} | null;
export type SiteToolConnectPrompt = {
  connect: NonNullable<ToolGatewaySiteConsentResponse["connect"]>;
  signal: AbortSignal;
};

/** The viewer cancelled the confirmation; nothing ran. */
export class SiteToolConsentDeclinedError extends Error {
  readonly code = "site_tool_consent_declined";
  readonly retryable = false;
  readonly outcomeUnknown = false;
  constructor() {
    super("Cancelled.");
    this.name = "SiteToolConsentDeclinedError";
  }
}

/** The tool needs an account the viewer has to connect in Opengeni first. */
export class SiteToolConnectionRequiredError extends Error {
  readonly code = "site_tool_connection_required";
  readonly retryable = false;
  readonly outcomeUnknown = false;
  constructor(name: string) {
    super(`Connect ${name} in Opengeni, then try again.`);
    this.name = "SiteToolConnectionRequiredError";
  }
}

/** Server refusals that the Opengeni frame answers by asking the viewer. */
const SITE_CONSENT_CODES = new Set([
  "tool_gateway_approval_required",
  "site_tool_account_required",
  "site_tool_connection_required",
]);
function siteConsentCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { status?: unknown; details?: { code?: unknown } };
  const code = candidate.details?.code;
  return candidate.status === 409 && typeof code === "string" && SITE_CONSENT_CODES.has(code)
    ? code
    : null;
}

export type SiteToolCallRequest = ToolGatewayCallRequest & {
  siteArtifactId: string;
  siteVersionId: string;
};
export type SiteToolCaller = (input: {
  workspaceId: string;
  request: ToolGatewayCallRequest &
    Partial<Pick<SiteToolCallRequest, "siteArtifactId" | "siteVersionId">>;
  signal: AbortSignal;
}) => Promise<ToolGatewayCallResponse>;
export type SiteToolBridge = {
  resolve?: (
    request: ToolGatewayResolveRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayResolvedTool>;
  invoke?: (
    request: ToolGatewayInvokeRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayInvokeResponse>;
  fetch?: (request: SiteHttpRequest, signal: AbortSignal) => Promise<Response>;
  /** The host serves Site Data for its pinned published Site through `fetch`. */
  siteData?: boolean;
  catalog: (options: { signal: AbortSignal }) => Promise<OpenGeniSiteToolCatalog>;
  call: (
    request: ToolGatewayCallRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayCallResponse>;
};
export type CreateSiteToolBridgeOptions = {
  workspaceTools: Pick<OpenGeniWorkspaceTools, "$catalog"> &
    Partial<Pick<OpenGeniWorkspaceTools, "$targetProtocol" | "$resolve" | "$invoke" | "$manifest">>;
  workspaceId: string;

  callTool: SiteToolCaller;
  isCatalogStale?: (error: unknown) => boolean;
  /** Optional authenticated host transport for the host-bound workspace API.
   * Omit to expose tools only. Site-provided authorization headers are never forwarded. */
  fetchResponse?: (path: string, init: RequestInit) => Promise<Response>;
  /**
   * Host UI that confirms a pinned Site's tool call that needs the viewer:
   * approval, or which of their own accounts to use. Requires `fetchResponse`
   * and a pinned Site. Without it such calls fail as before.
   */
  confirmToolCall?: (prompt: SiteToolConsentPrompt) => Promise<SiteToolConsentDecision>;
  /** Host UI that lets the viewer connect an account; resolves true once connected. */
  connectForToolCall?: (prompt: SiteToolConnectPrompt) => Promise<boolean>;
} & (
  | { artifactId: string; siteVersionId: string; requestedTools: readonly ToolGatewayIdentity[] }
  | { artifactId?: never; siteVersionId?: never; requestedTools?: never }
);

/** Host-side bridge for the opaque Site frame. Supply an authenticated transport;
 * the server independently checks live viewer access and the exact Site version.
 * Recreate on actor/version change. Never take these pinned fields from HTML.
 *
 * `fetch` forwards only the `SITE_OPERATIONS` allowlist (`siteSessionPath`);
 * every other route is refused before a request is made. Each bridge is one
 * frame: it mints a frame id, so a frame without a published Site reaches only
 * the sessions it started. */
export function createSiteToolBridge(input: CreateSiteToolBridgeOptions): SiteToolBridge {
  const allowed = input.requestedTools ? new Set(input.requestedTools.map(identityKey)) : null;
  const allowedTools = new Set(input.requestedTools?.map((identity) => identity.toolName));
  const frameId = crypto.randomUUID();
  const targeted =
    input.workspaceTools.$targetProtocol === 1 &&
    input.workspaceTools.$resolve &&
    input.workspaceTools.$invoke &&
    input.workspaceTools.$manifest;
  const context = input.artifactId
    ? { siteArtifactId: input.artifactId, siteVersionId: input.siteVersionId }
    : {};
  const manifests = new Map<string, readonly ToolGatewayResolvedTool[]>();
  const resolve = async (
    request: ToolGatewayResolveRequest,
    { signal }: { signal: AbortSignal },
  ) => {
    if (
      allowed &&
      "identity" in request.target &&
      !allowed.has(identityKey(request.target.identity))
    )
      throw new Error("This tool is not available to the Site");
    const tool = await input.workspaceTools.$resolve!(request.target, { signal, ...context });
    // A declared connector tool resolves to the viewer's own account route,
    // which the server derived from this pinned version: the same tool name.
    if (
      allowed &&
      !allowed.has(identityKey(tool.entry.identity)) &&
      ("identity" in request.target
        ? tool.entry.identity.toolName !== request.target.identity.toolName
        : !allowedTools.has(tool.entry.identity.toolName))
    )
      throw new Error("This tool is not available to the Site");
    return tool;
  };
  const invokeOnce = async (
    request: ToolGatewayInvokeRequest,
    signal: AbortSignal,
    approvalToken?: string,
  ) =>
    await input.workspaceTools.$invoke!(
      {
        target: request.target,
        operationId: request.operationId,
        arguments: request.arguments,
        ...(request.expectedDefinitionDigest === undefined
          ? {}
          : { expectedDefinitionDigest: request.expectedDefinitionDigest }),
        // Only the host's own confirmation mints a token; Site input never carries one.
        ...(approvalToken === undefined ? {} : { approvalToken }),
        ...context,
      },
      { signal },
    );
  const hostJson = async <T>(path: string, body: unknown, signal: AbortSignal): Promise<T> => {
    const response = await input.fetchResponse!(
      `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/tools/${path}`,
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const text = await response.text();
    if (!response.ok) throw new OpenGeniApiError(response.status, text);
    return JSON.parse(text) as T;
  };
  /**
   * The viewer confirms in the Opengeni frame, then the same operation runs
   * on the account they chose, with an approval minted by the host.
   */
  const invokeWithConsent = async (
    request: ToolGatewayInvokeRequest,
    signal: AbortSignal,
    code: string,
  ): Promise<ToolGatewayInvokeResponse> => {
    const site = { siteArtifactId: input.artifactId!, siteVersionId: input.siteVersionId! };
    const declared =
      "identity" in request.target
        ? request.target.identity
        : (await input.workspaceTools.$resolve!(request.target, { signal, ...context })).entry
            .identity;
    const describe = async (identity: ToolGatewayIdentity) =>
      await hostJson<ToolGatewaySiteConsentResponse>(
        "site-consent",
        { identity, arguments: request.arguments, ...site },
        signal,
      );
    const consent = await describe(declared);
    if (consent.connect || code === "site_tool_connection_required") {
      if (!consent.connect) throw new SiteToolConsentDeclinedError();
      // Without the connect card here, say what to connect rather than "Cancelled."
      if (!consent.connect.capabilityId || !input.connectForToolCall)
        throw new SiteToolConnectionRequiredError(consent.connect.name);
      if (!(await input.connectForToolCall({ connect: consent.connect, signal })))
        throw new SiteToolConsentDeclinedError();
      signal.throwIfAborted();
      // Connected: run again, asking once more only if the call still needs it.
      try {
        return await invokeOnce(request, signal);
      } catch (error) {
        const next = siteConsentCode(error);
        if (!next || next === "site_tool_connection_required") throw error;
        return await invokeWithConsent(request, signal, next);
      }
    }
    const preselected = consent.selected ?? consent.accounts[0]?.identity ?? declared;
    const resolveRoute = async (identity: ToolGatewayIdentity) =>
      await input.workspaceTools.$resolve!({ identity }, { signal, ...context });
    const preselectedTool = await resolveRoute(preselected);
    const decision = await input.confirmToolCall!({
      tool: preselectedTool,
      arguments: request.arguments,
      accounts: consent.accounts,
      selected: consent.accounts.length > 0 ? preselected : null,
      review: consent.review,
      reviewFor: async (identity) =>
        identityKey(identity) === identityKey(preselected)
          ? consent.review
          : (await describe(identity)).review,
      signal,
    });
    signal.throwIfAborted();
    if (!decision) throw new SiteToolConsentDeclinedError();
    const chosen =
      decision.identity &&
      consent.accounts.some(
        (account) => identityKey(account.identity) === identityKey(decision.identity!),
      )
        ? decision.identity
        : preselected;
    const tool =
      identityKey(chosen) === identityKey(preselected)
        ? preselectedTool
        : await resolveRoute(chosen);
    const routed: ToolGatewayInvokeRequest = {
      target: { identity: chosen },
      operationId: request.operationId,
      arguments: request.arguments,
      expectedDefinitionDigest: tool.definitionDigest,
    };
    let approvalToken: string | undefined;
    try {
      const approval = await hostJson<ToolGatewayTargetApprovalResponse>(
        "target-approvals",
        {
          identity: chosen,
          operationId: request.operationId,
          arguments: request.arguments,
          expectedDefinitionDigest: tool.definitionDigest,
          ...(decision.alwaysAllow ? { rememberForSite: true } : {}),
          ...site,
        } satisfies ToolGatewayTargetApprovalRequest,
        signal,
      );
      approvalToken = approval.approvalToken;
    } catch (error) {
      // Choosing an account was all this call needed.
      if (
        !(
          error instanceof OpenGeniApiError &&
          error.status === 422 &&
          /tool_does_not_require_human_approval/u.test(error.message + error.body)
        )
      )
        throw error;
    }
    return await invokeOnce(routed, signal, approvalToken);
  };
  const invoke = async (request: ToolGatewayInvokeRequest, { signal }: { signal: AbortSignal }) => {
    if (
      allowed &&
      "identity" in request.target &&
      !allowed.has(identityKey(request.target.identity))
    )
      throw new Error("This tool is not available to the Site");
    try {
      return await invokeOnce(request, signal);
    } catch (error) {
      const code = siteConsentCode(error);
      if (!code || !input.confirmToolCall || !input.fetchResponse || !input.artifactId) throw error;
      return await invokeWithConsent(request, signal, code);
    }
  };
  // One shared load serves every concurrent Site request (cancelled only when
  // all of them abort); a stale rejection reloads once for all requests
  // rejected on that digest.
  const projectedCatalog = createSharedCatalogLoader<OpenGeniSiteToolCatalog>(
    async (refresh, signal) => {
      if (targeted && input.requestedTools) {
        const manifest = await input.workspaceTools.$manifest!(
          { identities: [...input.requestedTools], ...context },
          { signal },
        );
        signal.throwIfAborted();
        if (manifests.size >= 4) manifests.delete(manifests.keys().next().value!);
        manifests.set(manifest.digest, manifest.tools);
        return {
          version: 1,
          generation: 1,
          digest: manifest.digest,
          createdAt: new Date().toISOString(),
          entries: manifest.tools.map((tool) => tool.entry),
        };
      }
      const current = await input.workspaceTools.$catalog({
        signal,
        ...(refresh ? { refresh } : {}),
      });
      if (current.workspaceId !== input.workspaceId)
        throw new Error("Site catalog workspace mismatch");
      return {
        version: current.version,
        generation: current.generation,
        digest: current.digest,
        createdAt: current.createdAt,
        entries: current.entries.filter(
          (entry) => !allowed || allowed.has(identityKey(entry.identity)),
        ),
      };
    },
  );
  const loadCatalog = async ({
    signal,
    staleDigest,
  }: {
    signal: AbortSignal;
    staleDigest?: string;
  }): Promise<OpenGeniSiteToolCatalog> => {
    signal.throwIfAborted();
    const catalog =
      staleDigest === undefined
        ? await projectedCatalog.load({ signal })
        : await projectedCatalog.reloadAfterStale(staleDigest, signal);
    signal.throwIfAborted();
    return catalog;
  };
  return {
    ...(targeted ? { resolve, invoke } : {}),
    ...(input.fetchResponse && input.artifactId ? { siteData: true } : {}),
    ...(input.fetchResponse
      ? {
          fetch: async (message: SiteHttpRequest, signal: AbortSignal) => {
            const path = siteSessionPath(
              message.path,
              input.workspaceId,
              message.method,
              input.artifactId,
            );
            // Site code sends message text, not approvals, answers, resources,
            // credentials or connection choices. The API refuses them too.
            const refused = siteFrameBodyFieldRefusal(path, message, input);
            if (refused) return refused;
            const headers = siteRequestHeaders(message.headers);
            // Host-set marker: the API treats every bridged request as a Site frame,
            // limited to SITE_OPERATIONS and to this frame's own sessions.
            headers.set(SITE_FRAME_HEADER, "1");
            headers.set(SITE_FRAME_ID_HEADER, frameId);
            if (input.artifactId) {
              headers.set(SITE_ID_HEADER, input.artifactId);
              headers.set(SITE_VERSION_HEADER, input.siteVersionId);
            }

            return input.fetchResponse!(path, {
              method: message.method,
              signal,
              headers: Object.fromEntries(headers),
              ...(message.body === undefined ? {} : { body: message.body }),
            });
          },
        }
      : {}),
    catalog: async ({ signal }) => await loadCatalog({ signal }),
    call: async (request, { signal }) => {
      if (allowed && !allowed.has(identityKey(request.identity)))
        throw new Error("This tool is not available to the Site");
      if (targeted && input.requestedTools) {
        const tool = manifests
          .get(request.catalogDigest)
          ?.find(
            (candidate) => identityKey(candidate.entry.identity) === identityKey(request.identity),
          );
        if (!tool)
          throw new OpenGeniApiError(
            409,
            JSON.stringify({
              error: { code: "conflict", details: { code: "catalog_stale" }, retryable: true },
            }),
          );
        try {
          const response = await invoke(
            {
              operationId: request.operationId ?? crypto.randomUUID(),
              target: { identity: request.identity },
              arguments: request.arguments,
              expectedDefinitionDigest: tool.definitionDigest,
            },
            { signal },
          );
          return {
            operationId: response.operationId,
            catalogDigest: request.catalogDigest,
            result: legacySiteToolResult(response.result),
          };
        } catch (error) {
          if (
            error instanceof OpenGeniApiError &&
            error.retryable !== false &&
            !error.outcomeUnknown &&
            error.details?.code === "tool_definition_stale"
          ) {
            projectedCatalog.invalidate(request.catalogDigest);
            manifests.delete(request.catalogDigest);
            throw new OpenGeniApiError(
              409,
              JSON.stringify({
                error: {
                  code: "catalog_stale",
                  details: { code: "catalog_stale" },
                  retryable: true,
                },
              }),
            );
          }
          throw error;
        }
      }
      let usedDigest: string | undefined;
      const call = async (staleDigest?: string) => {
        const catalog = await loadCatalog({
          signal,
          ...(staleDigest === undefined ? {} : { staleDigest }),
        });
        usedDigest = catalog.digest;
        if (
          !catalog.entries.some(
            (entry) => identityKey(entry.identity) === identityKey(request.identity),
          )
        )
          throw new Error("This requested tool is not enabled in the workspace");
        const response = await input.callTool({
          workspaceId: input.workspaceId,
          signal,
          request: {
            ...(request.operationId ? { operationId: request.operationId } : {}),
            catalogDigest: catalog.digest,
            identity: request.identity,
            arguments: request.arguments,
            ...(input.artifactId
              ? { siteArtifactId: input.artifactId, siteVersionId: input.siteVersionId }
              : {}),
          },
        });
        return { ...response, result: legacySiteToolResult(response.result) };
      };
      try {
        return await call();
      } catch (error) {
        // Only pre-execution catalog rejection permits one retry. Never retry
        // transport failures, expired credentials or uncertain tool effects.
        if (
          staleRetryVetoed(error) ||
          !(input.isCatalogStale ?? isSiteCatalogStaleError)(error) ||
          usedDigest === undefined
        )
          throw error;
        return await call(usedDigest);
      }
    },
  };
}

/** Saved Site bundles may treat a provider's error.code as retry authorization.
 * An executed result is data, never a pre-execution control signal. Only wrap
 * colliding error results on the legacy call path; keep the original diagnostic
 * intact and do not project request arguments, tokens, or host credentials. */
function legacySiteToolResult(
  result: ToolGatewayCallResponse["result"],
): ToolGatewayCallResponse["result"] {
  if (!result?.isError) return result;
  const structured = result.structuredContent;
  const error = structured?.error;
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    (error.code !== "catalog_stale" && error.code !== "tool_definition_stale")
  )
    return result;
  return {
    ...result,
    structuredContent: {
      ...structured,
      error: {
        code: "site_tool_execution_failed",
        message:
          "message" in error && typeof error.message === "string"
            ? error.message
            : "Site tool execution failed",
        retryable: false,
        outcomeUnknown: "outcomeUnknown" in error && error.outcomeUnknown === true,
        providerError: error,
      },
    },
  };
}

export function isSiteCatalogStaleError(error: unknown): boolean {
  return (
    !staleRetryVetoed(error) &&
    error instanceof OpenGeniApiError &&
    error.status === 409 &&
    error.details?.code === "catalog_stale"
  );
}
function staleRetryVetoed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("outcomeUnknown" in error && error.outcomeUnknown === true) ||
      ("retryable" in error && error.retryable === false))
  );
}
function identityKey(identity: ToolGatewayIdentity): string {
  return `${identity.serverId}\u0000${identity.toolName}`;
}

/** A 403 like the API's for a body field Site code may not send, or null. */
function siteFrameBodyFieldRefusal(
  path: string,
  message: SiteHttpRequest,
  input: { workspaceId: string; artifactId?: string | undefined },
): Response | null {
  if (typeof message.body !== "string" || message.method === "GET") return null;
  const operation = siteFrameOperation(
    message.method,
    path.split("?")[0]!,
    input.workspaceId,
    input.artifactId ?? null,
  );
  if (!operation) return null;
  let body: unknown;
  try {
    body = JSON.parse(message.body);
  } catch {
    return null;
  }
  const field = siteFrameBodyRefusal(operation.operation.id, operation.suffix, body);
  if (!field) return null;
  return Response.json(
    {
      error: {
        status: 403,
        code: "forbidden",
        message:
          "A Site page can send message text only. Approvals, answers, resources, credentials and connection choices happen in the console.",
        retryable: false,
        details: { code: "site_frame_field_forbidden", field },
      },
    },
    { status: 403 },
  );
}
