import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
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
  type SiteLimitProfileKind,
  SITE_GATEWAY_CALLBACK_PATH,
  SITE_RUNTIME_API_PREFIX,
  SITE_TOOL_METHODS,
  SteerSessionQueueItemRequest,
  SubmitComposerDraftRequest,
  type SiteAuthExchangeResponse,
  type SiteEmbeddedAgent,
  type SiteRuntimeConfig,
  type ToolRef,
} from "@opengeni/contracts";
import {
  withHostSessionUsageLimit,
  withSiteSessionOrigin,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  consumeSiteAuthCode,
  createSiteAbuseReport,
  createSiteViewerSession,
  getOwnedSiteRuntimeConversation,
  getServableSiteVersion,
  getSession,
  isSiteWorkspaceMember,
  listOwnedSiteRuntimeConversations,
  releaseSiteRuntimeConversationStart,
  reserveSiteRuntimeConversationStart,
  reserveSiteRuntimeConversationWork,
  revokeSiteViewerSession,
  SiteDataError,
  SITE_RUNTIME_SITE_PRINCIPAL,
  type SiteRuntimeReservation,
} from "@opengeni/db";
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
  precheckSiteGatewayRequest,
  verifySiteGatewayRequest,
  type SiteGatewayFields,
} from "../site-publishing/gateway-signature";
import {
  enforceSiteRuntimeRate,
  enforceSiteRuntimeViewerRate,
  findSiteRuntimeHost,
  meterSiteRuntime,
  requireServedSiteRuntimeHost,
  requireSiteAgent,
  resolveSiteRuntimeViewer,
  settleSiteRuntimeSpend,
  sha256Text,
  siteAgentRefusal,
  siteBudgetExhausted,
  siteClientAddressPrincipal,
  siteRuntimeBudgetLimits,
  siteRuntimeForwardedResponse,
  siteRuntimeLimitProfile,
  siteRuntimeSessionRequest,
  siteWideBudget,
  sweepSiteRuntimeReservations,
  SITE_GUEST_IP_LIMIT_FACTOR,
  type SiteRuntimeHost,
} from "../site-publishing/runtime";
import {
  configuredSitesDomain,
  healSiteEdgeIfStale,
  notifySiteAbuse,
  setSitePublishingDispatch,
  siteHostMapRecord,
  sitePublishingError,
} from "../site-publishing/service";
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

async function runSiteData<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SiteDataError) throw siteDataHttpError(error);
    throw error;
  }
}

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
 * Read a request body of at most `limit` bytes: a larger declared length is
 * refused before reading, and the stream is cut off once it passes the cap.
 */
async function readCappedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length")?.trim();
  if (declared && (!/^\d{1,15}$/u.test(declared) || Number(declared) > limit))
    throw tooLarge(limit);
  if (!request.body) return new Uint8Array();
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
  return body;
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
  const usage = value.usageLimit;
  if (usage && typeof usage === "object" && !Array.isArray(usage))
    projected.usageLimit = pick(usage as Record<string, unknown>, SITE_USAGE_LIMIT_FIELDS);
  return projected;
}

/** Query parameters forwarded per session read (anything else is dropped). */
const EVENT_QUERY = [
  "after",
  "before",
  "limit",
  "direction",
  "latest",
  "includeTypes",
  "excludeTypes",
  "includeClasses",
  "excludeClasses",
] as const;

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
 * The workspace tools a Site conversation gets: the Site's admin-chosen MCP
 * connections for signed-in viewers, and for guests only when an admin opted
 * them in (`guestTools`). Optional references: a connection the workspace
 * does not have is skipped rather than failing the conversation.
 */
export function siteAgentToolRefs(
  agent: Pick<SiteEmbeddedAgent, "tools" | "guestTools">,
  viewer: Pick<SiteRuntimeViewer, "kind">,
): ToolRef[] {
  const toolIds = viewer.kind !== "guest" || agent.guestTools ? (agent.tools ?? []) : [];
  return toolIds
    .filter((tool) => SessionMcpServerIdPattern.test(tool))
    .map((tool) => ({ kind: "mcp", id: tool, optional: true }));
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
  // Publication changes cancel a Site's conversations through this dispatch.
  setSitePublishingDispatch(deps.settings, dispatch);

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
    // it. The header and clock checks run before the body is read.
    const pre = precheckSiteGatewayRequest({ headers: context.req.raw.headers, secrets });
    if (!pre.ok) throw refuse(pre.reason);
    const suffix = url.pathname.slice(SITE_RUNTIME_API_PREFIX.length);
    const body =
      method === "GET" || method === "HEAD"
        ? new Uint8Array()
        : await readCappedBody(
            context.req.raw,
            method === "POST" && suffix === FILE_UPLOAD_SUFFIX
              ? SITE_RUNTIME_FILE_BODY_LIMIT
              : SITE_RUNTIME_JSON_BODY_LIMIT,
          );
    const verified = verifySiteGatewayRequest({
      method,
      pathWithQuery: `${url.pathname}${url.search}`,
      headers: context.req.raw.headers,
      body,
      secrets,
    });
    if (!verified.ok) throw refuse(verified.reason);
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
    const { limits, kind: profileKind } = await siteRuntimeLimitProfile(deps, host);
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
   * Abuse reports: anyone who reaches a served Site host, rate limited per
   * reporter, per client address and per Site. Each report also reaches the
   * platform (a structured log line, and an email when an abuse address is set).
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
      await enforceSiteRuntimeRate(
        deps,
        host,
        address,
        "reports",
        perVisitor * SITE_GUEST_IP_LIMIT_FACTOR,
      );
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

  /**
   * Workspace tools from a published Site. The tool gateway runs only for a
   * person present in Opengeni (a canonical human session); a site-session is
   * not one, so published Sites cannot call tools yet. Refused after the
   * signature, host and viewer checks so the gateway sees a stable error.
   */
  const tools = async (request: RuntimeRequest, method: string): Promise<Response> => {
    if (!(SITE_TOOL_METHODS as readonly string[]).includes(method)) throw unsupported();
    await viewing(request);
    throw sitePublishingError(
      403,
      "forbidden",
      "site_tools_unavailable",
      "Published Sites cannot use workspace tools",
    );
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
        const config: SiteRuntimeConfig = {
          siteId: host.site.id,
          title: host.site.title,
          hostname: host.hostname,
          versionId: host.versionId,
          access: effectiveSiteAccess(host.publication.access, deps.settings),
          viewer: publicSiteViewer(viewer),
          agent: {
            enabled: siteAgentRefusal(deps, host, viewer, limits) === null,
            model: host.publication.agent.model,
          },
          siteData: true,
          noindex: host.publication.noindex || deps.settings.sitesForceNoindex,
          abuseEmail: deps.settings.sitesAbuseEmail ?? `abuse@${request.domain}`,
        };
        return context.json(config);
      }
      case "models.list": {
        const models = [
          ...new Set(
            [host.publication.agent.model, ...(limits.agentModels ?? [])].filter(
              (model): model is string => typeof model === "string" && model.length > 0,
            ),
          ),
        ];
        return context.json({
          models: models.map((model) => ({ id: model })),
          defaultModel: host.publication.agent.model,
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
  ): PublishedSiteDataViewer => ({
    kind: "published_viewer",
    accountId: host.scope.accountId,
    workspaceId: host.scope.workspaceId,
    site: {
      id: host.site.id,
      title: host.site.title,
      status: host.site.status,
      visibility: host.site.visibility,
      ownerSubjectId: host.site.ownerSubjectId,
      createdBySubjectId: host.site.createdBySubjectId,
    },
    principal: viewer.principal,
    guest: viewer.kind === "guest",
  });

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
    // Every forwarded call runs inside the Site's origin (OPE-801), and also
    // carries the Site and version headers the API's Site frame guard
    // validates; sessions and turns it starts record this Site and version.
    const siteOrigin = { siteId: host.site.id, title: host.site.title, versionId: host.versionId };
    const send = async (method: string, path: string, body?: unknown) =>
      await withSiteSessionOrigin(siteOrigin, async () =>
        dispatch(
          await siteRuntimeSessionRequest(deps, host, viewer, {
            origin: url.origin,
            method,
            path,
            ...(body === undefined ? {} : { body }),
          }),
        ),
      );
    const forward = async (method: string, path: string, body?: unknown) =>
      siteRuntimeForwardedResponse(await send(method, path, body));
    /** A forwarded session read, answered with the Site-safe projection. */
    const projected = async (response: Response, status = response.status) => {
      if (!response.ok) return siteRuntimeForwardedResponse(response);
      return context.json(siteSessionProjection(await response.json()), status as 200);
    };
    const notFound = () =>
      sitePublishingError(
        404,
        "not_found",
        "site_conversation_not_found",
        "Conversation not found",
      );
    const budgets = siteRuntimeBudgetLimits(limits);
    /** Reserve, and when a Site-wide budget refuses, settle stale reservations and retry once. */
    const reserve = async (run: () => Promise<SiteRuntimeReservation>) => {
      let reservation = await run();
      if (siteWideBudget(reservation)) {
        await sweepSiteRuntimeReservations(deps, host);
        reservation = await run();
      }
      if (!reservation.ok) throw siteBudgetExhausted(reservation.budget);
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
      if (input.idempotencyKey) {
        const replay = await getOwnedSiteRuntimeConversation(deps.db, host.scope, {
          sessionId: requestedSessionId,
          siteId: host.site.id,
          viewerPrincipal: viewer.principal,
        });
        if (replay) return await projected(await send("GET", `${base}/${replay.sessionId}`), 202);
      }
      // Settle the viewer's recent spend so the day budget sees it.
      for (const conversation of await listOwnedSiteRuntimeConversations(deps.db, host.scope, {
        siteId: host.site.id,
        viewerPrincipal: viewer.principal,
        limit: 5,
      }))
        await settleSiteRuntimeSpend(deps, host, conversation);
      // One transaction counts the start and reserves the conversation's whole
      // cap against the visitor's day and the Site's day and month; the cap
      // becomes the session's usage limit, set in the create transaction.
      const reservation = await reserve(() =>
        reserveSiteRuntimeConversationStart(deps.db, host.scope, {
          sessionId: requestedSessionId,
          siteId: host.site.id,
          viewerPrincipal: viewer.principal,
          versionId: host.versionId,
          limits: budgets,
        }),
      );
      const agent = host.publication.agent;
      const mcpTools = siteAgentToolRefs(agent, viewer);
      const body = {
        initialMessage: input.initialMessage,
        requestedSessionId,
        startMode: "standard",
        agentAccess: "session",
        memoryScope: "off",
        rigId: null,
        firstPartyMcpTools: [],
        agent: { capabilities: { from: "none", humanInput: false, skills: false } },
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.instructions?.trim() ? { instructions: agent.instructions.trim() } : {}),
        ...(mcpTools.length > 0 ? { tools: mcpTools } : {}),
        metadata: {
          opengeniPublishedSite: {
            siteId: host.site.id,
            versionId: host.versionId,
            viewerKind: viewer.kind,
          },
        },
        ...(input.idempotencyKey ? { idempotencyKey: `site-runtime:${requestedSessionId}` } : {}),
      };
      const start = () => send("POST", base, body);
      let created: Response;
      try {
        created =
          reservation.limitMicros === null
            ? await start()
            : await withHostSessionUsageLimit(
                { subjectId: `site:${host.site.id}`, limitMicros: reservation.limitMicros },
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
     * Event pages are monitoring reads: bounded pages, summarized oversized
     * payloads, never a forensic or full-payload read. The stream delivers
     * complete events.
     */
    const eventQuery = () => {
      const payloadMode = url.searchParams.get("payloadMode");
      return allowedQuery(url, EVENT_QUERY, {
        mode: "monitoring",
        ...(payloadMode === "none" ? { payloadMode: "none" } : { payloadMode: "summary" }),
      });
    };
    // The agent and budget checks every message-bearing operation passes.
    const admitAgentWork = async (newTurn: boolean) => {
      requireSiteAgent(deps, host, viewer, limits);
      await settleSiteRuntimeSpend(deps, host, conversation);
      await reserve(() =>
        reserveSiteRuntimeConversationWork(deps.db, host.scope, {
          sessionId: conversation.sessionId,
          limits: budgets,
          newTurn,
        }),
      );
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
      const allowed = new Set(
        [host.publication.agent.model, ...(limits.agentModels ?? [])].filter(
          (model): model is string => typeof model === "string" && model.length > 0,
        ),
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
      case "sessions.events":
        return await forward("GET", `${target}/events${eventQuery()}`);
      case "sessions.stream":
        return await forward("GET", `${target}/events/stream${streamQuery()}`);
      case "sessions.queue":
        return await forward("GET", `${target}/queue`);
      case "sessions.humanInput":
        return await forward(
          "GET",
          `${target}/human-input-requests${allowedQuery(url, ["status"])}`,
        );
      case "sessions.humanInput.get": {
        const requestId = /\/human-input-requests\/([^/]+)$/u.exec(request.suffix)?.[1];
        if (!requestId) throw unsupported();
        return await forward("GET", `${target}/human-input-requests/${requestId}`);
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
            return await forward("POST", path, move);
          }
          case "edit": {
            const edit = parseJson(request.body, EditSessionQueueItemRequest);
            requireSiteAgent(deps, host, viewer, limits);
            return await forward("POST", path, edit);
          }
          case "delete": {
            const remove = parseJson(request.body, DeleteSessionQueueItemRequest);
            requireSiteAgent(deps, host, viewer, limits);
            return await forward("POST", path, remove);
          }
          default: {
            // Steering a queued message runs it now: the message was counted
            // when it was sent, but the agent and spend checks still apply.
            const steer = parseJson(request.body, SteerSessionQueueItemRequest);
            await admitAgentWork(false);
            return await forward("POST", path, steer);
          }
        }
      }
      case "sessions.composerDraft.get":
        return await forward("GET", `${target}/composer-draft`);
      case "sessions.composerDraft.put": {
        const draft = parseJson(request.body, SaveComposerDraftRequest);
        requireSiteAgent(deps, host, viewer, limits);
        return await forward("PUT", `${target}/composer-draft`, {
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
        return await forward("POST", `${target}/composer-draft/submit`, {
          ...draft,
          expectedDraftRevision: submit.expectedDraftRevision,
          clientEventId: submit.clientEventId,
          delivery: submit.delivery,
          ...(submit.controlEtag ? { controlEtag: submit.controlEtag } : {}),
        });
      }
      case "sessions.send": {
        const message = parseJson(request.body, SendMessageRequest);
        await admitAgentWork(true);
        return await forward("POST", `${target}/events`, {
          type: "user.message",
          ...(message.clientEventId ? { clientEventId: message.clientEventId } : {}),
          payload: { text: message.payload.text },
        });
      }
      case "sessions.steer": {
        const steer = parseJson(request.body, SteerRequest);
        await admitAgentWork(false);
        return await forward("POST", `${target}/steer`, {
          text: steer.text,
          ...(steer.clientEventId ? { clientEventId: steer.clientEventId } : {}),
        });
      }
      case "sessions.control": {
        const control = parseJson(request.body, SessionControlRequest);
        // Pausing or cancelling is always allowed; resuming starts work again.
        if (control.action === "resume") await admitAgentWork(false);
        else await settleSiteRuntimeSpend(deps, host, conversation);
        return await forward("POST", `${target}/control`, {
          action: control.action,
          clientEventId: control.clientEventId,
          ...(control.reason ? { reason: control.reason } : {}),
        });
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
