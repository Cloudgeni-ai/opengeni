import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  type SiteRuntimeConfig,
  type ToolRef,
} from "@opengeni/contracts";
import { withSiteSessionOrigin, type ApiRouteDeps } from "@opengeni/core";
import {
  admitSiteRuntimeConversationTurn,
  consumeSiteAuthCode,
  countSiteRuntimeConversationStart,
  createSiteAbuseReport,
  createSiteViewerSession,
  getOwnedSiteRuntimeConversation,
  getPublishedSiteVersion,
  insertSiteRuntimeConversation,
  isSiteWorkspaceMember,
  listOwnedSiteRuntimeConversations,
  readSiteRuntimeUsage,
  revokeSiteViewerSession,
  SiteDataError,
  SITE_RUNTIME_SITE_PRINCIPAL,
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
  applySiteRuntimeConversationLimit,
  enforceSiteRuntimeRate,
  findSiteRuntimeHost,
  meterSiteRuntime,
  requireServedSiteRuntimeHost,
  requireSiteAgent,
  requireSiteRuntimeBudgets,
  requireSiteRuntimeConversationBudget,
  resolveSiteRuntimeViewer,
  settleSiteRuntimeSpend,
  sha256Text,
  siteAgentRefusal,
  siteRuntimeForwardedResponse,
  siteRuntimeLimitProfile,
  siteRuntimeSessionRequest,
  siteTurnsExhausted,
  type SiteRuntimeHost,
} from "../site-publishing/runtime";
import {
  configuredSitesDomain,
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
    const body =
      method === "GET" || method === "HEAD"
        ? new Uint8Array()
        : new Uint8Array(await context.req.arrayBuffer());
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
      suffix: url.pathname.slice(SITE_RUNTIME_API_PREFIX.length),
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
    if (asked !== null && asked.trim().toLowerCase() !== request.fields.host)
      throw invalid("host must be the signed Site host");
    const found = await findSiteRuntimeHost(deps, request.domain, request.fields.host);
    if (!found)
      throw sitePublishingError(404, "not_found", "site_not_found", "This Site does not exist");
    return request.context.json(
      siteHostMapRecord(deps.settings, request.domain, found.publication, found.site),
    );
  };

  /** A viewer whose access is checked, with per-visitor request limits applied. */
  const viewing = async (request: RuntimeRequest) => {
    const host = await requireServedSiteRuntimeHost(deps, request.domain, request.fields.host);
    const viewer = await resolveSiteRuntimeViewer(deps, host, request.fields);
    const { limits, kind: profileKind } = await siteRuntimeLimitProfile(deps, host);
    await enforceSiteRuntimeRate(
      deps,
      host,
      viewer.principal,
      "requests",
      limits.requestsPerMinutePerVisitor,
    );
    return { host, viewer, limits, profileKind };
  };

  /** Immutable HTML of one version of this Site (never another Site's). */
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
      ? await getPublishedSiteVersion(deps.db, host.scope, host.site.id, parsed.data)
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
      `ip:${request.fields.clientIp || "unknown"}`,
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

  /** Abuse reports: anyone who reaches a served Site host, rate limited per reporter and per Site. */
  const report = async (request: RuntimeRequest): Promise<Response> => {
    const host = await requireServedSiteRuntimeHost(deps, request.domain, request.fields.host);
    const input = parseJson(request.body, SiteAbuseReportRequest);
    const reporter = request.fields.session
      ? `session:${sha256Text(request.fields.session).slice(0, 32)}`
      : request.fields.visitor
        ? `guest:${request.fields.visitor.slice(0, 128)}`
        : `ip:${request.fields.clientIp || "unknown"}`;
    await enforceSiteRuntimeRate(
      deps,
      host,
      reporter,
      "reports",
      deps.settings.sitesReportsPerMinutePerVisitor,
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
   * queries also count against the guest write limit, like Site Data.
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
                await enforceSiteRuntimeRate(
                  deps,
                  host,
                  viewer.principal,
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
    const guestWrite = async () => {
      if (viewer.kind === "guest")
        await enforceSiteRuntimeRate(
          deps,
          host,
          viewer.principal,
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
    const forward = async (method: string, path: string, body?: unknown) =>
      siteRuntimeForwardedResponse(
        await withSiteSessionOrigin(siteOrigin, async () =>
          dispatch(
            await siteRuntimeSessionRequest(deps, host, viewer, {
              origin: url.origin,
              method,
              path,
              ...(body === undefined ? {} : { body }),
            }),
          ),
        ),
      );
    const notFound = () =>
      sitePublishingError(
        404,
        "not_found",
        "site_conversation_not_found",
        "Conversation not found",
      );
    const usage = async () =>
      await readSiteRuntimeUsage(deps.db, host.scope, {
        siteId: host.site.id,
        viewerPrincipal: viewer.principal,
      });

    if (id === "sessions.list") {
      const owned = await listOwnedSiteRuntimeConversations(deps.db, host.scope, {
        siteId: host.site.id,
        viewerPrincipal: viewer.principal,
        limit: LIST_LIMIT,
      });
      const listed: unknown[] = [];
      for (const conversation of owned) {
        const response = await forward("GET", `${base}/${conversation.sessionId}`);
        if (response.ok) listed.push(await response.json());
        else await response.body?.cancel();
      }
      return context.json({ sessions: listed, nextCursor: null });
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
      // Settle the viewer's recent spend so the day budget sees it.
      for (const conversation of await listOwnedSiteRuntimeConversations(deps.db, host.scope, {
        siteId: host.site.id,
        viewerPrincipal: viewer.principal,
        limit: 5,
      }))
        await settleSiteRuntimeSpend(deps, host, conversation.sessionId);
      requireSiteRuntimeBudgets(limits, await usage(), { newConversation: true });
      const agent = host.publication.agent;
      const mcpTools: ToolRef[] = (agent.tools ?? [])
        .filter((tool) => SessionMcpServerIdPattern.test(tool))
        .map((tool) => ({ kind: "mcp", id: tool, optional: true }));
      const created = await forward("POST", base, {
        initialMessage: input.initialMessage,
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
        ...(input.idempotencyKey
          ? {
              idempotencyKey: `site-runtime:${sha256Text(
                `${host.site.id}\n${viewer.principal}\n${input.idempotencyKey}`,
              )}`,
            }
          : {}),
      });
      if (created.status !== 202) return created;
      const session = (await created.json()) as { id?: unknown };
      if (typeof session.id !== "string")
        throw sitePublishingError(
          502,
          "upstream_unavailable",
          "site_conversation_failed",
          "The conversation could not be started",
        );
      const existing = await getOwnedSiteRuntimeConversation(deps.db, host.scope, {
        sessionId: session.id,
        siteId: host.site.id,
        viewerPrincipal: viewer.principal,
      });
      if (!existing) {
        // The cap first: it is what bounds the conversation's spend.
        const capped = await applySiteRuntimeConversationLimit(
          deps,
          host,
          session.id,
          limits.agentMicrosPerConversation,
        );
        if (!capped) {
          // An uncapped conversation does not continue.
          await forward("POST", `${base}/${session.id}/control`, {
            action: "cancel",
            clientEventId: `site-runtime-uncapped:${session.id}`,
            reason: "The conversation could not be capped",
          }).then((response) => response.body?.cancel());
          throw sitePublishingError(
            503,
            "upstream_unavailable",
            "site_conversation_failed",
            "The conversation could not be started",
          );
        }
        await insertSiteRuntimeConversation(deps.db, host.scope, {
          sessionId: session.id,
          siteId: host.site.id,
          viewerPrincipal: viewer.principal,
          versionId: host.versionId,
        });
        await countSiteRuntimeConversationStart(deps.db, host.scope, {
          siteId: host.site.id,
          viewerPrincipal: viewer.principal,
        });
        // The initial message is the conversation's first turn.
        await admitSiteRuntimeConversationTurn(deps.db, host.scope, {
          sessionId: session.id,
          maxTurns: limits.turnsPerConversation,
        });
        await meterSiteRuntime(deps, host, { type: "conversation", viewer });
      }
      return context.json(session, 202);
    }

    const sessionId = /^\/sessions\/([^/]+)/u.exec(request.suffix)?.[1] ?? "";
    const conversation = await getOwnedSiteRuntimeConversation(deps.db, host.scope, {
      sessionId,
      siteId: host.site.id,
      viewerPrincipal: viewer.principal,
    });
    if (!conversation) throw notFound();
    const target = `${base}/${conversation.sessionId}`;
    const query = url.search;
    // An EventSource reconnect resumes from Last-Event-ID (forwarded by the
    // gateway); in-process dispatch carries it as the stream's `after` cursor.
    const streamQuery = () => {
      const params = new URLSearchParams(url.search);
      const lastEventId = request.context.req.header("last-event-id")?.trim();
      if (!params.has("after") && lastEventId && /^\d{1,15}$/u.test(lastEventId))
        params.set("after", lastEventId);
      const text = params.toString();
      return text ? `?${text}` : "";
    };
    // The agent and budget checks every message-bearing operation passes.
    const admitAgentWork = async (newTurn: boolean) => {
      requireSiteAgent(deps, host, viewer, limits);
      const spent = await settleSiteRuntimeSpend(deps, host, conversation.sessionId);
      requireSiteRuntimeConversationBudget(limits, spent ?? conversation.meteredMicros);
      requireSiteRuntimeBudgets(limits, await usage(), { newConversation: false });
      if (
        newTurn &&
        !(await admitSiteRuntimeConversationTurn(deps.db, host.scope, {
          sessionId: conversation.sessionId,
          maxTurns: limits.turnsPerConversation,
        }))
      )
        throw siteTurnsExhausted();
    };
    /**
     * A Site's composer drafts are text only: no workspace resources,
     * timeline annotations, credentials or connection accounts, and only a
     * model the Site allows (or the conversation's own).
     */
    const siteDraft = async (draft: {
      text: string;
      annotations?: readonly unknown[] | undefined;
      resources: readonly unknown[];
      model: string;
      reasoningEffort: unknown;
      latencyMode: unknown;
    }) => {
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
        const current = await forward("GET", target);
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
        await settleSiteRuntimeSpend(deps, host, conversation.sessionId);
        return await forward("GET", target);
      case "sessions.events":
        return await forward("GET", `${target}/events${query}`);
      case "sessions.stream":
        return await forward("GET", `${target}/events/stream${streamQuery()}`);
      case "sessions.queue":
        return await forward("GET", `${target}/queue${query}`);
      case "sessions.humanInput":
        return await forward("GET", `${target}/human-input-requests${query}`);
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
          case "move":
            return await forward(
              "POST",
              path,
              parseJson(request.body, MoveSessionQueueItemRequest),
            );
          case "edit":
            return await forward(
              "POST",
              path,
              parseJson(request.body, EditSessionQueueItemRequest),
            );
          case "delete":
            return await forward(
              "POST",
              path,
              parseJson(request.body, DeleteSessionQueueItemRequest),
            );
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
      case "sessions.send":
      case "sessions.steer":
      case "sessions.control": {
        const message =
          id === "sessions.send"
            ? parseJson(request.body, SendMessageRequest)
            : id === "sessions.steer"
              ? parseJson(request.body, SteerRequest)
              : null;
        const control =
          id === "sessions.control" ? parseJson(request.body, SessionControlRequest) : null;
        requireSiteAgent(deps, host, viewer, limits);
        const spent = await settleSiteRuntimeSpend(deps, host, conversation.sessionId);
        if (control === null || control.action === "resume") {
          requireSiteRuntimeConversationBudget(limits, spent ?? conversation.meteredMicros);
          requireSiteRuntimeBudgets(limits, await usage(), { newConversation: false });
        }
        if (message !== null) {
          const admitted = await admitSiteRuntimeConversationTurn(deps.db, host.scope, {
            sessionId: conversation.sessionId,
            maxTurns: limits.turnsPerConversation,
          });
          if (!admitted) throw siteTurnsExhausted();
        }
        if (id === "sessions.send") {
          const send = message as z.infer<typeof SendMessageRequest>;
          return await forward("POST", `${target}/events`, {
            type: "user.message",
            ...(send.clientEventId ? { clientEventId: send.clientEventId } : {}),
            payload: { text: send.payload.text },
          });
        }
        if (id === "sessions.steer") {
          const steer = message as z.infer<typeof SteerRequest>;
          return await forward("POST", `${target}/steer`, {
            text: steer.text,
            ...(steer.clientEventId ? { clientEventId: steer.clientEventId } : {}),
          });
        }
        return await forward("POST", `${target}/control`, {
          action: control!.action,
          clientEventId: control!.clientEventId,
          ...(control!.reason ? { reason: control!.reason } : {}),
        });
      }
      default:
        throw unsupported();
    }
  };

  app.all(SITE_RUNTIME_API_PREFIX, handler);
  app.all(`${SITE_RUNTIME_API_PREFIX}/*`, handler);
}
