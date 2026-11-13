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

/**
 * A tool the pinned Site declares that this viewer can neither use nor connect
 * from here (for example another member's account the Site was published
 * with). The Site receives this code and the server's explanation instead of a
 * bare unavailable tool.
 */
function siteToolNotAvailableForViewer(error: unknown): unknown {
  if (
    !(error instanceof OpenGeniApiError) ||
    error.details?.code !== "site_tool_not_available_for_viewer"
  )
    return error;
  const decoded = (() => {
    try {
      const body = JSON.parse(error.body) as { error?: { message?: unknown } };
      return typeof body.error?.message === "string" ? body.error.message : null;
    } catch {
      return null;
    }
  })();
  return Object.assign(new Error(decoded ?? "This tool isn't available to you on this Site."), {
    name: "SiteToolNotAvailableForViewerError",
    code: "site_tool_not_available_for_viewer",
    retryable: false,
    outcomeUnknown: false,
  });
}

/** A refusal the bridge makes itself, before anything is sent: nothing ran. */
function siteToolRefusal(message: string, code: string, retryable: boolean): Error {
  return Object.assign(new Error(message), { code, retryable, outcomeUnknown: false });
}
/** The Site calls a tool its pinned version doesn't declare. */
const undeclaredTool = () =>
  siteToolRefusal("This tool is not available to the Site", "site_tool_not_declared", false);

/**
 * Why a Site's tool call didn't complete, as the viewer and Site code see it.
 * Site code reads the same `code` on the error (or on the result's
 * `structuredContent.error` for a provider's refusal).
 * - `site_tool_reconnect_required`: the viewer's connection must sign in again.
 * - `site_tool_permission_denied`: the provider refused it for the viewer's account.
 * - `site_tool_not_available_for_viewer`: the Site's tool can't run for this viewer.
 * - `site_tool_outcome_unknown`: it may have run; check before trying again.
 * - `site_tool_unavailable`: anything else that stopped it.
 */
export type SiteToolFailureCode =
  | "site_tool_reconnect_required"
  | "site_tool_permission_denied"
  | "site_tool_not_available_for_viewer"
  | "site_tool_outcome_unknown"
  | "site_tool_unavailable";
export type SiteToolFailure = {
  code: SiteToolFailureCode;
  /** The system the tool belongs to ("Microsoft Dynamics"), when known. */
  system: string | null;
  /** One plain sentence for the viewer; never an HTTP status or internal code. */
  message: string;
  /** The viewer's own connection to sign in again, for `site_tool_reconnect_required`. */
  reconnect: {
    connectionId: string;
    capabilityId: string;
    name: string;
    /** Shared with the workspace rather than the viewer's own. */
    shared: boolean;
  } | null;
  /**
   * Running it again is safe and may help: only after a refusal Opengeni
   * confirms ran nothing. False for definitive refusals and unknown outcomes.
   */
  retryable: boolean;
  /** The original error, for logs or a details toggle; not for the viewer's main text. */
  detail: string;
  /** The original error's code (`not_found`, `tool_connection_needs_attention`, ...), when it had one. */
  sourceCode: string | null;
};
export type SiteToolFailurePrompt = { failure: SiteToolFailure; signal: AbortSignal };

/**
 * A Site tool call that stopped; `code` says why (see `SiteToolFailureCode`).
 * `details.code` keeps the original error's code for Site code that checks it.
 */
export class SiteToolCallFailedError extends Error {
  readonly code: SiteToolFailureCode;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  readonly system: string | null;
  readonly detail: string;
  readonly details: { code?: string };
  constructor(failure: SiteToolFailure) {
    super(failure.message);
    this.name = "SiteToolCallFailedError";
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.outcomeUnknown = failure.code === "site_tool_outcome_unknown";
    this.system = failure.system;
    this.detail = failure.detail;
    this.details = failure.sourceCode ? { code: failure.sourceCode } : {};
  }
}

/** Codes the bridge passes through unchanged: SDK control flow or an answer already typed. */
const SITE_TOOL_PASSTHROUGH_CODES = new Set([
  "catalog_stale",
  "tool_definition_stale",
  "tool_reapproval_required",
  "site_tool_consent_declined",
  "site_tool_connection_required",
  // Without the host's confirmation, the Site still learns what the call needs.
  "tool_gateway_approval_required",
  "site_tool_account_required",
]);

type SiteToolFailureKind = Pick<SiteToolFailure, "code" | "retryable" | "detail"> & {
  /** Opengeni's own explanation for the viewer, when the server gave one. */
  message?: string;
  sourceCode?: string | null;
};

function errorCodes(error: unknown): { code: unknown; nested: unknown } {
  if (typeof error !== "object" || error === null) return { code: undefined, nested: undefined };
  const candidate = error as { code?: unknown; details?: { code?: unknown } | undefined };
  return { code: candidate.code, nested: candidate.details?.code };
}

/**
 * How a thrown Site tool error reaches the viewer, or null to pass it through.
 * Try again is offered only for a refusal Opengeni confirms ran nothing (a 4xx
 * answer, or the bridge's own refusal) that isn't definitive. A dropped
 * connection, a 5xx or an untyped error on a call that `executes` may have
 * run, so it is `site_tool_outcome_unknown` and is never run again.
 */
export function siteToolFailureKind(
  error: unknown,
  options: { executes?: boolean } = {},
): SiteToolFailureKind | null {
  if (error instanceof SiteToolCallFailedError) return null;
  if (error instanceof Error && error.name === "AbortError") return null;
  const { code, nested } = errorCodes(error);
  if (
    SITE_TOOL_PASSTHROUGH_CODES.has(String(code)) ||
    SITE_TOOL_PASSTHROUGH_CODES.has(String(nested))
  )
    return null;
  const detail = error instanceof Error ? error.message : String(error);
  const sourceCode = typeof nested === "string" ? nested : typeof code === "string" ? code : null;
  const source = (typeof error === "object" && error !== null ? error : {}) as {
    status?: unknown;
    retryable?: unknown;
    outcomeUnknown?: unknown;
  };
  const kind = (
    failure: SiteToolFailureCode,
    retryable: boolean,
    message?: string,
  ): SiteToolFailureKind => ({
    code: failure,
    retryable,
    detail,
    sourceCode,
    ...(message === undefined ? {} : { message }),
  });
  if (source.outcomeUnknown === true) return kind("site_tool_outcome_unknown", false);
  if (nested === "tool_connection_needs_attention" || code === "connection_auth_needed")
    return kind("site_tool_reconnect_required", false);
  // These change only when the Site is published again.
  if (code === "site_tool_not_available_for_viewer")
    // Already the server's own explanation (see siteToolNotAvailableForViewer).
    return kind("site_tool_not_available_for_viewer", false, detail);
  if (nested === "site_tool_not_available_for_viewer" || code === "site_tool_not_declared")
    return kind("site_tool_not_available_for_viewer", false);
  const status = typeof source.status === "number" ? source.status : null;
  const refused = status === null ? source.outcomeUnknown === false : status >= 400 && status < 500;
  // A missing route can appear (the viewer connects elsewhere); other refusals
  // keep their own retryable (false for site_tool_not_authorized or a 400).
  if (refused) return kind("site_tool_unavailable", source.retryable === true || status === 404);
  if (options.executes !== false) return kind("site_tool_outcome_unknown", false);
  return kind("site_tool_unavailable", true);
}

/** A tool result the provider refused in a way the viewer can act on, or null. */
function siteToolResultFailureKind(
  result: ToolGatewayCallResponse["result"] | undefined,
): SiteToolFailureKind | null {
  if (!result?.isError) return null;
  const error = (result.structuredContent as { error?: { code?: unknown; message?: unknown } })
    ?.error;
  const detail = typeof error?.message === "string" ? error.message : "";
  const sourceCode = typeof error?.code === "string" ? error.code : null;
  if (error?.code === "connection_auth_needed")
    return { code: "site_tool_reconnect_required", retryable: false, detail, sourceCode };
  if (error?.code === "provider_permission_denied")
    return { code: "site_tool_permission_denied", retryable: false, detail, sourceCode };
  return null;
}

/** The viewer's sentence for a failure; it names the system when known. */
export function siteToolFailureMessage(code: SiteToolFailureCode, system: string | null): string {
  switch (code) {
    case "site_tool_reconnect_required":
      return system ? `Sign in to ${system} again to continue.` : "Sign in again to continue.";
    case "site_tool_permission_denied":
      return system
        ? `${system} didn't allow this for your account.`
        : "This wasn't allowed for your account.";
    case "site_tool_not_available_for_viewer":
      return "This isn't available to you on this Site.";
    case "site_tool_outcome_unknown":
      return system
        ? `Couldn't confirm this finished. Check ${system} before trying again.`
        : "Couldn't confirm this finished. Check before trying again.";
    case "site_tool_unavailable":
      return system ? `Couldn't get this from ${system}.` : "This didn't work.";
  }
}

/**
 * The same error result, unchanged for Site code that reads the provider's
 * error, plus the viewer's typed code and sentence in `siteToolFailure`.
 */
function siteToolFailureResult(
  result: NonNullable<ToolGatewayCallResponse["result"]>,
  failure: SiteToolFailure,
): ToolGatewayCallResponse["result"] {
  return {
    ...result,
    structuredContent: {
      ...(result.structuredContent ?? {}),
      siteToolFailure: {
        code: failure.code,
        message: failure.message,
        system: failure.system,
        retryable: false,
      },
    },
  };
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
  /**
   * Host UI for a call that didn't complete: Reconnect, a plain refusal, or
   * Retry. Resolve true to run the call again (after Retry or a reconnect).
   * Without it the Site still receives the typed `SiteToolCallFailedError`.
   */
  recoverToolCall?: (prompt: SiteToolFailurePrompt) => Promise<boolean>;
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
      throw undeclaredTool();
    let tool: ToolGatewayResolvedTool;
    try {
      tool = await input.workspaceTools.$resolve!(request.target, { signal, ...context });
    } catch (error) {
      throw siteToolNotAvailableForViewer(error);
    }
    // A declared connector tool resolves to the viewer's own account route,
    // which the server derived from this pinned version: the same tool name.
    if (
      allowed &&
      !allowed.has(identityKey(tool.entry.identity)) &&
      ("identity" in request.target
        ? tool.entry.identity.toolName !== request.target.identity.toolName
        : !allowedTools.has(tool.entry.identity.toolName))
    )
      throw undeclaredTool();
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
      throw undeclaredTool();
    try {
      return await invokeOnce(request, signal);
    } catch (error) {
      const code = siteConsentCode(error);
      if (!code || !input.confirmToolCall || !input.fetchResponse || !input.artifactId)
        throw siteToolNotAvailableForViewer(error);
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
  const bridge: SiteToolBridge = {
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
      if (allowed && !allowed.has(identityKey(request.identity))) throw undeclaredTool();
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
          throw siteToolRefusal(
            "This requested tool is not enabled in the workspace",
            "tool_unavailable",
            true,
          );
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
  // Every call that stops reaches the viewer as a clear state and the Site as
  // a typed code, never a raw status or internal error string.
  const describeFailure = async (
    identity: ToolGatewayIdentity | null,
    kind: SiteToolFailureKind,
    signal: AbortSignal,
  ): Promise<SiteToolFailure> => {
    let system: string | null = null;
    let reconnect: SiteToolFailure["reconnect"] = null;
    if (identity && input.fetchResponse && input.artifactId) {
      try {
        const consent = await hostJson<ToolGatewaySiteConsentResponse>(
          "site-consent",
          { identity, siteArtifactId: input.artifactId, siteVersionId: input.siteVersionId },
          signal,
        );
        const selected = consent.selected;
        const account =
          consent.accounts.find(
            (candidate) => selected && identityKey(candidate.identity) === identityKey(selected),
          ) ?? (consent.accounts.length === 1 ? consent.accounts[0] : undefined);
        system =
          account?.connector ?? consent.accounts[0]?.connector ?? consent.connect?.name ?? null;
        if (
          kind.code === "site_tool_reconnect_required" &&
          account?.connectionId &&
          account.capabilityId
        )
          reconnect = {
            connectionId: account.connectionId,
            capabilityId: account.capabilityId,
            name: account.connector,
            shared: account.shared === true,
          };
      } catch {
        // Naming the system is best effort; the failure itself still reaches the viewer.
      }
    }
    return {
      ...kind,
      sourceCode: kind.sourceCode ?? null,
      system,
      reconnect,
      message: kind.message ?? siteToolFailureMessage(kind.code, system),
    };
  };
  /**
   * Runs `run` and, when it stops, asks the host what to do. `run(true)` after
   * a reconnect: Opengeni refused the call before dispatch because the
   * connection had to sign in again, so the provider never received it, and
   * it runs as a new operation (the first one's approval is spent). A tool
   * result asking to sign in again is the provider's own output and may come
   * after it acted, so Reconnect is offered but the call is not run again:
   * the Site gets the result and calls again itself. Try again reuses the
   * same operation.
   */
  const recovering = async <T>(
    identity: ToolGatewayIdentity | null,
    signal: AbortSignal,
    executes: boolean,
    run: (reconnected: boolean) => Promise<T>,
  ): Promise<T> => {
    let reconnected = false;
    for (let attempt = 1; ; attempt += 1) {
      let kind: SiteToolFailureKind | null;
      let value: T | undefined;
      let thrown: unknown;
      try {
        value = await run(reconnected);
        kind = siteToolResultFailureKind(resultOf(value));
        if (!kind) return value;
      } catch (error) {
        kind = siteToolFailureKind(error, { executes });
        if (!kind || signal.aborted) throw error;
        thrown = error;
      }
      const failure = await describeFailure(identity, kind, signal);
      signal.throwIfAborted();
      const again =
        attempt < SITE_TOOL_RECOVERY_ATTEMPTS && input.recoverToolCall
          ? await input.recoverToolCall({ failure, signal }).catch(() => false)
          : false;
      signal.throwIfAborted();
      if (again && failure.reconnect && value === undefined) {
        reconnected = true;
        continue;
      }
      if (again && failure.retryable && value === undefined) continue;
      if (value === undefined)
        throw Object.assign(new SiteToolCallFailedError(failure), { cause: thrown });
      return { ...value, result: siteToolFailureResult(resultOf(value)!, failure) } as T;
    }
  };
  const resultOf = (value: unknown): ToolGatewayCallResponse["result"] | undefined =>
    typeof value === "object" && value !== null && "result" in value
      ? (value as { result?: ToolGatewayCallResponse["result"] }).result
      : undefined;
  const declaredIdentity = (target: ToolGatewayInvokeRequest["target"]) =>
    "identity" in target ? target.identity : null;
  const { resolve: bridgeResolve, invoke: bridgeInvoke, call: bridgeCall } = bridge;
  return {
    ...bridge,
    ...(bridgeResolve
      ? {
          resolve: async (request: ToolGatewayResolveRequest, options: { signal: AbortSignal }) =>
            await recovering(declaredIdentity(request.target), options.signal, false, () =>
              bridgeResolve(request, options),
            ),
        }
      : {}),
    ...(bridgeInvoke
      ? {
          invoke: async (request: ToolGatewayInvokeRequest, options: { signal: AbortSignal }) => {
            let operationId = request.operationId;
            return await recovering(
              declaredIdentity(request.target),
              options.signal,
              true,
              (reconnected) => {
                if (reconnected) operationId = crypto.randomUUID();
                return bridgeInvoke({ ...request, operationId }, options);
              },
            );
          },
        }
      : {}),
    call: async (request, options) => {
      // One operation for every attempt, so a rerun is never a second call.
      let operationId = request.operationId ?? crypto.randomUUID();
      return await recovering(request.identity, options.signal, true, (reconnected) => {
        if (reconnected) operationId = crypto.randomUUID();
        return bridgeCall({ ...request, operationId }, options);
      });
    },
  };
}

/** Times a call runs in all: the first, then at most two after Retry or a reconnect. */
const SITE_TOOL_RECOVERY_ATTEMPTS = 3;

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
