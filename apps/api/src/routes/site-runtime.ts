import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ReasoningEffort,
  LatencyMode,
  DeleteSessionQueueItemRequest,
  EditSessionQueueItemRequest,
  matchSiteOperation,
  MoveSessionQueueItemRequest,
  SaveComposerDraftRequest,
  SessionControlRequest,
  SiteAbuseReportRequest,
  SiteAuthExchangeRequest,
  SiteDataFileScope,
  SiteDataGetRequest,
  SiteDataQueryRequest,
  SiteDataWriteRequest,
  SiteSqlRunRequest,
  SiteViewAs,
  type SiteLimitProfileKind,
  SITE_GATEWAY_CALLBACK_PATH,
  SITE_RUNTIME_API_PREFIX,
  SITE_TOOL_METHODS,
  SteerSessionQueueItemRequest,
  SubmitComposerDraftRequest,
  ToolGatewayCallRequest,
  ToolGatewayResolveRequest,
  ToolGatewayInvokeRequest,
  type Permission,
  type SiteAuthExchangeResponse,
  type SiteEmbeddedAgent,
  type SiteRuntimeConfig,
  type ToolRef,
} from "@opengeni/contracts";
import {
  cancelPublishedSiteSession,
  withHostSessionUsageLimit,
  withSiteSessionOrigin,
  admissibleWorkspaceModel,
  loadWorkspaceModelSelectionInput,
  resolveWorkspaceModelSelection,
  hasPermission,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  consumeSiteAuthCode,
  finishSiteRuntimeAdmission,
  withSiteRuntimeAdmission,
  withSiteViewerRlsContext,
  createSiteAbuseReport,
  getSiteWorkspaceMemberPermissions,
  readSitePlatformUsage,
  recordSitePlatformRequests,
  setSiteViewerSessionViewAs,
  createSiteViewerSession,
  getOwnedSiteRuntimeConversation,
  getServableSiteVersion,
  getPublishedSiteVersion,
  getSession,
  isSiteWorkspaceMember,
  listOwnedSiteRuntimeConversations,
  listSessionEvents,
  releaseSiteRuntimeConversationStart,
  reserveSiteRuntimeConversationStart,
  reserveSiteRuntimeConversationWork,
  revokeSiteViewerSession,
  SiteDataError,
  SITE_RUNTIME_SITE_PRINCIPAL,
  type SiteRuntimeReservation,
  type SiteRuntimeConversationRecord,
} from "@opengeni/db";
import {
  SITE_AGENT_DATA_TOOL_PERMISSIONS,
  siteAgentDataToolsForStart,
  siteAgentInstructions,
  sitePublishedDataViewer,
} from "../site-publishing/agent-data-tools";
import {
  normalizeSiteAgentSession,
  SITE_AGENT_DEFAULTS_VERSION,
} from "../site-publishing/agent-session";
import {
  isSubscriptionBilledModel,
  resolveSiteOutsideModel,
  siteCreditModelIds,
} from "../site-publishing/agent-model";
import {
  afterSitePlatformUsage,
  requireSitePlatformOpen,
  sitePlatformBrakeEngaged,
} from "../site-publishing/platform-usage";
import { SiteSqlError } from "../site-sql/service";
import {
  authorizePublishedSiteTools,
  publishedSiteToolAuthority,
} from "../site-publishing/page-tool-authority";
import {
  callWorkspaceToolGateway,
  prepareWorkspaceToolGateway,
  requireWorkspaceSiteToolAuthorization,
  workspaceToolGatewayDeclarations,
} from "../workspace-tool-gateway";
import { invokeWorkspaceToolTarget, resolveWorkspaceToolTarget } from "../workspace-tool-target";
import { withSiteSecretContext } from "../workspace-tool-gateway-secrets";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { markLocalInternalDispatch } from "../http/local-browser-boundary";
import { USER_CONTENT_SECURITY_HEADERS } from "../http/user-content";
import {
  getSiteDataFileUrl,
  getSiteDataRecord,
  listSiteDataFiles,
  querySiteData,
  uploadSiteDataFile,
  writeSiteData,
  deleteSiteDataFile,
} from "../site-data/operations";
import type { PublishedSiteDataViewer } from "../site-data/service";
import {
  sameSha256Hex,
  verifySiteGatewayRequest,
  type SiteGatewayFields,
} from "../site-publishing/gateway-signature";
import {
  capSiteConversationUsageLimit,
  liftSiteConversationUsageLimit,
  enforceSiteRuntimeRate,
  enforceSiteRuntimeViewerRate,
  findSiteRuntimeHost,
  meterSiteRuntime,
  requireServedSiteRuntimeHost,
  requireSiteAgent,
  resolveSiteRuntimeViewer,
  settleSiteRuntimeSpend,
  sha256Text,
  siteReservationRefused,
  siteClientAddressPrincipal,
  siteNotAvailableForViewer,
  siteRuntimeBudgetKey,
  siteRuntimeBudgetLimits,
  siteViewerCapabilities,
  siteRuntimeForwardedResponse,
  siteRuntimeLimitProfile,
  siteRuntimeSessionRequest,
  siteWideBudget,
  sweepSiteRuntimeReservations,
  type SiteRuntimeHost,
} from "../site-publishing/runtime";
import {
  configuredSitesDomain,
  healSiteEdgeIfStale,
  notifySiteAbuse,
  setSitePublishingCancellation,
  siteHostMapRecord,
  sitePublishingError,
} from "../site-publishing/service";
import {
  siteSessionEventPage,
  siteSessionEventPageResponse,
  siteSessionEventStreamResponse,
  SITE_VISIBLE_SESSION_EVENT_TYPES,
} from "../site-publishing/session-events";
import {
  siteAcceptedEventView,
  siteAcceptedMessageView,
  siteControlResultView,
  siteControlView,
  siteDraftView,
  siteHumanInputListView,
  siteHumanInputRequestView,
  siteQueueMutationView,
  siteQueueView,
} from "../site-publishing/session-views";
import {
  effectiveSiteAccess,
  publicSiteViewer,
  signedInSiteViewerKind,
  type SiteRuntimeViewer,
} from "../site-publishing/viewer";
import { runSiteSqlQuery } from "../site-sql/service";
import { siteDataHttpError } from "./site-data";
import { runSiteSqlRoute } from "./site-sql";

/**
 * `/v1/site-runtime/*`: the API a Site gateway calls for one published Site
 * host. Nothing else may call it: every request must carry a fresh gateway
 * signature over its method, host, path, body and viewer headers, and must
 * not carry Opengeni credentials. The signature is checked before anything
 * else; then the host names exactly one Site, the viewer is resolved for it,
 * and only the operations in `SITE_OPERATIONS` (plus the gateway's own host,
 * version, sign-in and report calls) are served.
 */

/** Sign-in exchanges one client address may attempt per minute (per Site). */
const EXCHANGES_PER_MINUTE = 30;
/** Abuse reports one Site accepts per minute from everyone together. */
const SITE_REPORTS_PER_MINUTE = 60;
/** Conversations a viewer's list shows. */
const LIST_LIMIT = 20;
const MESSAGE_MAX_CHARS = 20_000;
/** Request bodies site-runtime reads at most (the gateway enforces the same caps). */
export const SITE_RUNTIME_JSON_BODY_LIMIT = 4 * 1024 * 1024;
export const SITE_RUNTIME_FILE_BODY_LIMIT = 25 * 1024 * 1024;
const FILE_UPLOAD_SUFFIX = "/published-artifacts/current/files";
/** SHA-256 of the empty body: what the gateway signs for GET and HEAD. */
const EMPTY_BODY_SHA256 = createHash("sha256").digest("hex");
/** A version a publish or rollback replaced is still served this long (open pages keep loading). */
export const SITE_VERSION_GRACE_SECONDS = 600;

/** The document policy for a published version: scripts in an opaque origin, framed only by its own shell. */
export const SITE_VERSION_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals; frame-ancestors 'self'";

const VersionId = z.string().uuid();
const ClientEventId = z.string().min(1).max(200).optional();
const CreateConversationRequest = z
  .object({
    initialMessage: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
    idempotencyKey: z.string().min(1).max(200).optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: ReasoningEffort.optional(),
    latencyMode: LatencyMode.optional(),
  })
  .passthrough();
const SendMessageRequest = z
  .object({
    type: z.literal("user.message"),
    clientEventId: ClientEventId,
    payload: z.object({ text: z.string().trim().min(1).max(MESSAGE_MAX_CHARS) }).passthrough(),
  })
  .passthrough();
const SteerRequest = z
  .object({
    text: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
    clientEventId: ClientEventId,
  })
  .passthrough();
const SessionMcpServerIdPattern = /^[A-Za-z0-9_-]{1,200}$/u;

function invalid(message: string) {
  return sitePublishingError(400, "validation_failed", "site_invalid_request", message);
}

function unsupported() {
  return sitePublishingError(
    404,
    "not_found",
    "site_operation_unsupported",
    "This operation is not available to published Sites",
  );
}

function parseJson<S extends z.ZodType>(bytes: Uint8Array, schema: S): z.infer<S> {
  let value: unknown = null;
  try {
    value = bytes.byteLength === 0 ? null : JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalid("The request body must be JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw invalid(
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
        .join("; "),
    );
  return parsed.data;
}

/**
 * Site Data for a viewer: what the viewer's audience may not use answers
 * `not_available_for_viewer`; other refusals (a record the viewer does not
 * own, a manager-only write) keep their Site Data code.
 */
async function runSiteData<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof SiteDataError &&
      error.code === "forbidden" &&
      error.details.reason === "guest_access"
    )
      throw siteNotAvailableForViewer("site_data", error.message, error.details);
    if (error instanceof SiteDataError) throw siteDataHttpError(error);
    throw error;
  }
}

/** Site SQL for a viewer: refusals for this viewer answer `not_available_for_viewer`. */
async function runSiteSqlForViewer<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SiteSqlError && error.code === "forbidden")
      throw siteNotAvailableForViewer("site_sql", error.message, error.details);
    throw error;
  }
}

/** Hosts of one gateway platform report recorded at a time. */
const SITE_PLATFORM_REPORT_CONCURRENCY = 8;

/** POST /v1/site-runtime/platform/requests (gateway only, signed on the Sites apex). */
const SitePlatformRequestReport = z.object({
  v: z.literal(1),
  reportId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u),
  hosts: z
    .array(
      z.object({
        host: z.string().min(1).max(253),
        requests: z.number().int().positive().max(1_000_000_000),
      }),
    )
    .min(1)
    .max(500),
});

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function tooLarge(limit: number) {
  return sitePublishingError(
    413,
    "limit_exceeded",
    "site_request_too_large",
    "This request body is too large",
    { limitBytes: limit },
  );
}

/**
 * Read a request body of at most `limit` bytes, hashing it as it arrives: a
 * larger declared length is refused before reading, and the stream is cut
 * off once it passes the cap.
 */
async function readCappedBody(
  request: Request,
  limit: number,
): Promise<{ body: Uint8Array; sha256: string }> {
  const hash = createHash("sha256");
  const declared = request.headers.get("content-length")?.trim();
  if (declared && (!/^\d{1,15}$/u.test(declared) || Number(declared) > limit))
    throw tooLarge(limit);
  if (!request.body) return { body: new Uint8Array(), sha256: hash.digest("hex") };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(limit);
      }
      hash.update(value);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, sha256: hash.digest("hex") };
}

/** Fields of a session a Site viewer sees: the conversation, not the workspace behind it. */
const SITE_SESSION_FIELDS = [
  "id",
  "status",
  "title",
  "titleSource",
  "initialMessage",
  "model",
  "reasoningEffort",
  "latencyMode",
  "parentSessionId",
  "activeTurnId",
  "initialTurnId",
  "lastSequence",
  "queueVersion",
  "queueHeadPosition",
  "queueTailPosition",
  "effectiveControl",
  "inputWait",
  "activelyWorking",
  "requiresActionSince",
  "createdAt",
  "updatedAt",
] as const;
const SITE_USAGE_LIMIT_FIELDS = [
  "basis",
  "rootSessionId",
  "inherited",
  "status",
  "limitMicros",
  "usedMicros",
  "coverage",
] as const;

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in value) out[key] = value[key];
  return out;
}

/**
 * The Site-safe projection of a session: no account or workspace ids,
 * instructions, tools or policies, metadata, creator, sandbox or diagnostics.
 */
export function siteSessionProjection(session: unknown): Record<string, unknown> {
  if (!session || typeof session !== "object" || Array.isArray(session)) return {};
  const value = session as Record<string, unknown>;
  const projected = pick(value, SITE_SESSION_FIELDS);
  if ("effectiveControl" in projected)
    projected.effectiveControl = siteControlView(projected.effectiveControl);
  const usage = value.usageLimit;
  if (usage && typeof usage === "object" && !Array.isArray(usage))
    projected.usageLimit = pick(usage as Record<string, unknown>, SITE_USAGE_LIMIT_FIELDS);
  return projected;
}

/**
 * Query parameters a Site viewer may pass to an event page (anything else is
 * dropped). Class filters and `latest` are not offered: they select hidden
 * event types by class, and the Site projection hides those anyway.
 */
const EVENT_QUERY = ["after", "before", "direction", "excludeTypes", "compact"] as const;
/** Monitoring-read page sizes: the default, and the most one page returns. */
const SITE_EVENT_PAGE_DEFAULT = 40;
const SITE_EVENT_PAGE_MAX = 500;

function allowedQuery(url: URL, names: readonly string[], extra: Record<string, string> = {}) {
  const params = new URLSearchParams();
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null) params.set(name, value);
  }
  for (const [name, value] of Object.entries(extra)) params.set(name, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * The workspace tools a Site conversation gets: the OVERLAP of what the Site
 * declares (its admin-chosen MCP connections) and what the viewer may do in
 * the workspace. Only workspace members who may attach MCP connections to
 * their own sessions (`mcp_servers:attach`, or workspace admins) get them.
 * People outside the workspace (invited people and public visitors, signed in
 * or anonymous) never get workspace tools: only the Site's own data and the
 * page. There is no setting that changes this; `guestTools` is ignored.
 * Optional references: a connection the workspace does not have is skipped
 * rather than failing the conversation.
 */
export function siteAgentToolRefs(
  agent: Pick<SiteEmbeddedAgent, "tools">,
  viewer: Pick<SiteRuntimeViewer, "kind">,
  memberPermissions: readonly string[] | null = null,
): ToolRef[] {
  const toolIds = siteViewerGetsTools(viewer, memberPermissions) ? (agent.tools ?? []) : [];
  return toolIds
    .filter((tool) => SessionMcpServerIdPattern.test(tool))
    .map((tool) => ({ kind: "mcp", id: tool, optional: true }));
}

/** Only workspace members who may use MCP connections get the Site's tools. */
export function siteViewerGetsTools(
  viewer: Pick<SiteRuntimeViewer, "kind">,
  memberPermissions: readonly string[] | null,
): boolean {
  if (viewer.kind !== "member" || !memberPermissions) return false;
  return (
    memberPermissions.includes("mcp_servers:attach") ||
    memberPermissions.includes("workspace:admin")
  );
}

/** A session id derived from the viewer's create idempotency key (same key, same conversation). */
function idempotentSessionId(seed: string): string {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type RuntimeRequest = {
  context: Context;
  url: URL;
  method: string;
  suffix: string;
  body: Uint8Array;
  fields: SiteGatewayFields;
  domain: string;
};

export function registerSiteRuntimeRoutes(app: Hono, deps: ApiRouteDeps): void {
  const dispatch = async (request: Request): Promise<Response> =>
    await app.fetch(markLocalInternalDispatch(request));
  // Lifecycle cancellation is a native internal command, never viewer dispatch.
  setSitePublishingCancellation(deps.settings, (input) => cancelPublishedSiteSession(deps, input));

  const handler = async (context: Context): Promise<Response> => {
    const domain = configuredSitesDomain(deps.settings);
    if (!domain || !deps.settings.sitesGatewaySecret)
      throw sitePublishingError(
        404,
        "not_found",
        "sites_publishing_disabled",
        "Publishing Sites is not enabled on this deployment",
      );
    const url = new URL(context.req.url);
    const method = context.req.method.toUpperCase();
    const secrets = [deps.settings.sitesGatewaySecret, deps.settings.sitesGatewaySecretPrevious];
    const refuse = (reason: string) =>
      sitePublishingError(
        401,
        "unauthenticated",
        "site_gateway_signature_invalid",
        "This request was not signed by the Site gateway",
        { reason },
      );
    // The gateway signature first: nothing about the request is trusted before
    // it. It is checked from the headers alone (the gateway signs the body
    // hash and sends it as a header), so an unsigned request is refused
    // before its body is read; the body is then read under the cap, hashed
    // as it arrives, and must match the signed hash.
    const headers = context.req.raw.headers;
    const pathWithQuery = `${url.pathname}${url.search}`;
    const verified = verifySiteGatewayRequest({ method, pathWithQuery, headers, secrets });
    if (!verified.ok) throw refuse(verified.reason);
    const suffix = url.pathname.slice(SITE_RUNTIME_API_PREFIX.length);
    const read =
      method === "GET" || method === "HEAD"
        ? { body: new Uint8Array(), sha256: EMPTY_BODY_SHA256 }
        : await readCappedBody(
            context.req.raw,
            method === "POST" && suffix === FILE_UPLOAD_SUFFIX
              ? SITE_RUNTIME_FILE_BODY_LIMIT
              : SITE_RUNTIME_JSON_BODY_LIMIT,
          );
    if (!sameSha256Hex(read.sha256, verified.bodySha256)) throw refuse("body_mismatch");
    const body = read.body;
    context.header("cache-control", "no-store");
    const runtime: RuntimeRequest = {
      context,
      url,
      method,
      suffix,
      body,
      fields: verified.fields,
      domain,
    };
    return await route(runtime);
  };

  const route = async (request: RuntimeRequest): Promise<Response> => {
    const { method, suffix } = request;
    if (method === "GET" && suffix === "/host") return await hostLookup(request);
    const version = /^\/versions\/([^/]+)\/html$/u.exec(suffix);
    if (method === "GET" && version) return await versionHtml(request, version[1]!);
    if (method === "POST" && suffix === "/auth/exchange") return await exchange(request);
    if (method === "POST" && suffix === "/auth/logout") return await logout(request);
    if (method === "POST" && suffix === "/auth/view-as") return await viewAs(request);
    if (method === "POST" && suffix === "/platform/requests")
      return await platformRequests(request);
    if (method === "POST" && suffix === "/site/reports") return await report(request);
    const tool = /^\/tools\/([a-z]+)$/u.exec(suffix);
    if (method === "POST" && tool) return await tools(request, tool[1]!);
    const sitePath = suffix === "/v1/config/client" ? suffix : `/v1/workspaces/site-host${suffix}`;
    const matched = matchSiteOperation(method, sitePath);
    if (!matched) throw unsupported();
    return await operation(request, matched.operation.id);
  };

  /**
   * The host map record for the signed host (the gateway's fallback on a KV
   * miss). The signed host header names it; an optional `host` query must agree.
   */
  const hostLookup = async (request: RuntimeRequest): Promise<Response> => {
    const asked = request.url.searchParams.get("host");
    const normalize = (host: string) => host.trim().toLowerCase().replace(/\.$/u, "");
    if (asked !== null && normalize(asked) !== normalize(request.fields.host))
      throw invalid("host must be the signed Site host");
    const found = await findSiteRuntimeHost(deps, request.domain, request.fields.host);
    if (!found)
      throw sitePublishingError(404, "not_found", "site_not_found", "This Site does not exist");
    // A lookup reaches the API only on an edge miss: repair a lost edge sync.
    healSiteEdgeIfStale(deps, found.publication);
    return request.context.json(
      siteHostMapRecord(deps.settings, request.domain, found.publication, found.site),
    );
  };

  /** A viewer whose access is checked, with per-visitor request limits applied. */
  const viewing = async (request: RuntimeRequest) => {
    const host = await requireServedSiteRuntimeHost(deps, request.domain, request.fields.host);
    const viewer = await resolveSiteRuntimeViewer(deps, host, request.fields);
    const { limits, kind: profileKind } = await siteRuntimeLimitProfile(deps, host, viewer);
    await enforceSiteRuntimeViewerRate(
      deps,
      host,
      viewer,
      request.fields,
      "requests",
      limits.requestsPerMinutePerVisitor,
    );
    return { host, viewer, limits, profileKind };
  };

  /**
   * Immutable HTML of the Site's current version, or of a version a publish
   * or rollback replaced within the last ten minutes (pages already open).
   * Never another Site's version, nor an older one of this Site.
   */
  const versionHtml = async (request: RuntimeRequest, versionId: string): Promise<Response> => {
    const { host } = await viewing(request);
    if (!deps.objectStorage)
      throw sitePublishingError(
        503,
        "upstream_unavailable",
        "site_storage_unavailable",
        "Storage is not configured",
      );
    const parsed = VersionId.safeParse(versionId);
    const version = parsed.success
      ? await getServableSiteVersion(deps.db, host.scope, {
          siteId: host.site.id,
          versionId: parsed.data,
          currentVersionId: host.versionId,
          graceSeconds: SITE_VERSION_GRACE_SECONDS,
        })
      : null;
    const object = version ? await deps.objectStorage.getObjectBytes(version.contentKey) : null;
    if (!version || !object)
      throw sitePublishingError(404, "not_found", "site_version_not_found", "Version not found");
    return new Response(object.bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        ...USER_CONTENT_SECURITY_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": SITE_VERSION_CONTENT_SECURITY_POLICY,
        // A version's bytes never change; the gateway caches them after its own access check.
        "Cache-Control": "private, max-age=31536000, immutable",
        "Referrer-Policy": "no-referrer",
        ...(version.contentSha256 ? { ETag: `"${version.contentSha256}"` } : {}),
      },
    });
  };

  /** Viewer sign-in, step two: the gateway trades the one-time code for a site-session. */
  const exchange = async (request: RuntimeRequest): Promise<Response> => {
    const host = await requireServedSiteRuntimeHost(deps, request.domain, request.fields.host);
    const input = parseJson(request.body, SiteAuthExchangeRequest);
    await enforceSiteRuntimeRate(
      deps,
      host,
      siteClientAddressPrincipal(request.fields),
      "sign_in",
      EXCHANGES_PER_MINUTE,
    );
    const refused = () =>
      sitePublishingError(
        400,
        "validation_failed",
        "site_auth_code_invalid",
        "This sign-in link is no longer valid",
      );
    const code = await consumeSiteAuthCode(deps.db, host.scope, {
      siteId: host.site.id,
      codeHash: sha256Text(input.code),
      hostname: host.hostname,
    });
    if (!code) throw refused();
    const callback = `https://${host.hostname}${SITE_GATEWAY_CALLBACK_PATH}`;
    const challenge = createHash("sha256").update(input.codeVerifier, "utf8").digest("base64url");
    if (
      input.redirectUri !== callback ||
      !sameText(code.redirectUri, input.redirectUri) ||
      !sameText(code.codeChallenge, challenge)
    )
      throw refused();
    // Access is decided again now: membership or an invitation may have changed.
    const kind = signedInSiteViewerKind({
      access: effectiveSiteAccess(host.publication.access, deps.settings),
      member: await isSiteWorkspaceMember(deps.db, host.scope, code.subjectId),
      email: code.email,
      invitedEmails: host.publication.invitedEmails,
    });
    if (!kind)
      throw sitePublishingError(
        403,
        "forbidden",
        "site_access_denied",
        "You do not have access to this Site",
      );
    const sessionToken = randomBytes(32).toString("base64url");
    const session = await createSiteViewerSession(deps.db, host.scope, {
      siteId: host.site.id,
      tokenHash: sha256Text(sessionToken),
      subjectId: code.subjectId,
      kind,
      email: code.email,
      displayName: code.displayName,
      absoluteSeconds: deps.settings.sitesViewerSessionAbsoluteSeconds,
    });
    const viewer: SiteRuntimeViewer = {
      kind,
      principal: `user:${code.subjectId}`,
      subjectId: code.subjectId,
      name: code.displayName,
      email: code.email,
      sessionId: session.id,
    };
    await meterSiteRuntime(deps, host, { type: "sign_in", viewer });
    const response: SiteAuthExchangeResponse = {
      sessionToken,
      expiresAt: session.expiresAt.toISOString(),
      viewer: publicSiteViewer(viewer),
    };
    return request.context.json(response);
  };

  const logout = async (request: RuntimeRequest): Promise<Response> => {
    const host = await findSiteRuntimeHost(deps, request.domain, request.fields.host);
    // Signing out always succeeds for the gateway, even for a Site that is gone.
    if (!host) return request.context.json({ revoked: false });
    const revoked = request.fields.session
      ? await revokeSiteViewerSession(deps.db, host.scope, {
          siteId: host.site.id,
          tokenHash: sha256Text(request.fields.session),
        })
      : false;
    return request.context.json({ revoked });
  };

  /**
   * "View as visitor": a workspace member starts (`invited`, `public`) or
   * ends (null) previewing this Site as that role on their own site-session.
   * Refused for anyone else; the preview only ever shows less (see
   * resolveSiteRuntimeViewer).
   */
  const viewAs = async (request: RuntimeRequest): Promise<Response> => {
    const host = await requireServedSiteRuntimeHost(deps, request.domain, request.fields.host);
    const input = parseJson(request.body, z.object({ viewAs: SiteViewAs.nullable() }));
    const viewer = await resolveSiteRuntimeViewer(deps, host, request.fields, {
      ignoreViewAs: true,
    });
    if (viewer.kind !== "member" || !viewer.sessionId)
      throw sitePublishingError(
        403,
        "forbidden",
        "site_view_as_members_only",
        "Only workspace members can preview a Site as a visitor",
      );
    await setSiteViewerSessionViewAs(deps.db, host.scope, {
      siteId: host.site.id,
      sessionId: viewer.sessionId,
      viewAs: input.viewAs,
    });
    return request.context.json({ viewAs: input.viewAs });
  };

  /**
   * Batched gateway request counts (platform usage): the gateway counts
   * every request it serves for a Site host, cache hits included, and
   * reports them in signed batches on the Sites domain apex. Each host's
   * count is recorded once per report id, so a retried report never counts
   * twice. Hosts that no longer resolve are skipped. Hosts are recorded a few
   * at a time, and each workspace's charges are settled once per report.
   */
  const platformRequests = async (request: RuntimeRequest): Promise<Response> => {
    const apex = request.domain.toLowerCase();
    if (request.fields.host.toLowerCase().replace(/\.$/u, "") !== apex)
      throw invalid("Platform reports are signed for the Sites domain");
    const input = parseJson(request.body, SitePlatformRequestReport);
    const perHost = new Map<string, number>();
    for (const entry of input.hosts) {
      const name = entry.host.toLowerCase();
      perHost.set(name, (perHost.get(name) ?? 0) + entry.requests);
    }
    const entries = [...perHost];
    const workspaces = new Map<string, SiteRuntimeHost["scope"]>();
    let counted = 0;
    const recordOne = async ([name, requests]: [string, number]) => {
      const host = await findSiteRuntimeHost(deps, request.domain, name);
      if (!host) return;
      const recorded = await recordSitePlatformRequests(deps.db, host.scope, {
        siteId: host.site.id,
        requests,
        idempotencyKey: `site_platform.requests:${input.reportId}:${name}`,
      });
      if (!recorded) return;
      counted += requests;
      workspaces.set(host.scope.workspaceId, host.scope);
    };
    for (let next = 0; next < entries.length; next += SITE_PLATFORM_REPORT_CONCURRENCY)
      await Promise.all(
        entries.slice(next, next + SITE_PLATFORM_REPORT_CONCURRENCY).map(recordOne),
      );
    for (const scope of workspaces.values()) {
      const usage = await readSitePlatformUsage(deps.db, scope);
      if (usage) await afterSitePlatformUsage(deps, scope, usage);
    }
    return request.context.json({ counted });
  };

  /**
   * Abuse reports: anyone who reaches a served Site host, rate limited per
   * reporter, per client address and per Site. A reporter and a client
   * address each get the same small share (5 a minute by default) of the
   * Site's 60, so no one reporter fills the Site's cap. Each report also
   * reaches the platform (a structured log line, and an email when an abuse
   * address is set).
   */
  const report = async (request: RuntimeRequest): Promise<Response> => {
    const host = await requireServedSiteRuntimeHost(deps, request.domain, request.fields.host);
    const input = parseJson(request.body, SiteAbuseReportRequest);
    const address = siteClientAddressPrincipal(request.fields);
    const reporter = request.fields.session
      ? `session:${sha256Text(request.fields.session).slice(0, 32)}`
      : request.fields.visitor
        ? `guest:${request.fields.visitor.slice(0, 128)}`
        : address;
    const perVisitor = deps.settings.sitesReportsPerMinutePerVisitor;
    await enforceSiteRuntimeRate(deps, host, reporter, "reports", perVisitor);
    if (reporter !== address)
      await enforceSiteRuntimeRate(deps, host, address, "reports", perVisitor);
    await enforceSiteRuntimeRate(
      deps,
      host,
      SITE_RUNTIME_SITE_PRINCIPAL,
      "reports",
      SITE_REPORTS_PER_MINUTE,
    );
    const created = await createSiteAbuseReport(deps.db, host.scope, {
      siteId: host.site.id,
      hostname: host.hostname,
      category: input.category,
      message: input.message,
      contactEmail: input.contactEmail,
      reporterPrincipal: reporter,
    });
    await meterSiteRuntime(deps, host, { type: "report" });
    notifySiteAbuse(deps, {
      scope: host.scope,
      siteId: host.site.id,
      hostname: host.hostname,
      kind: "report",
      detail: `${input.category}: ${input.message}`,
    });
    return request.context.json({ id: created.id, received: true }, 201);
  };

  /** Page tools use the signed-in member, not the Site's assistant or owner. */
  const tools = async (request: RuntimeRequest, method: string): Promise<Response> => {
    if (!(SITE_TOOL_METHODS as readonly string[]).includes(method)) throw unsupported();
    await viewing(request);
    const authorization = await authorizePublishedSiteTools(deps, request.domain, request.fields);
    const authority = publishedSiteToolAuthority(authorization);
    // Host-selected association overwrites any page-supplied Site context.
    const site = {
      siteArtifactId: authority.origin.siteId,
      siteVersionId: authority.origin.versionId,
    };
    const authorizeSite: typeof requireWorkspaceSiteToolAuthorization = (db, grant, context) =>
      requireWorkspaceSiteToolAuthorization(db, grant, context, authority.readVersion);
    const options = { signal: request.context.req.raw.signal };
    let result: unknown;
    if (method === "resolve") {
      result = await resolveWorkspaceToolTarget(
        deps,
        authorization,
        { ...parseJson(request.body, ToolGatewayResolveRequest), ...site },
        options,
      );
    } else if (method === "invoke") {
      result = await withSiteSecretContext(
        { siteId: site.siteArtifactId, siteVersion: site.siteVersionId },
        () =>
          invokeWorkspaceToolTarget(
            deps,
            authorization,
            { ...parseJson(request.body, ToolGatewayInvokeRequest), ...site },
            options,
          ),
      );
    } else {
      const call =
        method === "call" ? { ...parseJson(request.body, ToolGatewayCallRequest), ...site } : null;
      // Reject undeclared identities before any connector is prepared.
      if (call)
        await authorizeSite(deps.db, authorization.grant, { ...site, identity: call.identity });
      const prepared = await prepareWorkspaceToolGateway(deps, authorization, options);
      try {
        result = call
          ? await callWorkspaceToolGateway(
              prepared,
              authorization.grant,
              call,
              deps.db,
              undefined,
              deps.observability,
              authorizeSite,
              async () => authority.origin,
            )
          : method === "declarations"
            ? workspaceToolGatewayDeclarations(prepared)
            : prepared.toolGatewayCatalog;
        if (!call) await authority.reauthorize();
      } finally {
        await prepared.close();
      }
    }
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  };

  /**
   * The models a viewer's conversations may use. Members: the Site agent's
   * model and the allowed models, subscriptions included. Everyone else
   * never uses a subscription-billed model: a subscription agent model is
   * replaced by the workspace's default credit-billed model, and
   * `unavailable` when there is none (agent-model.ts).
   */
  const siteViewerModels = async (
    host: SiteRuntimeHost,
    viewer: SiteRuntimeViewer,
    limits: { agentModels: string[] | null },
  ): Promise<{ allowed: string[]; default: string | null; unavailable: boolean }> => {
    const agentModel = host.publication.agent.model;
    const named = (models: (string | null | undefined)[]) => [
      ...new Set(
        models.filter((model): model is string => typeof model === "string" && model.length > 0),
      ),
    ];
    if (viewer.kind === "member") {
      if (!viewer.subjectId)
        throw siteNotAvailableForViewer("agent_model", "Sign in to use your workspace's models");
      const selections = resolveWorkspaceModelSelection(
        await loadWorkspaceModelSelectionInput(deps.db, deps.settings, {
          ...host.scope,
          subjectId: viewer.subjectId,
        }),
      );
      return {
        allowed: selections
          .filter((selection) => admissibleWorkspaceModel([selection], selection.model.id))
          .map((selection) => selection.model.id),
        default: agentModel,
        unavailable: false,
      };
    }
    const choice = await resolveSiteOutsideModel(deps, host.scope, {
      siteId: host.site.id,
      agentModel,
    });
    const creditModels = new Set(await siteCreditModelIds(deps, host.scope, host.site.id));
    const credited = (models: string[]) => models.filter((model) => creditModels.has(model));
    if (choice.kind === "unavailable")
      return {
        allowed: credited(named(limits.agentModels ?? [])),
        default: null,
        unavailable: true,
      };
    const model = choice.model;
    return {
      allowed: credited(named([model, ...(limits.agentModels ?? [])])),
      default: model,
      unavailable: false,
    };
  };

  /**
   * What this viewer can use, from the same checks the routes enforce: the
   * agent also needs the platform brake open for people outside the
   * workspace who are not invited, and a credit-billed model for anyone
   * outside the workspace. Page tools are independent of the assistant.
   */
  const viewerCapabilities = async (
    host: SiteRuntimeHost,
    viewer: SiteRuntimeViewer,
    limits: Parameters<typeof siteViewerCapabilities>[3],
  ) => {
    const base = siteViewerCapabilities(deps, host, viewer, limits);
    let agent = base.agent;
    if (agent && (viewer.kind === "guest" || viewer.kind === "user"))
      agent = !(await sitePlatformBrakeEngaged(deps).catch(() => false));
    if (agent && viewer.kind !== "member") {
      const choice = await resolveSiteOutsideModel(deps, host.scope, {
        siteId: host.site.id,
        agentModel: host.publication.agent.model,
      }).catch(() => null);
      agent = choice !== null && choice.kind !== "unavailable";
    }
    const version = host.site.currentVersionId
      ? await getPublishedSiteVersion(deps.db, host.scope, host.site.id, host.site.currentVersionId)
      : null;
    const workspaceTools =
      base.workspaceTools &&
      (version?.requestedTools.length ?? 0) > 0 &&
      viewer.subjectId !== null &&
      viewer.subjectId !== undefined &&
      hasPermission(
        (await getSiteWorkspaceMemberPermissions(deps.db, host.scope, viewer.subjectId)) ?? [],
        "workspace:read",
      );
    return { ...base, agent, workspaceTools };
  };

  const operation = async (request: RuntimeRequest, id: string): Promise<Response> => {
    const { host, viewer, limits, profileKind } = await viewing(request);
    const { context } = request;
    switch (id) {
      case "config.client":
        return siteRuntimeForwardedResponse(
          await dispatch(new Request(new URL("/v1/config/client", request.url.origin))),
        );
      case "workspace.get":
        // The Site's own view of "its workspace": no tenant data.
        return context.json({ id: host.scope.workspaceId, name: host.site.title });
      case "site.config": {
        const capabilities = await viewerCapabilities(host, viewer, limits);
        const config: SiteRuntimeConfig = {
          siteId: host.site.id,
          title: host.site.title,
          hostname: host.hostname,
          versionId: host.versionId,
          access: effectiveSiteAccess(host.publication.access, deps.settings),
          viewer: publicSiteViewer(viewer),
          capabilities,
          agent: {
            enabled: capabilities.agent,
            model: host.publication.agent.model,
          },
          siteData: true,
          noindex: host.publication.noindex || deps.settings.sitesForceNoindex,
          abuseEmail: deps.settings.sitesAbuseEmail ?? `abuse@${request.domain}`,
        };
        return context.json(config);
      }
      case "models.list": {
        const models = await siteViewerModels(host, viewer, limits);
        return context.json({
          models: models.allowed.map((model) => ({ id: model })),
          defaultModel: models.default,
        });
      }
      case "site.report":
        return await report(request);
      case "data.read":
      case "data.write":
      case "data.put":
      case "data.patch":
      case "data.delete":
        return await siteData(request, host, viewer, limits.guestWritesPerMinute);
      case "sql.run":
        return await siteSql(request, host, viewer, limits.guestWritesPerMinute, profileKind);
      default:
        if (id.startsWith("sessions.")) return await sessions(request, id, host, viewer, limits);
        throw unsupported();
    }
  };

  /** This Site's viewer (`user:<subject>` or `guest:<visitor>`) as Site Data and Site SQL see it. */
  const publishedViewer = (
    host: SiteRuntimeHost & { versionId: string },
    viewer: SiteRuntimeViewer,
  ): PublishedSiteDataViewer =>
    sitePublishedDataViewer(host, viewer.principal, viewer.kind === "guest");

  /**
   * Site SQL: run one named query of this Site as the viewer. The query's
   * audience decides who may run it (guests only `everyone`), and `:viewer`
   * is bound from this viewer; the Site never sends SQL. Guests' write
   * queries also count against the guest write limit per visitor and per
   * client address, like Site Data.
   */
  const siteSql = async (
    request: RuntimeRequest,
    host: SiteRuntimeHost & { versionId: string },
    viewer: SiteRuntimeViewer,
    guestWritesPerMinute: number | null,
    profileKind: SiteLimitProfileKind,
  ): Promise<Response> => {
    const name = /^\/published-artifacts\/current\/sql\/queries\/([^/]+)$/u.exec(
      request.suffix,
    )?.[1];
    if (request.method !== "POST" || !name) throw unsupported();
    const input = parseJson(request.body, SiteSqlRunRequest);
    const siteId = host.site.id;
    return request.context.json(
      await runSiteSqlRoute(() =>
        runSiteSqlForViewer(() =>
          runSiteSqlQuery(
            deps,
            publishedViewer(host, viewer),
            siteId,
            name,
            input.params ?? {},
            { frameSiteId: siteId },
            {
              profileKind,
              beforeWrite: async () => {
                if (viewer.kind === "guest")
                  await enforceSiteRuntimeViewerRate(
                    deps,
                    host,
                    viewer,
                    request.fields,
                    "guest_writes",
                    guestWritesPerMinute,
                  );
              },
            },
          ),
        ),
      ),
    );
  };

  /** Site Data and files of this Site, as the viewer (`user:<subject>` or `guest:<visitor>`). */
  const siteData = async (
    request: RuntimeRequest,
    host: SiteRuntimeHost & { versionId: string },
    viewer: SiteRuntimeViewer,
    guestWritesPerMinute: number | null,
  ): Promise<Response> => {
    const { context, method, url } = request;
    const path = request.suffix.slice("/published-artifacts/current".length);
    const authority = publishedViewer(host, viewer);
    const siteId = host.site.id;
    const surface = { frameSiteId: siteId };
    // Guest writes count per visitor and per client address; both must pass.
    const guestWrite = async () => {
      if (viewer.kind === "guest")
        await enforceSiteRuntimeViewerRate(
          deps,
          host,
          viewer,
          request.fields,
          "guest_writes",
          guestWritesPerMinute,
        );
    };
    const file = /^\/files\/([^/]+)$/u.exec(path);
    if (method === "POST" && path === "/data/query")
      return context.json(
        await runSiteData(() =>
          querySiteData(
            deps,
            authority,
            siteId,
            parseJson(request.body, SiteDataQueryRequest),
            surface,
          ),
        ),
      );
    if (method === "POST" && path === "/data/get") {
      const record = await runSiteData(() =>
        getSiteDataRecord(
          deps,
          authority,
          siteId,
          parseJson(request.body, SiteDataGetRequest),
          surface,
        ),
      );
      return context.json({ record });
    }
    if (method === "POST" && path === "/data/write") {
      const input = parseJson(request.body, SiteDataWriteRequest);
      await guestWrite();
      const written = await runSiteData(() =>
        writeSiteData(deps, authority, siteId, input.operations, surface),
      );
      return context.json({ results: written.results });
    }
    if (method === "GET" && path === "/files") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      return context.json(
        await runSiteData(() =>
          listSiteDataFiles(
            deps,
            authority,
            siteId,
            { limit: Number.isFinite(limit) ? limit : 100, cursor: url.searchParams.get("cursor") },
            surface,
          ),
        ),
      );
    }
    if (method === "POST" && path === "/files") {
      const scope = SiteDataFileScope.safeParse(url.searchParams.get("scope") ?? "shared");
      if (!scope.success) throw invalid("scope must be shared or private");
      await guestWrite();
      const bytes = request.body;
      const created = await runSiteData(() =>
        uploadSiteDataFile(
          deps,
          authority,
          siteId,
          {
            name: url.searchParams.get("name"),
            contentType: context.req.header("content-type"),
            body: {
              declaredBytes: bytes.byteLength,
              read: async () => {
                if (bytes.byteLength > deps.settings.siteDataMaxFileBytes)
                  throw new SiteDataError("quota_exceeded", "This file is too large", {
                    quota: "file_bytes",
                    limit: deps.settings.siteDataMaxFileBytes,
                  });
                return bytes;
              },
            },
            scope: scope.data,
          },
          surface,
        ),
      );
      return context.json(created, 201);
    }
    if (method === "GET" && file)
      return context.json(
        await runSiteData(() => getSiteDataFileUrl(deps, authority, siteId, file[1]!, surface)),
      );
    if (method === "DELETE" && file) {
      await guestWrite();
      return context.json(
        await runSiteData(() => deleteSiteDataFile(deps, authority, siteId, file[1]!, surface)),
      );
    }
    throw unsupported();
  };

  /** The viewer's own agent conversations on this Site, run as `site:<siteId>`. */
  const sessions = async (
    request: RuntimeRequest,
    id: string,
    host: SiteRuntimeHost & { versionId: string },
    viewer: SiteRuntimeViewer,
    limits: Awaited<ReturnType<typeof siteRuntimeLimitProfile>>["limits"],
  ): Promise<Response> => {
    const { context, url } = request;
    const base = `/v1/workspaces/${host.scope.workspaceId}/sessions`;
    // Every forwarded call runs inside the Site's origin, and also
    // carries the Site and version headers the API's Site frame guard
    // validates; sessions and turns it starts record this Site and version.
    const siteOrigin = { siteId: host.site.id, title: host.site.title, versionId: host.versionId };
    const reauthorizeViewer = async () => {
      const liveHost = await requireServedSiteRuntimeHost(deps, host.domain, request.fields.host);
      const liveViewer = await resolveSiteRuntimeViewer(deps, liveHost, request.fields);
      if (
        liveHost.site.id !== host.site.id ||
        liveViewer.principal !== viewer.principal ||
        liveViewer.kind !== viewer.kind ||
        liveViewer.sessionId !== viewer.sessionId
      )
        throw siteNotAvailableForViewer(
          "agent",
          "This conversation is no longer available to this viewer",
        );
    };
    let pendingAdmission: { sessionId: string; admissionId: string } | undefined;
    const send = async (
      method: string,
      path: string,
      body?: unknown,
      extraPermissions?: readonly Permission[],
    ) => {
      await reauthorizeViewer();
      const execute = () =>
        withSiteViewerRlsContext({ siteId: host.site.id, principal: viewer.principal }, () =>
          withSiteSessionOrigin(siteOrigin, async () =>
            dispatch(
              await siteRuntimeSessionRequest(deps, host, viewer, {
                origin: url.origin,
                method,
                path,
                reauthorize: reauthorizeViewer,
                ...(body === undefined ? {} : { body }),
                ...(extraPermissions ? { extraPermissions } : {}),
              }),
            ),
          ),
        );
      const pending = pendingAdmission;
      if (!pending) return await execute();
      // The trusted context fences every session write through enqueue commit.
      // A thrown/unknown dispatch retains its marker; recovery reconciles it.
      const response = await withSiteRuntimeAdmission(
        { ...pending, workspaceId: host.scope.workspaceId },
        execute,
      );
      await finishSiteRuntimeAdmission(deps.db, host.scope, pending);
      pendingAdmission = undefined;
      if (!response.ok) {
        const current = await getOwnedSiteRuntimeConversation(deps.db, host.scope, {
          sessionId: pending.sessionId,
          siteId: host.site.id,
          viewerPrincipal: viewer.principal,
        });
        if (current) await settleSiteRuntimeSpend(deps, host, current, { release: true });
      }
      return response;
    };
    /** A forwarded session read, answered with the Site-safe projection. */
    const projected = async (response: Response, status = response.status) => {
      if (!response.ok) return siteRuntimeForwardedResponse(response);
      return context.json(siteSessionProjection(await response.json()), status as 200);
    };
    /** Forward, and answer a success with a Site-safe view of its body. */
    const forwardView = async (
      method: string,
      path: string,
      view: (value: unknown) => unknown,
      body?: unknown,
    ) => {
      const response = await send(method, path, body);
      if (!response.ok) return siteRuntimeForwardedResponse(response);
      return context.json(view(await response.json()) as object, response.status as 200);
    };
    const notFound = () =>
      sitePublishingError(
        404,
        "not_found",
        "site_conversation_not_found",
        "Conversation not found",
      );
    const budgets = siteRuntimeBudgetLimits(limits, deps.settings);
    /**
     * Reserve, and when a Site-wide budget refuses, release reservations
     * finished conversations no longer need and retry once (unless the Site
     * was swept moments ago).
     */
    const reserve = async (run: () => Promise<SiteRuntimeReservation>) => {
      let reservation = await run();
      if (siteWideBudget(reservation) && (await sweepSiteRuntimeReservations(deps, host)))
        reservation = await run();
      if (!reservation.ok) throw siteReservationRefused(reservation);
      return reservation;
    };

    if (id === "sessions.list") {
      const owned = await listOwnedSiteRuntimeConversations(deps.db, host.scope, {
        siteId: host.site.id,
        viewerPrincipal: viewer.principal,
        limit: LIST_LIMIT,
      });
      const listed: unknown[] = [];
      for (const conversation of owned) {
        const response = await send("GET", `${base}/${conversation.sessionId}`);
        if (response.ok) listed.push(siteSessionProjection(await response.json()));
        else await response.body?.cancel();
      }
      return context.json({ pinned: [], sessions: listed, nextCursor: null });
    }

    if (id === "sessions.create") {
      const input = parseJson(request.body, CreateConversationRequest);
      requireSiteAgent(deps, host, viewer, limits);
      // The Opengeni-wide platform brake stops public visitors' agent turns.
      if (viewer.kind === "guest" || viewer.kind === "user")
        await requireSitePlatformOpen(deps, "guest_agent");
      const models = await siteViewerModels(host, viewer, limits);
      if (input.model && !models.allowed.includes(input.model))
        throw siteNotAvailableForViewer(
          "agent_model",
          "This model is not available to you on this Site",
        );
      if (models.unavailable)
        throw siteNotAvailableForViewer(
          "agent_model",
          "This Site's assistant is only available to workspace members right now",
          { reason: "no_credit_billed_model" },
        );
      if (
        viewer.kind === "guest" &&
        deps.settings.sitesGuestAgentHumanCheck &&
        !request.fields.human
      )
        throw sitePublishingError(
          403,
          "forbidden",
          "site_human_check_required",
          "Confirm you are human to use this Site's assistant",
        );
      // A replayed idempotency key names the same conversation: answer it again.
      const requestedSessionId = input.idempotencyKey
        ? idempotentSessionId(`${host.site.id}\n${viewer.principal}\n${input.idempotencyKey}`)
        : randomUUID();
      let repair: { conversation: SiteRuntimeConversationRecord; model: string } | undefined;
      if (input.idempotencyKey) {
        const replay = await getOwnedSiteRuntimeConversation(deps.db, host.scope, {
          sessionId: requestedSessionId,
          siteId: host.site.id,
          viewerPrincipal: viewer.principal,
        });
        if (replay) {
          // A lost start response may have left only a reservation. Reconcile
          // before replay so this key cannot remain stuck on a missing session.
          await settleSiteRuntimeSpend(deps, host, replay);
          const retained = await getOwnedSiteRuntimeConversation(deps.db, host.scope, {
            sessionId: requestedSessionId,
            siteId: host.site.id,
            viewerPrincipal: viewer.principal,
          });
          if (retained) {
            const shell = await getSession(deps.db, host.scope.workspaceId, requestedSessionId);
            const started = await listSessionEvents(
              deps.db,
              host.scope.workspaceId,
              requestedSessionId,
              {
                includeTypes: ["session.created"],
                payloadMode: "none",
                limit: 1,
              },
            );
            if (!shell || started.length > 0)
              return await projected(await send("GET", `${base}/${replay.sessionId}`), 202);
            // Core deliberately retains a keyed shell when initialization fails.
            // Re-enter its keyed Start repair, never insert/count a new conversation.
            repair = { conversation: retained, model: shell.model };
          }
        }
      }
      // Settle the viewer's recent spend so the day budget sees it.
      if (!repair && viewer.kind !== "member" && deps.settings.privacyOnlyMeAllowed === false)
        throw siteNotAvailableForViewer(
          "private_conversations",
          "Private Site conversations are disabled by this deployment",
        );
      for (const conversation of await listOwnedSiteRuntimeConversations(deps.db, host.scope, {
        siteId: host.site.id,
        viewerPrincipal: viewer.principal,
        limit: 5,
      }))
        await settleSiteRuntimeSpend(deps, host, conversation);
      const agent = host.publication.agent;
      const memberPermissions =
        viewer.kind === "member" && viewer.subjectId
          ? await getSiteWorkspaceMemberPermissions(deps.db, host.scope, viewer.subjectId)
          : null;
      const mcpTools = siteAgentToolRefs(agent, viewer, memberPermissions);
      if (repair) {
        const previous = repair.conversation;
        const legacyMember =
          viewer.kind === "member" &&
          previous.viewerKind === "member" &&
          previous.budgetKey === SITE_RUNTIME_SITE_PRINCIPAL;
        if (
          (previous.budgetKey !== siteRuntimeBudgetKey(viewer) && !legacyMember) ||
          previous.toolIds.some((tool) => !mcpTools.some((allowed) => allowed.id === tool))
        )
          throw sitePublishingError(
            409,
            "conflict",
            "site_conversation_outdated",
            "This Site's assistant changed since this conversation started; start a new one",
          );
        if (
          viewer.kind !== "member" &&
          !(await siteCreditModelIds(deps, host.scope, host.site.id)).includes(repair.model)
        )
          throw siteNotAvailableForViewer(
            "agent_model",
            "This Site's assistant cannot use that model for you",
            { reason: "subscription_model" },
          );
        if (viewer.kind === "member" && previous.limitMicros !== null)
          await liftSiteConversationUsageLimit(
            deps,
            host,
            requestedSessionId,
            previous.limitMicros,
            null,
          );
      }
      // Every conversation gets this Site's own data tools, pinned to this
      // Site and acting as this viewer (site-publishing/agent-data-tools.ts).
      const dataTools = await siteAgentDataToolsForStart(
        deps,
        host.scope,
        host.site.id,
        viewer.kind,
      );
      // One transaction counts the start and reserves a per-turn estimate
      // against the visitor's and the Site's windows; only the funded allowance
      // becomes the session's usage limit, set in the create transaction. The
      // row also records the tools the conversation gets, so narrowing them
      // later stops it.
      const admissionId = randomUUID();
      const reservation = await reserve(() =>
        repair
          ? reserveSiteRuntimeConversationWork(deps.db, host.scope, {
              admissionId,
              sessionId: requestedSessionId,
              limits: budgets,
              newTurn: false,
              uncapped: viewer.kind === "member",
              repairStart: true,
            })
          : reserveSiteRuntimeConversationStart(deps.db, host.scope, {
              admissionId,
              sessionId: requestedSessionId,
              siteId: host.site.id,
              viewerPrincipal: viewer.principal,
              viewerKind: viewer.kind,
              viewerEmail: viewer.email,
              toolIds: mcpTools.map((tool) => tool.id),
              versionId: host.versionId,
              limits: budgets,
              budgetKey: siteRuntimeBudgetKey(viewer),
            }),
      );
      if (reservation.alreadyStarted)
        return await projected(await send("GET", `${base}/${requestedSessionId}`), 202);
      pendingAdmission = { sessionId: requestedSessionId, admissionId };
      const body = {
        initialMessage: input.initialMessage,
        requestedSessionId,
        ...(viewer.kind === "member" ? { visibility: "private" } : {}),
        startMode: "standard",
        agentAccess: "session",
        memoryScope: "off",
        rigId: null,
        // Only this Site's data tools; never management or workspace tools.
        firstPartyMcpTools: dataTools,
        ...(dataTools.length > 0
          ? { firstPartyMcpPermissions: [...SITE_AGENT_DATA_TOOL_PERMISSIONS] }
          : {}),
        agent: {
          capabilities: {
            from: "none",
            humanInput: false,
            skills: false,
            ...(dataTools.length > 0 ? { artifacts: true } : {}),
          },
        },
        // No sandbox: a Site's agent answers from the page and the Site's
        // data, with no shell or workspace files.
        sandboxBackend: "none",
        ...(repair
          ? { model: repair.model }
          : input.model || models.default
            ? { model: input.model ?? models.default }
            : {}),
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        ...(input.latencyMode === undefined ? {} : { latencyMode: input.latencyMode }),
        instructions: siteAgentInstructions(host, viewer, dataTools, agent.instructions),
        // Always explicit: an empty list means no workspace tools at all.
        tools: mcpTools,
        metadata: {
          opengeniPublishedSite: {
            siteId: host.site.id,
            versionId: host.versionId,
            viewerKind: viewer.kind,
            agentDefaultsVersion: SITE_AGENT_DEFAULTS_VERSION,
          },
        },
        ...(input.idempotencyKey ? { idempotencyKey: `site-runtime:${requestedSessionId}` } : {}),
      };
      const start = () =>
        send("POST", base, body, dataTools.length > 0 ? SITE_AGENT_DATA_TOOL_PERMISSIONS : []);
      // Workspace members get no Site budget at all: their conversation is an
      // ordinary session under the workspace's normal limits, so no session
      // usage limit is stamped on it, whatever the Site's limits say.
      const usageLimitMicros =
        viewer.kind === "member" || repair ? null : reservation.executionLimitMicros;
      let created: Response;
      try {
        // Initial create's limit command is idempotent, not a top-up. A retained
        // shell must receive its newly funded ceiling before core repairs it.
        if (repair && viewer.kind !== "member" && reservation.executionLimitMicros !== null) {
          try {
            await capSiteConversationUsageLimit(deps, host, requestedSessionId, null);
          } catch (error) {
            // Dispatch has not begun: this failure is definitive, unlike a
            // lost response from core's initialization transaction.
            await finishSiteRuntimeAdmission(deps.db, host.scope, pendingAdmission);
            pendingAdmission = undefined;
            const retained = await getOwnedSiteRuntimeConversation(deps.db, host.scope, {
              sessionId: requestedSessionId,
              siteId: host.site.id,
              viewerPrincipal: viewer.principal,
            });
            if (retained) await settleSiteRuntimeSpend(deps, host, retained, { release: true });
            throw error;
          }
        }
        created =
          usageLimitMicros === null
            ? await start()
            : await withHostSessionUsageLimit(
                { subjectId: `site:${host.site.id}`, limitMicros: usageLimitMicros },
                start,
              );
      } catch (error) {
        await releaseUnstarted(host.scope, requestedSessionId);
        throw error;
      }
      if (created.status !== 202) {
        await releaseUnstarted(host.scope, requestedSessionId);
        return siteRuntimeForwardedResponse(created);
      }
      const session = (await created.json().catch(() => null)) as { id?: unknown } | null;
      if (session?.id !== requestedSessionId) {
        // Never leave a conversation running that its owner record does not track.
        if (typeof session?.id === "string")
          await send("POST", `${base}/${session.id}/control`, {
            action: "cancel",
            clientEventId: `site-runtime-untracked:${session.id}`,
            reason: "The conversation could not be tracked",
          }).then((response) => response.body?.cancel());
        await releaseUnstarted(host.scope, requestedSessionId);
        throw sitePublishingError(
          502,
          "upstream_unavailable",
          "site_conversation_failed",
          "The conversation could not be started",
        );
      }
      await meterSiteRuntime(deps, host, { type: "conversation", viewer });
      return context.json(siteSessionProjection(session), 202);
    }

    const sessionId = /^\/sessions\/([^/]+)/u.exec(request.suffix)?.[1] ?? "";
    const conversation = await getOwnedSiteRuntimeConversation(deps.db, host.scope, {
      sessionId,
      siteId: host.site.id,
      viewerPrincipal: viewer.principal,
    });
    if (!conversation) throw notFound();
    const target = `${base}/${conversation.sessionId}`;
    // An EventSource reconnect resumes from Last-Event-ID (forwarded by the
    // gateway); in-process dispatch carries it as the stream's `after` cursor.
    const streamQuery = () => {
      const extra: Record<string, string> = {};
      const lastEventId = request.context.req.header("last-event-id")?.trim();
      if (!url.searchParams.has("after") && lastEventId && /^\d{1,15}$/u.test(lastEventId))
        extra.after = lastEventId;
      return allowedQuery(url, ["after", "transport"], extra);
    };
    /**
     * Event pages and the stream deliver the same Site-safe projection
     * (site-publishing/session-events.ts): allowlisted event types and
     * payload fields, with hidden events as placeholders so sequences stay
     * contiguous. The page is read whole from the API (every type, stored
     * payloads) because the projection, not the read mode, decides what a
     * viewer sees, and message text must not be cut to a preview. Page sizes
     * and the default newest-first order are those of a monitoring read;
     * `payloadMode=none` drops payloads.
     */
    const payloadNone = url.searchParams.get("payloadMode") === "none";
    const eventQuery = (includeTypes: string | null) => {
      const requested = Number(url.searchParams.get("limit") ?? SITE_EVENT_PAGE_DEFAULT);
      const limit = Number.isFinite(requested)
        ? Math.min(SITE_EVENT_PAGE_MAX, Math.max(1, Math.floor(requested)))
        : SITE_EVENT_PAGE_DEFAULT;
      const ordered = ["after", "before", "direction"].some((name) => url.searchParams.has(name));
      return allowedQuery(url, EVENT_QUERY, {
        mode: "forensic",
        payloadMode: payloadNone ? "none" : "full",
        limit: String(limit),
        ...(ordered ? {} : { direction: "before" }),
        ...(includeTypes ? { includeTypes } : {}),
      });
    };
    /** Requested types a viewer can see; null when none of them is visible. */
    const visibleIncludeTypes = (): string | null | undefined => {
      const raw = url.searchParams.get("includeTypes");
      if (raw === null) return undefined;
      const visible = raw
        .split(",")
        .map((type) => type.trim())
        .filter((type) => SITE_VISIBLE_SESSION_EVENT_TYPES.has(type));
      return visible.length > 0 ? [...new Set(visible)].join(",") : null;
    };
    // The agent and budget checks every message-bearing operation passes.
    const admitAgentWork = async (newTurn: boolean) => {
      requireSiteAgent(deps, host, viewer, limits);
      if (viewer.kind === "guest" || viewer.kind === "user")
        await requireSitePlatformOpen(deps, "guest_agent");
      // Tools and budgets are bound when a conversation starts. One holding a
      // tool the Site no longer gives this viewer (removed, or the viewer left
      // the workspace or lost the permission), or counted as a member's while
      // the viewer no longer is one (or the reverse), takes no more work.
      const memberPermissions =
        viewer.kind === "member" && viewer.subjectId
          ? await getSiteWorkspaceMemberPermissions(deps.db, host.scope, viewer.subjectId)
          : null;
      const allowedTools = new Set(
        siteAgentToolRefs(host.publication.agent, viewer, memberPermissions).map((t) => t.id),
      );
      // A member's conversation started before members were kept out of the
      // Site's windows counts in `*` and stays usable; its reservations stay
      // in the windows they were made in.
      const legacyMember =
        viewer.kind === "member" &&
        conversation.viewerKind === "member" &&
        conversation.budgetKey === SITE_RUNTIME_SITE_PRINCIPAL;
      if (
        (conversation.budgetKey !== siteRuntimeBudgetKey(viewer) && !legacyMember) ||
        conversation.toolIds.some((tool) => !allowedTools.has(tool))
      )
        throw sitePublishingError(
          409,
          "conflict",
          "site_conversation_outdated",
          "This Site's assistant changed since this conversation started; start a new one",
        );
      // People outside the workspace never use a subscription-billed model,
      // whatever model the conversation holds.
      if (viewer.kind !== "member") {
        const session = await getSession(deps.db, host.scope.workspaceId, conversation.sessionId);
        if (
          session &&
          !(await siteCreditModelIds(deps, host.scope, host.site.id)).includes(session.model)
        )
          throw siteNotAvailableForViewer(
            "agent_model",
            "This Site's assistant cannot use that model for you",
            { reason: "subscription_model" },
          );
      }
      await normalizeSiteAgentSession(
        deps,
        host,
        viewer,
        conversation.sessionId,
        conversation.toolIds,
      );
      const usage = await settleSiteRuntimeSpend(deps, host, conversation);
      // Clear the stamped session cap before dropping the durable conversation
      // marker. Failure refuses admission and preserves the marker for retry.
      if (viewer.kind === "member" && conversation.limitMicros !== null)
        await liftSiteConversationUsageLimit(
          deps,
          host,
          conversation.sessionId,
          conversation.limitMicros,
          usage,
        );
      const admissionId = randomUUID();
      const admitted = await reserve(() =>
        reserveSiteRuntimeConversationWork(deps.db, host.scope, {
          admissionId,
          sessionId: conversation.sessionId,
          limits: budgets,
          newTurn,
          uncapped: viewer.kind === "member",
        }),
      );
      // Stamp the funded ceiling before work, including atomic top-ups and
      // reduced caps. Members never carry a Site-imposed usage limit.
      pendingAdmission = { sessionId: conversation.sessionId, admissionId };
      try {
        if (admitted.executionLimitMicros !== null && viewer.kind !== "member")
          await capSiteConversationUsageLimit(deps, host, conversation.sessionId, usage);
      } catch (error) {
        // No dispatch has begun, so failure here is definitive. Reconcile the
        // queue before refunding: a previous turn may still be executing.
        await finishSiteRuntimeAdmission(deps.db, host.scope, pendingAdmission);
        pendingAdmission = undefined;
        await settleSiteRuntimeSpend(
          deps,
          host,
          { sessionId: conversation.sessionId, admissions: conversation.admissions + 1 },
          { release: true },
        );
        throw error;
      }
    };
    /**
     * A Site's composer drafts are text only: no workspace resources,
     * timeline annotations, credentials or connection accounts, and only a
     * model the Site allows (or the conversation's own).
     */
    const siteDraft = async (
      draft: Pick<
        z.infer<typeof SaveComposerDraftRequest>,
        "text" | "resources" | "annotations" | "model" | "reasoningEffort" | "latencyMode"
      >,
    ) => {
      if (draft.text.length > MESSAGE_MAX_CHARS)
        throw invalid(`A message is at most ${MESSAGE_MAX_CHARS} characters`);
      if (draft.resources.length > 0 || (draft.annotations?.length ?? 0) > 0)
        throw invalid("Messages on a published Site are text only");
      const allowed = new Set((await siteViewerModels(host, viewer, limits)).allowed);
      // People outside the workspace never use a subscription-billed model.
      if (viewer.kind !== "member" && isSubscriptionBilledModel([], draft.model))
        throw siteNotAvailableForViewer(
          "agent_model",
          "This Site's assistant cannot use that model for you",
          { reason: "subscription_model" },
        );
      if (!allowed.has(draft.model)) {
        const current = await send("GET", target);
        const session = current.ok
          ? ((await current.json().catch(() => null)) as { model?: unknown } | null)
          : (await current.body?.cancel(), null);
        if (session?.model !== draft.model)
          throw sitePublishingError(
            400,
            "validation_failed",
            "site_model_not_allowed",
            "This Site's assistant cannot use that model",
          );
      }
      return {
        text: draft.text,
        annotations: [],
        resources: [],
        model: draft.model,
        reasoningEffort: draft.reasoningEffort,
        latencyMode: draft.latencyMode,
      };
    };
    switch (id) {
      case "sessions.get":
        await settleSiteRuntimeSpend(deps, host, conversation);
        return await projected(await send("GET", target));
      case "sessions.events": {
        const payload = payloadNone ? ("none" as const) : ("summary" as const);
        const includeTypes = visibleIncludeTypes();
        // Asking only for hidden types yields nothing rather than everything.
        if (includeTypes === null) return siteSessionEventPage([], { payload });
        return await siteSessionEventPageResponse(
          await send("GET", `${target}/events${eventQuery(includeTypes ?? null)}`),
          { payload },
        );
      }
      case "sessions.stream":
        return siteSessionEventStreamResponse(
          await send("GET", `${target}/events/stream${streamQuery()}`),
        );
      case "sessions.queue":
        return await forwardView("GET", `${target}/queue`, siteQueueView);
      case "sessions.humanInput":
        return await forwardView(
          "GET",
          `${target}/human-input-requests${allowedQuery(url, ["status"])}`,
          siteHumanInputListView,
        );
      case "sessions.humanInput.get": {
        const requestId = /\/human-input-requests\/([^/]+)$/u.exec(request.suffix)?.[1];
        if (!requestId) throw unsupported();
        return await forwardView(
          "GET",
          `${target}/human-input-requests/${requestId}`,
          siteHumanInputRequestView,
        );
      }
      case "sessions.queue.item": {
        const item = /\/queue\/([^/]+)\/(move|edit|steer|delete)$/u.exec(request.suffix);
        if (!item) throw unsupported();
        const [, turnId, action] = item;
        const path = `${target}/queue/${turnId}/${action}`;
        switch (action) {
          case "move": {
            const move = parseJson(request.body, MoveSessionQueueItemRequest);
            requireSiteAgent(deps, host, viewer, limits);
            return await forwardView("POST", path, siteQueueMutationView, move);
          }
          case "edit": {
            const edit = parseJson(request.body, EditSessionQueueItemRequest);
            requireSiteAgent(deps, host, viewer, limits);
            return await forwardView("POST", path, siteQueueMutationView, edit);
          }
          case "delete": {
            const remove = parseJson(request.body, DeleteSessionQueueItemRequest);
            requireSiteAgent(deps, host, viewer, limits);
            return await forwardView("POST", path, siteQueueMutationView, remove);
          }
          default: {
            // Steering a queued message runs it now: the message was counted
            // when it was sent, but the agent and spend checks still apply.
            const steer = parseJson(request.body, SteerSessionQueueItemRequest);
            await admitAgentWork(false);
            return await forwardView("POST", path, siteQueueMutationView, steer);
          }
        }
      }
      case "sessions.composerDraft.get":
        return await forwardView("GET", `${target}/composer-draft`, siteDraftView);
      case "sessions.composerDraft.put": {
        const draft = parseJson(request.body, SaveComposerDraftRequest);
        requireSiteAgent(deps, host, viewer, limits);
        return await forwardView("PUT", `${target}/composer-draft`, siteDraftView, {
          ...(await siteDraft(draft)),
          expectedRevision: draft.expectedRevision,
        });
      }
      case "sessions.composerDraft.submit": {
        const submit = parseJson(request.body, SubmitComposerDraftRequest);
        if (
          submit.modelContext !== undefined ||
          (submit.mcpCredentialUpdates?.length ?? 0) > 0 ||
          submit.connectionAccounts.length > 0 ||
          submit.personalResourceAttachment !== undefined
        )
          throw invalid("Messages on a published Site are text only");
        const draft = await siteDraft(submit);
        await admitAgentWork(true);
        return await forwardView(
          "POST",
          `${target}/composer-draft/submit`,
          siteAcceptedMessageView,
          {
            ...draft,
            expectedDraftRevision: submit.expectedDraftRevision,
            clientEventId: submit.clientEventId,
            delivery: submit.delivery,
            ...(submit.controlEtag ? { controlEtag: submit.controlEtag } : {}),
          },
        );
      }
      case "sessions.send": {
        const message = parseJson(request.body, SendMessageRequest);
        await admitAgentWork(true);
        return await forwardView("POST", `${target}/events`, siteAcceptedEventView, {
          type: "user.message",
          ...(message.clientEventId ? { clientEventId: message.clientEventId } : {}),
          payload: { text: message.payload.text },
        });
      }
      case "sessions.steer": {
        const steer = parseJson(request.body, SteerRequest);
        await admitAgentWork(false);
        return await forwardView("POST", `${target}/steer`, siteAcceptedMessageView, {
          text: steer.text,
          ...(steer.clientEventId ? { clientEventId: steer.clientEventId } : {}),
        });
      }
      case "sessions.control": {
        const control = parseJson(request.body, SessionControlRequest);
        // Pausing or cancelling is always allowed; resuming starts work again.
        if (control.action === "resume") await admitAgentWork(false);
        const controlled = await send("POST", `${target}/control`, {
          action: control.action,
          clientEventId: control.clientEventId,
          ...(control.reason ? { reason: control.reason } : {}),
        });
        // Settled after the control applied: a cancelled conversation releases
        // its reservation at once.
        if (control.action !== "resume" && controlled.ok)
          await settleSiteRuntimeSpend(deps, host, conversation);
        if (!controlled.ok) return siteRuntimeForwardedResponse(controlled);
        return context.json(
          siteControlResultView(await controlled.json()) as object,
          controlled.status as 200,
        );
      }
      default:
        throw unsupported();
    }
  };

  /**
   * Undo a conversation start whose session does not exist (the create was
   * refused or failed before commit). A session that does exist stays
   * tracked: its usage limit caps it and settling releases what it does not use.
   */
  const releaseUnstarted = async (
    scope: { accountId: string; workspaceId: string },
    sessionId: string,
  ) => {
    // A failed read keeps the reservation: settling releases it once the
    // session is known to be missing or idle.
    const exists = await getSession(deps.db, scope.workspaceId, sessionId).then(
      (session) => session !== null,
      () => true,
    );
    if (!exists) await releaseSiteRuntimeConversationStart(deps.db, scope, { sessionId });
  };

  app.all(SITE_RUNTIME_API_PREFIX, handler);
  app.all(`${SITE_RUNTIME_API_PREFIX}/*`, handler);
}
