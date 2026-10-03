import type { OpenGeniEmbeddingClient } from "./embedding-client";
import { OpenGeniApiError, OpenGeniSetupError } from "./errors";
import { chatDefaults, type Chats } from "./chats";
import { SESSION_SCOPE_HEADER } from "./message-links";
import type { WorkspaceIdOptions, WorkspaceIdTarget } from "./tenant-workspaces";
import { proxySessionEventStream } from "./proxy";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "./types";
import type { CreateSessionRequest, SessionMcpCredentialUpdateInput } from "./types";
import { mintToolToken, resolveToolTokenSecret } from "./tool-auth";
import {
  downloadSessionProxySiteHtml,
  getSessionProxyArtifactAssociation,
  getSessionProxyWorkspaceGrant,
  SESSION_PROXY_SITE_HTML_MAX_BYTES,
  SessionProxySiteHtmlTooLargeError,
} from "./session-proxy-client";
export {
  downloadSessionProxySiteHtml,
  getSessionProxyArtifactAssociation,
  getSessionProxyWorkspaceGrant,
  SESSION_PROXY_SITE_HTML_MAX_BYTES,
  SessionProxySiteHtmlTooLargeError,
} from "./session-proxy-client";

/**
 * Packaged same-origin backend for the React conversation surfaces.
 *
 * Mount the handler at a catch-all route (for example `/api/opengeni/*`) and
 * point an unmodified browser `OpenGeniClient({ baseUrl: "/api/opengeni" })`
 * at it. Every request is authenticated by the host's `resolve` hook, pinned
 * to the resolved workspace, executed as the resolved external user through
 * `asUser` (never the organization key's own service authority), and limited
 * to the exact native routes `SessionConversation` and its hooks use. It is
 * an explicit dispatcher, not an arbitrary upstream proxy.
 */

type ProxyClient = OpenGeniEmbeddingClient;

/** The `@opengeni/sdk/chat` `OpenGeni` facade, structurally. */
type ProxyFacade = {
  readonly client: ProxyClient;
  readonly source: string;
  workspaceId(target: { tenant: string }): Promise<string>;
  workspaceIdFor?(target: WorkspaceIdTarget, options: WorkspaceIdOptions): Promise<string>;
};

/** Who the authenticated request acts as. Never derive any of it from the request body or path. */
export type SessionProxyResolution = (
  | { workspaceId: string; tenant?: undefined }
  /** Tenant mapping requires passing the `OpenGeni` facade from `@opengeni/sdk/chat`. */
  | { tenant: string; workspaceId?: undefined }
) & {
  /** Host-authenticated external user id; every call runs through `asUser(user)`. */
  user: string;
  /** External identity source. Defaults to the facade's `source`, else `"default"`. */
  source?: string | undefined;
};

/** Host auth hook: return the resolution, or a `Response` (for example 401) to reject. */
export type SessionProxyResolve = (
  request: Request,
) => Promise<SessionProxyResolution | Response> | SessionProxyResolution | Response;

export type SessionProxyContext = {
  request: Request;
  workspaceId: string;
  user: string;
  source: string;
  /** The `asUser` client the proxy uses for this request. */
  client: ProxyClient;
};

/** The only fields a browser may send when creating a session through the proxy. */
export type SessionProxyCreateInput = {
  initialMessage: string;
  /** Browser retry key; replay is scoped to the acting user by the API. */
  idempotencyKey?: string | undefined;
};

/** Which browser action is about to forward a user message or response. */
export type SessionProxyMessageInput = {
  /** Absent for `create`. */
  sessionId?: string | undefined;
  delivery: "create" | "send" | "steer" | "submit";
};

/** Server-side additions the host attaches to one forwarded user message or response. */
export type SessionProxyMessageExtras = {
  /**
   * Model-visible context for this message (current page, time zone, today's
   * date). Placed before any context the browser sent. Not secret. Ignored for
   * approval decisions and human-input responses, which are not new messages.
   */
  modelContext?: string | undefined;
  /**
   * Header-only credential rotation for MCP servers already attached to the
   * session (for example a fresh short-lived per-user bearer), applied
   * atomically as the message or response is accepted. Ignored for `create`,
   * where the `createSession` hook sets the initial headers.
   */
  mcpCredentialUpdates?: SessionMcpCredentialUpdateInput[] | undefined;
};

/**
 * Your product's own MCP tool server, attached to every session this proxy
 * creates with a per-user bearer token. Verify it on every MCP request with
 * `verifyToolRequest` from `@opengeni/sdk/tool-auth`. Tools always act as the
 * chat's creator: in a shared chat, other members' messages do not change it.
 */
export type SessionProxyToolServer = {
  /**
   * Public HTTPS URL of your MCP endpoint, e.g. `https://app.example.com/api/mcp`.
   * Defaults to `OPENGENI_TOOL_SERVER_URL`, which `verifyToolRequest` also reads.
   */
  url?: string | undefined;
  /** Session MCP server id (model-facing tool prefix). Defaults to `"app"`. */
  id?: string | undefined;
  /** Display name. */
  name?: string | undefined;
  /**
   * Tools the user must approve before each call: list your write tools here
   * (unprefixed MCP tool names), or `true` for every tool. Others run directly.
   */
  approvals?: { ask: string[] | true } | undefined;
  /** Token signing secret. Defaults to `OPENGENI_API_KEY`; `verifyToolRequest` must use the same. */
  secret?: string | undefined;
  /** Token lifetime in seconds. Defaults to 24 hours; refreshed on every message, approval, and answer. */
  ttlSeconds?: number | undefined;
};

export type SessionProxyHandlerOptions = {
  /**
   * Private (default) uses personal Knowledge and session-only reach; shared uses
   * workspace Knowledge and reach. Isolated also gives each user their own tenant workspace.
   */
  chats?: Chats | undefined;
  /** Mandatory host auth hook, called on every request. */
  resolve: SessionProxyResolve;
  /**
   * Host CSRF/session policy for non-GET requests. Without it the proxy only
   * rejects `Sec-Fetch-Site: cross-site` mutations and requires JSON bodies;
   * cookie-authenticated hosts should supply their existing CSRF check.
   */
  authorizeMutation?: ((request: Request) => boolean | Promise<boolean>) | undefined;
  /**
   * Optional product-level session check (for example "this ticket's session
   * belongs to this user"). OpenGeni still enforces membership and private
   * visibility on every call.
   */
  authorizeSession?:
    | ((sessionId: string, context: SessionProxyContext) => boolean | Promise<boolean>)
    | undefined;
  /**
   * Server-controlled session creation. The browser supplies only
   * {@link SessionProxyCreateInput}; this hook returns the complete create
   * request (agent, tools, MCP servers, Skills, instructions, model policy). Omit it
   * to disable browser-initiated creation entirely.
   */
  createSession?:
    | ((
        input: SessionProxyCreateInput,
        context: SessionProxyContext,
      ) => CreateSessionRequest | Response | Promise<CreateSessionRequest | Response>)
    | undefined;
  /**
   * Called before every forwarded user message (send, steer, composer submit,
   * and browser-started create), approval decision, and human-input response.
   * Return server-owned `modelContext` (messages only) and MCP credential
   * rotations, or a `Response` to reject the action.
   */
  beforeForwardMessage?:
    | ((
        input: SessionProxyMessageInput,
        context: SessionProxyContext,
      ) =>
        | SessionProxyMessageExtras
        | Response
        | undefined
        | Promise<SessionProxyMessageExtras | Response | undefined>)
    | undefined;
  /**
   * Attach your product's MCP tool server to every session the `createSession`
   * hook creates, authenticated as the resolved user. The proxy mints the
   * token, adds the `mcpServers` entry (plus an eager ref when the hook lists
   * explicit `tools`), and rotates the token on every send, steer, submit,
   * approval decision, and human-input answer.
   */
  toolServer?: SessionProxyToolServer | undefined;
  /** Mount prefix, e.g. `/api/opengeni`. Defaults to everything before the first `/v1/`. */
  basePath?: string | undefined;
  /** Maximum JSON request body. Defaults to 1 MiB. */
  maxBodyBytes?: number | undefined;
  /** Expose composer file attachments (upload begin/complete, download URL). Defaults to true. */
  files?: boolean | undefined;
  /**
   * Let the browser read a file from the session's sandbox (`POST .../fs/read`)
   * so `sandbox:` links in agent replies can be downloaded. Only `path`,
   * `encoding`, and `maxBytes` are forwarded; OpenGeni still requires the
   * user's `files:read` permission on that session. Explicit opt-in, default
   * false. Reads are confined to its working directory, including on Connected
   * Machines; symlinked paths are refused.
   */
  sandboxFiles?: boolean | undefined;
  /**
   * Serve the embedded artifact viewer and inline Site previews: reads of the
   * editable artifacts and Sites a session produced, and live-ticket minting
   * for the editor. Explicit opt-in, default false.
   *
   * Every request must name its session in the `x-opengeni-session-id` header
   * (`SessionArtifactViewer` and `SessionConversation` do this). The proxy
   * runs `authorizeSession`, then only forwards an artifact OpenGeni associates with
   * that session, so the browser cannot open other workspace artifacts through
   * it. Editing still requires the user's own `artifacts:publish` grant. Site
   * tool calls are not proxied.
   *
   * The editor's live socket is ticket-authenticated and connects to OpenGeni
   * directly; the ticket binds the source session and the API revalidates its
   * authority while connected. `editableLiveUrl` overrides the derived URL.
   * Site HTML streams with backpressure and cancellation, with a 25 MiB
   * actual-byte ceiling (`SESSION_PROXY_SITE_HTML_MAX_BYTES`). Oversize streams
   * fail with `SessionProxySiteHtmlTooLargeError` / `site_html_too_large`;
   * headers cannot be replaced once streaming has begun.
   */
  artifacts?: boolean | { editableLiveUrl?: string | undefined } | undefined;
  /**
   * Chat list for `SessionList` / `OpenGeniChat` (`listSessionPage` only).
   * `"mine"` (default) lists sessions the resolved user created; `"visible"`
   * lists every session OpenGeni lets that user read in the workspace (shared
   * chats included); `false` disables listing.
   */
  sessionList?: "mine" | "visible" | false | undefined;
  /** Let the user archive or restore their own chats. Defaults to true. */
  archive?: boolean | undefined;
  /**
   * Let the browser choose model, reasoning effort, and latency per message
   * or draft (still limited by the workspace model catalog). When false those
   * choices are removed from messages and draft saves. Saves use the actor's
   * server-owned draft policy (initially the session defaults). Submit must repeat
   * the saved policy unchanged as an integrity fence, not a new selection: the
   * API atomically checks the saved revision/content or replays the original
   * receipt. Hide the composer's model picker to match. Defaults to true.
   * Pass `true` explicitly to also show end users the stock model picker
   * (`SessionConversation`/`OpenGeniChat` hide it unless asked).
   */
  modelSelection?: boolean | undefined;
  /** SSE heartbeat interval. Defaults to 15 seconds. */
  heartbeatMs?: number | undefined;
};

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const QUEUE_OPERATIONS: ReadonlySet<string> = new Set(["move", "edit", "steer", "delete"]);
const CREATE_FIELDS: ReadonlySet<string> = new Set(["initialMessage", "idempotencyKey"]);
const MODEL_FIELDS = ["model", "reasoningEffort", "latencyMode"] as const;

class ProxyRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function reject(status: number, code: string, message: string): never {
  throw new ProxyRejection(status, code, message);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function errorJson(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function isFacade(target: ProxyClient | ProxyFacade): target is ProxyFacade {
  return !("asUser" in target) && "client" in target;
}

/**
 * Create the packaged session proxy. Returns a web-standard
 * `(Request) => Promise<Response>` for Next.js route handlers, Hono, Bun.serve,
 * Cloudflare Workers, and similar hosts.
 */
export function createSessionProxyHandler(
  target: ProxyClient | ProxyFacade,
  options: SessionProxyHandlerOptions,
): (request: Request) => Promise<Response> {
  const service = isFacade(target) ? target.client : target;
  const defaultSource = isFacade(target) ? target.source : "default";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const filesEnabled = options.files ?? true;
  const sandboxFilesEnabled = options.sandboxFiles === true;
  const artifactsEnabled = options.artifacts !== undefined && options.artifacts !== false;
  const editableLiveUrl = artifactsEnabled
    ? liveSocketUrl(
        (typeof options.artifacts === "object" ? options.artifacts.editableLiveUrl : undefined) ??
          service.apiUrl(EDITABLE_ARTIFACT_LIVE_PATH),
      )
    : null;
  const modelSelection = options.modelSelection ?? true;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const sessionList = options.sessionList ?? "mine";
  const archiveEnabled = options.archive ?? true;
  const chats = options.chats ?? "private";
  const defaults = chatDefaults(chats);
  const toolServer = options.toolServer ? normalizeToolServer(options.toolServer) : undefined;
  // Whether a session carries this proxy's tool server (attachments are immutable).
  const toolSessions = new Map<string, Promise<string | null>>();
  // Canonical subject per external user, for the "mine" list filter.
  const subjects = new Map<string, Promise<string>>();
  const subjectOf = (client: ProxyClient, key: string): Promise<string> => {
    let subject = subjects.get(key);
    if (!subject) {
      subject = client.getAccessContext().then((access) => access.subjectId);
      subject.catch(() => subjects.delete(key));
      if (subjects.size >= 1_000) subjects.delete(subjects.keys().next().value!);
      subjects.set(key, subject);
    }
    return subject;
  };

  return async (request) => {
    try {
      const method = request.method;
      if (!["GET", "POST", "PUT", "PATCH"].includes(method)) {
        return new Response(null, {
          status: 405,
          headers: { Allow: "GET, POST, PUT, PATCH" },
        });
      }
      const resolved = await options.resolve(request);
      if (resolved instanceof Response) return resolved;
      if (typeof resolved?.user !== "string" || !resolved.user) {
        // Never fall back to the organization key's service authority.
        return errorJson(401, "user_required", "Authentication required.");
      }
      const url = new URL(request.url);
      const segments = routeSegments(url.pathname, options.basePath);
      if (!segments) return errorJson(404, "route_not_allowed", "Not found.");

      if (method !== "GET") {
        const allowed = options.authorizeMutation
          ? await options.authorizeMutation(request)
          : request.headers.get("sec-fetch-site") !== "cross-site";
        if (!allowed) return errorJson(403, "mutation_denied", "Request denied.");
      }
      const source = resolved.source ?? defaultSource;
      let workspaceId: string;
      if (chats === "isolated") {
        if (!resolved.tenant || !isFacade(target) || !target.workspaceIdFor) {
          throw new TypeError(
            'chats: "isolated" requires the OpenGeni facade and a tenant resolution.',
          );
        }
        workspaceId = await target.workspaceIdFor(
          { tenant: resolved.tenant, user: resolved.user, source },
          { isolation: "user" },
        );
      } else if (resolved.workspaceId) {
        workspaceId = resolved.workspaceId;
      } else if (resolved.tenant && isFacade(target)) {
        workspaceId = await target.workspaceId({ tenant: resolved.tenant });
      } else {
        throw new TypeError(
          "resolve must return a workspaceId (or a tenant when given the OpenGeni facade).",
        );
      }
      const client = service.asUser(resolved.user, { source });
      const context: SessionProxyContext = {
        request,
        workspaceId,
        user: resolved.user,
        source,
        client,
      };

      const call = { signal: request.signal };
      const toolToken = async () =>
        await mintToolToken({
          audience: toolServer!.url,
          user: resolved.user,
          tenant: resolved.tenant,
          workspaceId,
          source,
          secret: toolServer!.secret,
          ttlSeconds: toolServer!.ttlSeconds,
        });
      /** The creator's subject when the session carries this tool server, else null. */
      const toolServerOwner = (sessionId: string): Promise<string | null> => {
        const key = `${workspaceId}\u0000${sessionId}`;
        let attached = toolSessions.get(key);
        if (!attached) {
          attached = client
            .getSession(workspaceId, sessionId, call)
            .then((session) =>
              (session.mcpServers ?? []).some(
                (server) => server.id === toolServer!.id && server.url === toolServer!.url,
              )
                ? (session.createdBy?.subjectId ?? null)
                : null,
            );
          attached.catch(() => toolSessions.delete(key));
          if (toolSessions.size >= 1_000) toolSessions.delete(toolSessions.keys().next().value!);
          toolSessions.set(key, attached);
        }
        return attached;
      };
      const messageExtras = async (
        input: SessionProxyMessageInput,
      ): Promise<SessionProxyMessageExtras | Response | undefined> => {
        const extras = options.beforeForwardMessage
          ? await options.beforeForwardMessage(input, context)
          : undefined;
        if (extras instanceof Response || !toolServer || !input.sessionId) return extras;
        const updates = extras?.mcpCredentialUpdates ?? [];
        // A host-supplied rotation for the same id wins; sessions created
        // without this tool server (or for an older URL) are left alone.
        if (updates.some((update) => update.id === toolServer.id)) return extras;
        // Only the chat's creator refreshes: tools keep acting as that user.
        const owner = await toolServerOwner(input.sessionId);
        if (!owner || owner !== (await subjectOf(client, `${source}\u0000${resolved.user}`))) {
          return extras;
        }
        return {
          ...extras,
          mcpCredentialUpdates: [
            ...updates,
            {
              id: toolServer.id,
              headers: { Authorization: `Bearer ${await toolToken()}` },
            },
          ],
        };
      };
      /** Browser input sanitized, then server-owned extras merged in. */
      const forwardMessage = async (
        value: unknown,
        input: SessionProxyMessageInput,
      ): Promise<Record<string, unknown> | Response> => {
        // Submit repeats the saved policy as a mandatory integrity fence. Never
        // replace it with a newer draft's policy: outcome-unknown retries must
        // retain the original receipt hash. The API rejects any new selection.
        const message = sanitizeMessage(value, modelSelection || input.delivery === "submit");
        const extras = await messageExtras(input);
        if (extras instanceof Response) return extras;
        const modelContext = joinContext(
          extras?.modelContext,
          typeof message.modelContext === "string" ? message.modelContext : undefined,
        );
        return {
          ...message,
          ...(modelContext ? { modelContext } : {}),
          ...(extras?.mcpCredentialUpdates?.length
            ? { mcpCredentialUpdates: extras.mcpCredentialUpdates }
            : {}),
        };
      };
      /** Responses reuse send hooks unchanged; only credentials are added. */
      const forwardResponse = async (
        value: unknown,
        input: SessionProxyMessageInput,
      ): Promise<Record<string, unknown> | Response> => {
        const payload = browserPayload(value);
        const extras = await messageExtras(input);
        if (extras instanceof Response) return extras;
        return {
          ...payload,
          ...(extras?.mcpCredentialUpdates?.length
            ? { mcpCredentialUpdates: extras.mcpCredentialUpdates }
            : {}),
        };
      };
      // Unknown additive query parameters on allowlisted reads pass through, so a
      // newer browser SDK keeps working; the route and method allowlist is exact.
      const query = Object.fromEntries(url.searchParams);
      const read = async (path: string) =>
        json(await client.requestJson("GET", path, undefined, query, call));
      const [root, ...rest] = segments;
      if (root === "config") {
        if (rest.length === 1 && rest[0] === "client" && method === "GET") {
          // The browser speaks this proxy's contract, not the upstream deployment's:
          // report the server SDK's revision so an OpenGeni deploy never makes the
          // embedded page look stale (and never triggers a host reload).
          const config = await client.requestJson<Record<string, unknown>>(
            "GET",
            "/v1/config/client",
            undefined,
            { ...query, workspaceId },
            call,
          );
          let artifacts: Awaited<ReturnType<typeof artifactViewerCapability>> | null = null;
          if (editableLiveUrl) {
            try {
              // Successful effective-grant resolution negotiates the viewer's
              // narrow API support. Older APIs do not have this endpoint: that
              // 404 disables only artifacts, not ordinary conversation config.
              artifacts = {
                editableLiveUrl,
                cachePartition: await cachePartition(
                  await getSessionProxyWorkspaceGrant(client, workspaceId, call),
                  workspaceId,
                  source,
                ),
              };
            } catch (error) {
              if (!(error instanceof OpenGeniApiError) || error.status !== 404) throw error;
            }
          }
          // Upstream proxy capabilities never authorize this host's routes.
          const { artifacts: _upstreamArtifacts, ...conversationConfig } = config;
          return json({
            ...conversationConfig,
            apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
            sandboxFiles: sandboxFilesEnabled,
            ...(artifacts ? { artifacts } : {}),
            // Explicit true also tells stock UIs to offer end users the model picker.
            ...(modelSelection
              ? options.modelSelection === true
                ? { modelSelection: true }
                : {}
              : { modelSelection: false }),
          });
        }
        return errorJson(404, "route_not_allowed", "Not found.");
      }
      if (root !== "workspaces" || rest.length < 1) {
        return errorJson(404, "route_not_allowed", "Not found.");
      }
      const [pathWorkspaceId, area, ...tail] = rest as [string, string | undefined, ...string[]];
      if (pathWorkspaceId !== workspaceId) {
        return errorJson(403, "workspace_not_allowed", "This workspace is not available.");
      }
      const base = `/v1/workspaces/${workspaceId}`;

      // Only the resolved user's own usage. No full roster, allowance config,
      // member selectors, or controls can pass through this browser boundary.
      if (area === "usage" && tail.length === 1 && tail[0] === "me" && method === "GET") {
        if (Object.keys(query).some((key) => key !== "period")) {
          return errorJson(400, "invalid_usage_query", "Only period is accepted for own usage.");
        }
        return await read(`${base}/usage/me`);
      }

      // Workspace reads and the live control stream used by <OpenGeniProvider>.
      if (area === undefined && method === "GET") return await read(base);
      if (area === "model-catalog" && tail.length === 0 && method === "GET") {
        return await read(`${base}/model-catalog`);
      }
      if (area === "live-events" && tail.length === 1 && tail[0] === "stream" && method === "GET") {
        // Surface authorization failures as HTTP status before streaming.
        await client.requestJson("GET", base, undefined, {}, call);
        return workspaceLiveStream(client, workspaceId, url.searchParams, request, heartbeatMs);
      }
      if (area === "inference-control" && tail.length === 0 && method === "POST") {
        // The conversation's paused-state UI only offers workspace Resume.
        const body = await readJsonBody(request, maxBodyBytes);
        if (body?.action !== "resume") {
          reject(403, "control_not_allowed", "Only workspace resume is available.");
        }
        return json(await client.requestJson("POST", `${base}/inference-control`, body));
      }

      if (area === "files" && filesEnabled && method === "POST") {
        if (tail.length === 1 && tail[0] === "uploads") {
          const body = await readJsonBody(request, maxBodyBytes);
          return json(
            await client.requestJson("POST", `${base}/files/uploads`, pick(body, UPLOAD_FIELDS)),
          );
        }
        if (tail.length === 3 && tail[0] === "uploads" && tail[2] === "complete") {
          return json(
            await client.requestJson("POST", `${base}/files/uploads/${tail[1]}/complete`),
          );
        }
        if (tail.length === 2 && tail[1] === "download-url") {
          return json(
            await client.requestJson(
              "POST",
              `${base}/files/${tail[0]}/download-url`,
              undefined,
              query,
              call,
            ),
          );
        }
        return errorJson(404, "route_not_allowed", "Not found.");
      }

      if (area === "editable-artifacts" || area === "published-artifacts") {
        if (!artifactsEnabled) return errorJson(404, "route_not_allowed", "Not found.");
        const [artifactId, ...artifactOp] = tail as [string | undefined, ...string[]];
        const route = `${method} ${artifactOp.join("/")}`;
        const editable = area === "editable-artifacts";
        const allowed = editable
          ? route === "GET " || route === "POST live-ticket"
          : route === "GET " || route === "GET html";
        if (!artifactId || !SEGMENT.test(artifactId) || !allowed) {
          return errorJson(404, "route_not_allowed", "Not found.");
        }
        const sessionId = request.headers.get(SESSION_SCOPE_HEADER)?.trim() ?? "";
        if (!SEGMENT.test(sessionId)) {
          reject(400, "session_scope_required", "Artifact reads must name their session.");
        }
        if (options.authorizeSession && !(await options.authorizeSession(sessionId, context))) {
          return errorJson(404, "session_not_found", "Session not found.");
        }
        // No positive authorization cache: revocation must take effect even
        // between detail, HTML and ticket requests for the same artifact.
        await getSessionProxyArtifactAssociation(
          client,
          workspaceId,
          sessionId,
          editable ? "editable" : "site",
          artifactId,
          call,
        );
        const item = `${base}/${area}/${artifactId}`;
        if (route === "GET ") {
          const replicaId = editable ? query.replicaId : undefined;
          return json(
            await client.requestJson(
              "GET",
              item,
              undefined,
              typeof replicaId === "string" ? { replicaId } : {},
              call,
            ),
          );
        }
        if (route === "POST live-ticket") {
          const body = await readJsonBody(request, maxBodyBytes);
          return json(
            await client.requestJson("POST", `${item}/live-ticket`, {
              ...pick(body, TICKET_FIELDS),
              sourceSessionId: sessionId,
            }),
            201,
          );
        }
        const versionId = query.versionId;
        if (typeof versionId !== "string" || !SEGMENT.test(versionId)) {
          reject(400, "version_required", "versionId is required.");
        }
        const html = await downloadSessionProxySiteHtml(client, workspaceId, artifactId, {
          versionId,
          signal: request.signal,
        });
        return new Response(boundedSiteHtml(html.body, request.signal), {
          headers: SITE_HTML_HEADERS,
        });
      }

      if (area !== "sessions") return errorJson(404, "route_not_allowed", "Not found.");

      if (tail.length === 0 && method === "GET") {
        if (!sessionList) return errorJson(404, "route_not_allowed", "Not found.");
        if (query.view !== "page") {
          reject(400, "page_view_required", "List sessions with listSessionPage.");
        }
        const listQuery: Record<string, string> = { ...query };
        if (sessionList === "mine") {
          // Server-enforced creator filter; the browser cannot widen it.
          listQuery.createdByKind = "subject";
          listQuery.createdBySubjectId = await subjectOf(client, `${source}\u0000${resolved.user}`);
        }
        const page = await client.requestJson<Record<string, unknown>>(
          "GET",
          `${base}/sessions`,
          undefined,
          listQuery,
          call,
        );
        // Pins are a separate personal projection this proxy does not manage.
        return json(sessionList === "mine" ? { ...page, pinned: [] } : page);
      }
      if (tail.length === 0) {
        if (method !== "POST" || !options.createSession) {
          return errorJson(404, "route_not_allowed", "Not found.");
        }
        const input = createInput(await readJsonBody(request, maxBodyBytes));
        const hooked = await options.createSession(input, context);
        if (hooked instanceof Response) return hooked;
        const created = toolServer ? withToolServer(hooked, toolServer, await toolToken()) : hooked;
        const extras = await messageExtras({ delivery: "create" });
        if (extras instanceof Response) return extras;
        const modelContext = joinContext(extras?.modelContext, created.modelContext);
        return json(
          await client.createSession(workspaceId, {
            ...created,
            visibility: created.visibility ?? defaults.visibility,
            agentAccess: created.agentAccess ?? defaults.agentAccess,
            memoryScope: created.memoryScope ?? defaults.memoryScope,
            ...(modelContext ? { modelContext } : {}),
          }),
        );
      }

      const [sessionId, ...op] = tail as [string, ...string[]];
      if (options.authorizeSession && !(await options.authorizeSession(sessionId, context))) {
        return errorJson(404, "session_not_found", "Session not found.");
      }
      const session = `${base}/sessions/${sessionId}`;
      const route = `${method} ${op.join("/")}`;
      const body = method === "GET" ? undefined : await readJsonBody(request, maxBodyBytes, true);
      const sanitize = (value: unknown) => sanitizeMessage(value, modelSelection);
      const saveDraftPolicy = async (message: Record<string, unknown>) => {
        if (modelSelection) return message;
        // Save requires explicit policy fields. Use this actor's durable draft,
        // not browser choices. The API's expectedRevision fence rejects races.
        const draft = await client.getComposerDraft(workspaceId, sessionId, call);
        return {
          ...message,
          model: draft.model,
          reasoningEffort: draft.reasoningEffort,
          latencyMode: draft.latencyMode,
        };
      };
      const forward = async (path: string, payload: Record<string, unknown> | Response) =>
        payload instanceof Response
          ? payload
          : json(await client.requestJson("POST", path, payload));

      switch (route) {
        case "GET ":
          return await read(session);
        case "PUT archive": {
          if (!archiveEnabled) return errorJson(404, "route_not_allowed", "Not found.");
          const archived = body?.archived;
          const expectedVersion = body?.expectedVersion;
          if (typeof archived !== "boolean") reject(400, "invalid_body", "archived is required.");
          return json(
            await client.requestJson("PUT", `${session}/archive`, {
              archived,
              ...(typeof expectedVersion === "number" ? { expectedVersion } : {}),
            }),
          );
        }
        case "PATCH ": {
          const title = body?.title;
          if (typeof title !== "string" || Object.keys(body ?? {}).length !== 1) {
            reject(400, "invalid_body", "Only { title } may be updated.");
          }
          return json(await client.requestJson("PATCH", session, { title }));
        }
        case "GET events":
          return await listEvents(client, `${session}/events`, query, call);
        case "GET events/stream":
          // Surface authorization failures as HTTP status before streaming.
          await client.getSession(workspaceId, sessionId, call);
          return proxySessionEventStream(client, workspaceId, sessionId, {
            after: request,
            signal: request.signal,
            heartbeatMs,
          });
        case "POST events": {
          const event = clientEvent(body);
          const payload =
            event.type === "user.message"
              ? await forwardMessage(event.payload, {
                  sessionId,
                  delivery: "send",
                })
              : await forwardResponse(event.payload, {
                  sessionId,
                  delivery: "send",
                });
          return await forward(
            `${session}/events`,
            payload instanceof Response ? payload : { ...event, payload },
          );
        }
        case "POST steer":
          return await forward(
            `${session}/steer`,
            await forwardMessage(body, { sessionId, delivery: "steer" }),
          );
        case "GET queue":
          return await read(`${session}/queue`);
        case "GET composer-draft":
          return await read(`${session}/composer-draft`);
        case "PUT composer-draft":
          return json(
            await client.requestJson(
              "PUT",
              `${session}/composer-draft`,
              await saveDraftPolicy(sanitize(body)),
            ),
          );
        case "POST composer-draft/submit": {
          const message = await forwardMessage(body, {
            sessionId,
            delivery: "submit",
          });
          return await forward(`${session}/composer-draft/submit`, message);
        }
        case "POST control": {
          if (body?.action !== "pause" && body?.action !== "resume") {
            reject(403, "control_not_allowed", "Only pause and resume are available.");
          }
          return json(await client.requestJson("POST", `${session}/control`, body));
        }
        case "GET human-input-requests":
          return await read(`${session}/human-input-requests`);
        case "POST fs/read":
        case "POST fs/read-workspace": {
          if (!sandboxFilesEnabled) return errorJson(404, "route_not_allowed", "Not found.");
          // A distinct route fails closed on older APIs that would strip the
          // additive workspaceOnly field and otherwise permit machine-wide reads.
          return json(
            await client.requestJson("POST", `${session}/fs/read-workspace`, sandboxRead(body)),
          );
        }
      }
      if (op.length === 2 && op[0] === "human-input-requests" && method === "GET") {
        return await read(`${session}/human-input-requests/${op[1]}`);
      }
      if (
        op.length === 3 &&
        op[0] === "queue" &&
        QUEUE_OPERATIONS.has(op[2]!) &&
        method === "POST"
      ) {
        return json(await client.requestJson("POST", `${session}/queue/${op[1]}/${op[2]}`, body));
      }
      return errorJson(404, "route_not_allowed", "Not found.");
    } catch (error) {
      return errorResponse(error);
    }
  };
}

const UPLOAD_FIELDS = ["scope", "filename", "contentType", "sizeBytes", "sha256"] as const;

type NormalizedToolServer = SessionProxyToolServer & {
  url: string;
  id: string;
  secret: string;
};

function normalizeToolServer(toolServer: SessionProxyToolServer): NormalizedToolServer {
  const configured =
    toolServer.url ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.OPENGENI_TOOL_SERVER_URL;
  let url: URL;
  try {
    url = new URL(configured ?? "");
  } catch {
    throw new TypeError(
      "toolServer.url (or OPENGENI_TOOL_SERVER_URL) must be an absolute https:// URL.",
    );
  }
  if (url.protocol !== "https:") {
    // OpenGeni calls the tool server from its own network; use a tunnel locally.
    throw new TypeError("toolServer.url must be an absolute https:// URL.");
  }
  const id = toolServer.id ?? "app";
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new TypeError("toolServer.id may contain only letters, digits, _ and -.");
  }
  const ask = toolServer.approvals?.ask;
  if (ask !== undefined && ask !== true && !(Array.isArray(ask) && ask.every(isToolName))) {
    throw new TypeError("toolServer.approvals.ask must be true or a list of tool names.");
  }
  // Resolve now so a missing secret fails at startup, not on the first chat.
  return {
    ...toolServer,
    url: configured!,
    id,
    secret: resolveToolTokenSecret(toolServer.secret),
  };
}

function isToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Attach the product tool server with a fresh per-user token. */
function withToolServer(
  created: CreateSessionRequest,
  toolServer: NormalizedToolServer,
  token: string,
): CreateSessionRequest {
  const servers = created.mcpServers ?? [];
  if (servers.some((server) => server.id === toolServer.id)) {
    throw new TypeError(
      `createSession already attaches an MCP server with the toolServer id "${toolServer.id}".`,
    );
  }
  const ask = toolServer.approvals?.ask;
  const tools = created.tools;
  return {
    ...created,
    mcpServers: [
      ...servers,
      {
        id: toolServer.id,
        ...(toolServer.name ? { name: toolServer.name } : {}),
        url: toolServer.url,
        headers: { Authorization: `Bearer ${token}` },
        ...(ask === true ? { requireApproval: true } : ask?.length ? { requireApproval: ask } : {}),
      },
    ],
    // Omitted tools keep workspace defaults; the attachment alone selects the
    // server. An explicit allow-list gets the server's tools on the first request.
    ...(Array.isArray(tools) && !tools.some((tool) => tool.id === toolServer.id)
      ? {
          tools: [...tools, { kind: "mcp" as const, id: toolServer.id, eager: true }],
        }
      : {}),
  };
}

const EDITABLE_ARTIFACT_LIVE_PATH = "/v1/editable-artifacts/live";
const TICKET_FIELDS = [
  "replicaId",
  "modality",
  "liveProtocolVersion",
  "kernelVersion",
  "modelSchemaVersion",
  "snapshotVersion",
  "commandProtocolVersion",
  "committedTransactionProtocolVersion",
] as const;
// Same delivery contract as OpenGeni's own route: the browser fetches the
// HTML and renders it in a sandboxed frame; opening the URL downloads it.
const SITE_HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": "sandbox allow-scripts",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Content-Disposition": 'attachment; filename="site.html"',
} as const;

function liveSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new TypeError("editableLiveUrl must be an HTTP(S) or WS(S) URL");
  }
  return url.href;
}

function boundedSiteHtml(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = body?.getReader();
  let bytes = 0;
  let settled = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const cancel = async (reason: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    await reader?.cancel(reason).catch(() => undefined);
    reader?.releaseLock();
  };
  const abort = () => {
    if (settled) return;
    controller.error(signal.reason);
    void cancel(signal.reason);
  };
  return new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      },
      async pull(value) {
        if (settled) return;
        try {
          const chunk = await reader?.read();
          if (settled) return;
          if (!chunk || chunk.done) {
            settled = true;
            cleanup();
            reader?.releaseLock();
            value.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > SESSION_PROXY_SITE_HTML_MAX_BYTES) {
            const error = new SessionProxySiteHtmlTooLargeError();
            value.error(error);
            await cancel(error);
            return;
          }
          value.enqueue(chunk.value);
        } catch (error) {
          if (settled) return;
          value.error(error);
          await cancel(error);
        }
      },
      cancel,
    },
    // Read only when the downstream consumer requests a chunk.
    { highWaterMark: 0 },
  );
}

/**
 * The client-config `artifacts` capability a custom host proxy reports so
 * `SessionArtifactViewer` can open editable artifacts: the live socket URL
 * (ticket-authenticated, reached directly) and the proxied user's browser cache
 * partition. `client` acts as that user (for example `asUser(...)`).
 */
export async function artifactViewerCapability(input: {
  client: Pick<ProxyClient, "getAccessContext" | "apiUrl"> &
    Partial<Pick<ProxyClient, "requestJson">>;
  workspaceId: string;
  /** Stable namespace of the host's user identities, mixed into the partition. */
  source?: string | undefined;
  editableLiveUrl?: string | undefined;
}): Promise<{
  editableLiveUrl: string;
  cachePartition: {
    accountId: string;
    principalId: string;
    authorizationEpoch: string;
  };
}> {
  return {
    editableLiveUrl: liveSocketUrl(
      input.editableLiveUrl ?? input.client.apiUrl(EDITABLE_ARTIFACT_LIVE_PATH),
    ),
    cachePartition: await cachePartition(
      input.client.requestJson
        ? await getSessionProxyWorkspaceGrant(
            input.client as Pick<ProxyClient, "requestJson">,
            input.workspaceId,
          )
        : await legacyViewerGrant(input.client, input.workspaceId),
      input.workspaceId,
      input.source ?? "default",
    ),
  };
}

/** The editor's browser cache partition for this proxied user and workspace. */
async function cachePartition(
  grant: import("./types").AccessGrant,
  workspaceId: string,
  source: string,
): Promise<{
  accountId: string;
  principalId: string;
  authorizationEpoch: string;
}> {
  if (grant.workspaceId !== workspaceId) {
    reject(403, "workspace_not_allowed", "This workspace is not available.");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        source,
        subjectId: grant.subjectId,
        accountId: grant.accountId,
        workspaceId,
        permissions: [...grant.permissions].sort(),
        // Effective external grants carry live identity/link revisions. Include
        // them even when a revoke/regrant restores an identical permission set.
        externalActor: grant.metadata?.externalActor ?? null,
      }),
    ),
  );
  return {
    accountId: grant.accountId,
    principalId: grant.subjectId,
    authorizationEpoch: `sha256:${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`,
  };
}

/** Preserve custom capability clients that supplied only the original two methods. */
async function legacyViewerGrant(
  client: Pick<ProxyClient, "getAccessContext">,
  workspaceId: string,
): Promise<import("./types").AccessGrant> {
  const access = await client.getAccessContext();
  const grant = access.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId);
  if (!grant) reject(403, "workspace_not_allowed", "This workspace is not available.");
  return grant;
}

/** Sandbox link download: one path, no route/target override. */
function sandboxRead(body: Record<string, unknown> | undefined): Record<string, unknown> {
  const path = body?.path;
  const encoding = body?.encoding;
  const maxBytes = body?.maxBytes;
  if (typeof path !== "string" || !path || path.length > 4096) {
    reject(400, "invalid_body", "path is required.");
  }
  if (encoding !== undefined && encoding !== "utf8" && encoding !== "base64") {
    reject(400, "invalid_body", "encoding must be utf8 or base64.");
  }
  if (
    maxBytes !== undefined &&
    (typeof maxBytes !== "number" ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 25 * 1024 * 1024)
  ) {
    reject(400, "invalid_body", "maxBytes must be an integer from 1 to 26214400.");
  }
  return {
    path,
    workspaceOnly: true,
    ...(encoding === undefined ? {} : { encoding }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

/** Native path segments after the mount prefix, starting at `v1`'s child; null when not a proxied path. */
function routeSegments(pathname: string, basePath: string | undefined): string[] | null {
  let rest: string;
  if (basePath !== undefined) {
    const prefix = basePath.replace(/\/+$/, "");
    if (!pathname.startsWith(`${prefix}/`)) return null;
    rest = pathname.slice(prefix.length);
  } else {
    const index = pathname.indexOf("/v1/");
    if (index < 0) return null;
    rest = pathname.slice(index);
  }
  const raw = rest.replace(/\/+$/, "").split("/").slice(1);
  if (raw[0] !== "v1" || raw.length < 2) return null;
  const segments: string[] = [];
  for (const part of raw.slice(1)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    // Rejects empty, dot, and encoded-separator segments before any SDK path is built.
    if (!SEGMENT.test(decoded)) return null;
    segments.push(decoded);
  }
  return segments;
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
  optional = false,
): Promise<Record<string, unknown> | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) reject(413, "body_too_large", "Request body is too large.");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        reject(413, "body_too_large", "Request body is too large.");
      }
      chunks.push(value);
    }
  }
  if (total === 0) {
    if (optional) return undefined;
    reject(400, "invalid_body", "A JSON object body is required.");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    reject(415, "unsupported_media_type", "Send application/json.");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    reject(400, "invalid_body", "Body is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    reject(400, "invalid_body", "A JSON object body is required.");
  }
  return parsed as Record<string, unknown>;
}

function pick(
  body: Record<string, unknown> | undefined,
  fields: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (body && Object.hasOwn(body, field)) picked[field] = body[field];
  }
  return picked;
}

function createInput(body: Record<string, unknown> | undefined): SessionProxyCreateInput {
  for (const key of Object.keys(body ?? {})) {
    if (!CREATE_FIELDS.has(key)) {
      reject(
        400,
        "create_field_not_allowed",
        `The server chooses session configuration; "${key}" cannot be set from the browser.`,
      );
    }
  }
  const initialMessage = body?.initialMessage;
  const idempotencyKey = body?.idempotencyKey;
  if (typeof initialMessage !== "string" || !initialMessage.trim()) {
    reject(400, "initial_message_required", "initialMessage is required.");
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey)) {
    reject(400, "invalid_idempotency_key", "idempotencyKey must be a non-empty string.");
  }
  return { initialMessage, ...(idempotencyKey ? { idempotencyKey } : {}) };
}

/** Browser payloads cannot supply server-owned credential rotations. */
function browserPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reject(400, "invalid_body", "A JSON object body is required.");
  }
  const input = { ...(value as Record<string, unknown>) };
  if (Object.hasOwn(input, "mcpCredentialUpdates")) {
    reject(403, "credential_update_not_allowed", "MCP credentials are server-owned.");
  }
  return input;
}

/** Browser message/draft input: no credential rotation, file resources only, optional model lock. */
function sanitizeMessage(value: unknown, modelSelection: boolean): Record<string, unknown> {
  const input = browserPayload(value);
  if (input.resources !== undefined) {
    if (
      !Array.isArray(input.resources) ||
      input.resources.some(
        (resource) =>
          !resource ||
          typeof resource !== "object" ||
          (resource as { kind?: unknown }).kind !== "file",
      )
    ) {
      reject(403, "resource_not_allowed", "Only file attachments may be added from the browser.");
    }
  }
  if (!modelSelection) {
    for (const field of MODEL_FIELDS) delete input[field];
  }
  return input;
}

function clientEvent(body: Record<string, unknown> | undefined): Record<string, unknown> & {
  type: string;
} {
  switch (body?.type) {
    case "user.message":
    case "user.approvalDecision":
    case "user.humanInputResponse":
      return body as Record<string, unknown> & { type: string };
    default:
      return reject(403, "event_not_allowed", "This session event type is not available.");
  }
}

function joinContext(...parts: Array<string | undefined>): string | undefined {
  const joined = parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join("\n\n");
  return joined || undefined;
}

async function listEvents(
  client: ProxyClient,
  path: string,
  query: Record<string, string>,
  call: { signal: AbortSignal },
): Promise<Response> {
  if (query.mode === "forensic") {
    reject(403, "forensic_events_not_allowed", "Forensic event reads are not proxied.");
  }
  const upstream = await client.requestJsonResponse(path, query, call);
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    // Paging metadata only; the upstream contract revision stays behind the proxy.
    if (lower.startsWith("x-opengeni-") && lower !== OPENGENI_API_CONTRACT_HEADER) {
      headers[name] = value;
    }
  });
  return new Response(await upstream.text(), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

/** Re-emit the workspace control/interaction stream the React provider subscribes to. */
function workspaceLiveStream(
  client: ProxyClient,
  workspaceId: string,
  params: URLSearchParams,
  request: Request,
  heartbeatMs: number,
): Response {
  const cursor = (name: string): number => {
    const value = Number(params.get(name) ?? "0");
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  const upstream = new AbortController();
  if (request.signal.aborted) upstream.abort();
  else
    request.signal.addEventListener("abort", () => upstream.abort(), {
      once: true,
    });
  const events = client.streamWorkspaceLiveEvents(workspaceId, {
    controlAfter: cursor("controlAfter"),
    interactionAfter: cursor("interactionAfter"),
    signal: upstream.signal,
  });
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          stop();
        }
      }, heartbeatMs);
    },
    pull: async (controller) => {
      const next = await iterator.next().catch((error: unknown) => {
        stop();
        throw error;
      });
      if (next.done) {
        stop();
        controller.close();
        return;
      }
      const event = next.value;
      controller.enqueue(
        encoder.encode(
          `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      );
    },
    cancel: () => {
      stop();
      upstream.abort();
      void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** Preserve OpenGeni's error envelope so the browser SDK keeps codes, retryability, and outcome facts. */
function errorResponse(error: unknown): Response {
  if (error instanceof ProxyRejection) return errorJson(error.status, error.code, error.message);
  if (error instanceof OpenGeniSetupError) {
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          retryable: false,
          ...(error.correlationId ? { requestId: error.correlationId } : {}),
        },
      },
      error.status,
    );
  }
  if (error instanceof OpenGeniApiError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
    // A decoded upstream envelope is forwarded verbatim; the SDK only retains decodable bodies.
    if (error.body) {
      return new Response(error.body, {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    return json(
      {
        error: {
          code: error.code ?? "opengeni_api_error",
          message: error.message,
          retryable: error.retryable,
          outcomeUnknown: error.outcomeUnknown,
          ...(error.correlationId ? { requestId: error.correlationId } : {}),
          ...(error.details ? { details: error.details } : {}),
        },
      },
      status,
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    return errorJson(499, "aborted", "The request was aborted.");
  }
  return errorJson(500, "proxy_error", "Request could not be completed.");
}
