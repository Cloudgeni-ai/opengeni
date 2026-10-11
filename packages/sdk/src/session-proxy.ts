import type { OpenGeniEmbeddingClient } from "./embedding-client";
import { OpenGeniApiError, OpenGeniSetupError } from "./errors";
import { chatDefaults, type Chats } from "./chats";
import { SESSION_SCOPE_HEADER } from "./message-links";
import type { WorkspaceIdOptions, WorkspaceIdTarget } from "./tenant-workspaces";
import { proxySessionEventStream } from "./proxy";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "./types";
import type {
  CreateSessionRequest,
  FileResourceRef,
  LatencyMode,
  ReasoningEffort,
  RetainedArtifactContent,
  SessionMcpCredentialUpdateInput,
} from "./types";
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

/** The `@opengeni/sdk/chat` `Opengeni` facade, structurally. */
type ProxyFacade = {
  readonly client: ProxyClient;
  readonly source: string;
  workspaceId(target: { tenant: string }): Promise<string>;
  workspaceIdFor?(target: WorkspaceIdTarget, options: WorkspaceIdOptions): Promise<string>;
};

/**
 * Who the authenticated request acts as, in your own ids. Never derive any of
 * it from the request body or path. `{ user, tenant }`: one workspace per
 * tenant. `{ user }`: one workspace per user. `{ user, workspaceId }`: your
 * own workspace. Tenant and per-user mapping require the `Opengeni` facade
 * from `@opengeni/sdk/chat`; workspaces are created on first use and Opengeni
 * adds the user on their first request.
 */
export type SessionProxyResolution = (
  | { workspaceId: string; tenant?: undefined }
  | { tenant: string; workspaceId?: undefined }
  | { tenant?: undefined; workspaceId?: undefined }
) & {
  /** Host-authenticated external user id; every call runs through `asUser(user)`. */
  user: string;
  /** External identity source. Defaults to the facade's `source`, else `"default"`. */
  source?: string | undefined;
  /**
   * The user is an anonymous visitor your product has not signed in, for
   * example a website visitor keyed by a cookie. Visitors cannot upload
   * composer file attachments unless the handler sets `visitorUploads: true`;
   * everything else is unchanged.
   */
  visitor?: boolean | undefined;
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

/**
 * The only fields a browser may send when creating a session through the proxy.
 * After the `createSession` hook returns, the proxy adds the attached files to
 * the created request (deduplicated by file id) and, when `modelSelection` is
 * not `false`, applies the browser's explicit model choices over the hook's,
 * exactly as follow-up messages carry them. Return a `Response` from the hook
 * to refuse an input.
 */
export type SessionProxyCreateInput = {
  /** Empty for a voice-first session; no initial user message is fabricated. */
  initialMessage: string;
  /** Available only while the proxy permits realtime voice. */
  startMode?: "realtime" | undefined;
  /** Browser retry key; replay is scoped to the acting user by the API. */
  idempotencyKey?: string | undefined;
  /** Files attached to the first message (uploaded through this proxy). */
  resources?: FileResourceRef[] | undefined;
  /** The user's model choice; only when `modelSelection` is not `false`. */
  model?: string | undefined;
  /** The user's reasoning choice; only when `modelSelection` is not `false`. */
  reasoningEffort?: ReasoningEffort | undefined;
  /** The user's latency choice; only when `modelSelection` is not `false`. */
  latencyMode?: LatencyMode | undefined;
};

/** Which browser action is about to forward a user message or response. */
export type SessionProxyMessageInput = {
  /** Absent for `create`. */
  sessionId?: string | undefined;
  /** An empty voice-first session shell, not an initial model-producing turn. */
  startMode?: "realtime" | undefined;
  /**
   * `realtime` is live voice: once when a call starts (refuse it, or rotate
   * MCP credentials), and before each batch of finalized transcripts and spoken
   * requests is saved (refuse it, or add `modelContext`).
   */
  delivery: "create" | "send" | "steer" | "submit" | "realtime";
};

/** Server-side additions the host attaches to one forwarded user message or response. */
export type SessionProxyMessageExtras = {
  /**
   * Model-visible context for this message (current page, time zone, today's
   * date). Placed before any context the browser sent. Not secret. Ignored for
   * approval decisions and human-input responses, which are not new messages,
   * and when a live voice call starts. Keep it stable for the same message:
   * a retried voice entry must carry the same context to be accepted.
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
   * belongs to this user"). Opengeni still enforces membership and private
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
   * and browser-started create), approval decision, human-input response, and
   * live voice start and transcript save (`delivery: "realtime"`).
   * Return server-owned `modelContext` (messages and voice transcripts only)
   * and MCP credential rotations, or a `Response` to reject the action.
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
  /**
   * Expose composer file attachments (upload begin/complete, download URL) and
   * the media agents produce in a session: generated images, browser and
   * computer screenshots, published sandbox files, and generated video
   * playback. Workspace-level artifact reads must name their session in the
   * `x-opengeni-session-id` header (`SessionConversation` does this); the proxy
   * runs `authorizeSession` and only forwards an artifact Opengeni proves that
   * session produced. Defaults to true.
   */
  files?: boolean | undefined;
  /**
   * Let anonymous visitors (`resolve` returned `visitor: true`) upload composer
   * file attachments. Defaults to false: for a visitor the client config reports
   * file uploads off, so stock UIs hide the attach button, and the upload routes
   * are refused. Agent-produced media stays readable under `files`. Signed-in
   * users follow `files` alone.
   */
  visitorUploads?: boolean | undefined;
  /**
   * Forward composer voice input (`POST .../transcriptions`, one recording per
   * request) as the resolved user; Opengeni still requires that user's
   * `sessions:create` permission and the workspace's voice-input setting.
   * `false` reports voice input unavailable in the client config so stock UIs
   * hide the microphone. Defaults to true.
   */
  voiceInput?: boolean | undefined;
  /**
   * Forward live speech-to-speech voice for existing chats as the resolved
   * user: the voice model catalog and the call lifecycle routes under
   * `.../sessions/{id}/realtime`. Opengeni still requires that user's
   * `sessions:control` permission, binds the call to that user and browser,
   * runs spoken requests as ordinary steers of the chat, and meters
   * deployment-funded voice against the organization's credits. Defaults to
   * true. The stock conversation's voice button is opt-in: explicit `true`
   * reports `realtimeVoice: true` in the client config so `SessionConversation`
   * and `OpenGeniChat` show it (when a voice model is available), as does their
   * own `realtimeVoice` prop. `false` reports `realtimeVoice: false` so stock
   * UIs hide it, and refuses the routes.
   */
  realtimeVoice?: boolean | undefined;
  /**
   * Let the browser read a file from the session's sandbox (`POST .../fs/read`)
   * so `sandbox:` links in agent replies can be downloaded. Only `path`,
   * `encoding`, and `maxBytes` are forwarded; Opengeni still requires the
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
   * runs `authorizeSession`, then only forwards an artifact Opengeni associates with
   * that session, so the browser cannot open other workspace artifacts through
   * it. Editing still requires the user's own `artifacts:publish` grant. Site
   * tool calls are not proxied.
   *
   * The editor's live socket is ticket-authenticated and connects to Opengeni
   * directly; the ticket binds the source session and the API revalidates its
   * authority while connected. `editableLiveUrl` overrides the derived URL.
   * Site HTML streams with backpressure and cancellation, with a 25 MiB
   * actual-byte ceiling (`SESSION_PROXY_SITE_HTML_MAX_BYTES`). Oversize streams
   * fail with `SessionProxySiteHtmlTooLargeError` / `site_html_too_large`;
   * headers cannot be replaced once streaming has begun.
   */
  artifacts?: boolean | { editableLiveUrl?: string | undefined } | undefined;
  /**
   * Read the workspace's Sites without naming a session: list, detail,
   * content and HTML of published artifacts the signed-in user may read, for
   * pages that belong to the workspace rather than to one chat (for example a
   * page several sessions keep up to date, shown with `SiteDetail`). Read-only:
   * publishing, rollback and status changes stay closed. Requests that send
   * `x-opengeni-session-id` keep the session-scoped `artifacts` checks.
   * Explicit opt-in, default false.
   */
  sites?: boolean | undefined;
  /**
   * Chat list for `SessionList` / `OpenGeniChat` (`listSessionPage` only).
   * `"mine"` (default) lists sessions the resolved user created; `"visible"`
   * lists every session Opengeni lets that user read in the workspace (shared
   * chats included); `false` disables listing.
   */
  sessionList?: "mine" | "visible" | false | undefined;
  /** Let the user archive or restore their own chats. Defaults to true. */
  archive?: boolean | undefined;
  /**
   * Let the browser choose model, reasoning effort, and latency per message,
   * draft, or new chat (still limited by the workspace model catalog). When
   * false those choices are removed from messages and draft saves, and refused
   * on create. Saves use the actor's
   * server-owned draft policy (initially the session defaults). Submit must repeat
   * the saved policy unchanged as an integrity fence, not a new selection: the
   * API atomically checks the saved revision/content or replays the original
   * receipt. Hide the composer's model picker to match. Defaults to true.
   * Pass `true` explicitly to also show end users the stock model picker
   * (`SessionConversation`/`OpenGeniChat` hide it unless asked). The picker
   * lists the workspace's model catalog, so the workspace's allowed-model
   * settings decide which models end users see.
   */
  modelSelection?: boolean | undefined;
  /**
   * SSE heartbeat interval. Defaults to 5 seconds, under Bun.serve's default
   * 10-second `idleTimeout`, which otherwise closes a quiet event stream.
   */
  heartbeatMs?: number | undefined;
};

/**
 * Default SSE heartbeat. Bun.serve closes a connection that sends nothing for
 * 10 seconds by default, so a quiet stream (a long tool call, an idle chat)
 * would drop and reconnect every 10 seconds through a Bun or Hono-on-Bun host.
 */
const SESSION_PROXY_DEFAULT_HEARTBEAT_MS = 5_000;

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const QUEUE_OPERATIONS: ReadonlySet<string> = new Set(["move", "edit", "steer", "delete"]);
const CREATE_FIELDS: ReadonlySet<string> = new Set([
  "initialMessage",
  "idempotencyKey",
  "resources",
  "startMode",
]);
const MODEL_FIELDS = ["model", "reasoningEffort", "latencyMode"] as const;
/** The API's single-recording ceiling (25 MiB) plus multipart framing. */
const MAX_TRANSCRIPTION_BODY_BYTES = 25 * 1024 * 1024 + 64 * 1024;

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
  // One rejected-key notice per handler (each handler holds one server key).
  const rejectedKeyNotice = { sent: false };
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const filesEnabled = options.files ?? true;
  const voiceInputEnabled = options.voiceInput ?? true;
  const realtimeVoiceEnabled = options.realtimeVoice ?? true;
  const sandboxFilesEnabled = options.sandboxFiles === true;
  const artifactsEnabled = options.artifacts !== undefined && options.artifacts !== false;
  const sitesEnabled = options.sites === true;
  const editableLiveUrl = artifactsEnabled
    ? liveSocketUrl(
        (typeof options.artifacts === "object" ? options.artifacts.editableLiveUrl : undefined) ??
          service.apiUrl(EDITABLE_ARTIFACT_LIVE_PATH),
      )
    : null;
  const modelSelection = options.modelSelection ?? true;
  const heartbeatMs = options.heartbeatMs ?? SESSION_PROXY_DEFAULT_HEARTBEAT_MS;
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
      if (!PROXY_METHODS.includes(method)) {
        return new Response(null, {
          status: 405,
          headers: { Allow: PROXY_METHODS.join(", ") },
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
      // A tenant/workspaceId key that resolves to nothing must never fall
      // through to the per-user workspace: that is a host auth bug, not a choice.
      if (
        ("workspaceId" in resolved && !resolved.workspaceId && !resolved.tenant) ||
        ("tenant" in resolved && !resolved.tenant && !resolved.workspaceId) ||
        resolved.workspaceId === "" ||
        resolved.tenant === ""
      ) {
        throw new TypeError(
          "resolve returned an empty tenant or workspaceId. Return a non-empty id, or omit the key for one workspace per user.",
        );
      }
      if (chats === "isolated") {
        if (resolved.workspaceId || !isFacade(target) || !target.workspaceIdFor) {
          throw new TypeError(
            'chats: "isolated" requires the Opengeni facade and a tenant or user resolution.',
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
      } else if (
        !("tenant" in resolved) &&
        !("workspaceId" in resolved) &&
        isFacade(target) &&
        target.workspaceIdFor
      ) {
        // A user alone: their own workspace, keyed by the identity source.
        workspaceId = await target.workspaceIdFor(
          { user: resolved.user, source },
          { isolation: "user" },
        );
      } else {
        throw new TypeError(
          "resolve must return a workspaceId (or a tenant or a user alone when given the Opengeni facade).",
        );
      }
      // Visitors upload only when the host opts them in; reads stay under `files`.
      const uploadsEnabled =
        filesEnabled && (resolved.visitor !== true || options.visitorUploads === true);
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
      /**
       * Best-effort standalone rotation before a voice call. Opengeni refuses
       * it while a turn is running; that turn's message already refreshed them.
       */
      const refreshRealtimeCredentials = async (
        sessionId: string,
        updates: SessionMcpCredentialUpdateInput[],
      ): Promise<void> => {
        if (updates.length === 0) return;
        try {
          const servers = (await client.getSession(workspaceId, sessionId, call)).mcpServers ?? [];
          const rotations = updates.flatMap((update) => {
            const server = servers.find((candidate) => candidate.id === update.id);
            return server
              ? [
                  {
                    id: update.id,
                    expectedCredentialVersion: server.credentialVersion,
                    expectedServerUrl: server.url,
                    headers: update.headers,
                  },
                ]
              : [];
          });
          if (rotations.length === 0) return;
          await client.rotateSessionMcpCredentials(workspaceId, sessionId, {
            operationKey: crypto.randomUUID(),
            updates: rotations,
          });
        } catch (error) {
          if (!(error instanceof OpenGeniApiError)) throw error;
        }
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
          // report the server SDK's revision so an Opengeni deploy never makes the
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
          const upstreamVoice = config.voiceInput;
          if (upstreamVoice && typeof upstreamVoice === "object") {
            // Only one-shot recordings are forwarded, never resumable chunk uploads.
            const { resumable: _resumable, ...voice } = upstreamVoice as Record<string, unknown>;
            conversationConfig.voiceInput = voiceInputEnabled
              ? voice
              : { ...voice, available: false };
          }
          const upstreamUploads = config.fileUploads;
          if (!uploadsEnabled) {
            // The browser cannot upload through this proxy: stock UIs hide the attach control.
            conversationConfig.fileUploads = {
              ...(upstreamUploads && typeof upstreamUploads === "object" ? upstreamUploads : {}),
              enabled: false,
            };
          }
          return json({
            ...conversationConfig,
            apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
            // The resolved workspace: a browser given only the proxy's baseUrl
            // reads it here instead of knowing any Opengeni id.
            workspaceId,
            sandboxFiles: sandboxFilesEnabled,
            // Stock UIs show Site previews and the artifact viewer only when
            // this proxy serves them; `false` keeps them from failing on click.
            artifacts: artifacts ?? false,
            // Whether the stock "New chat" and "Archive" actions can succeed.
            sessionCreation: options.createSession !== undefined,
            archive: archiveEnabled,
            // Explicit true also tells stock UIs to show the voice button, which
            // is otherwise opt-in on the embedded conversation.
            ...(realtimeVoiceEnabled
              ? options.realtimeVoice === true
                ? { realtimeVoice: true }
                : {}
              : { realtimeVoice: false }),
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
      if (area === "realtime-model-catalog" && tail.length === 0 && method === "GET") {
        if (!realtimeVoiceEnabled) return errorJson(404, "route_not_allowed", "Not found.");
        return await read(`${base}/realtime-model-catalog`);
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
        if (tail[0] === "uploads" && !uploadsEnabled) {
          return errorJson(404, "route_not_allowed", "Not found.");
        }
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

      if (area === "artifacts") {
        // Retained media a session produced: only an artifact Opengeni proves
        // that session produced, never an arbitrary workspace artifact.
        const [artifactId, ...artifactOp] = tail as [string | undefined, ...string[]];
        const route = `${method} ${artifactOp.join("/")}`;
        if (
          !filesEnabled ||
          !artifactId ||
          !SEGMENT.test(artifactId) ||
          (route !== "GET content" && route !== "POST playback-source")
        ) {
          return errorJson(404, "route_not_allowed", "Not found.");
        }
        const sessionId = request.headers.get(SESSION_SCOPE_HEADER)?.trim() ?? "";
        if (!SEGMENT.test(sessionId)) {
          reject(400, "session_scope_required", "Artifact reads must name their session.");
        }
        if (options.authorizeSession && !(await options.authorizeSession(sessionId, context))) {
          return errorJson(404, "session_not_found", "Session not found.");
        }
        await getSessionProxyArtifactAssociation(
          client,
          workspaceId,
          sessionId,
          "retained",
          artifactId,
          call,
        );
        if (route === "POST playback-source") {
          return json(
            await client.requestJson(
              "POST",
              `${base}/artifacts/${artifactId}/playback-source`,
              undefined,
              {},
              call,
            ),
          );
        }
        return retainedContent(
          await client.getRetainedArtifactContent(workspaceId, artifactId, {
            ...retainedRange(request),
            signal: request.signal,
          }),
        );
      }

      if (area === "transcriptions" && tail.length === 0 && method === "POST") {
        if (!voiceInputEnabled) return errorJson(404, "route_not_allowed", "Not found.");
        return json(await client.transcribeAudio(workspaceId, await transcriptionInput(request)));
      }

      if (area === "editable-artifacts" || area === "published-artifacts") {
        if (
          area === "published-artifacts" &&
          sitesEnabled &&
          !request.headers.get(SESSION_SCOPE_HEADER)
        ) {
          // Workspace Sites under Opengeni's own read authorization for this user.
          const [siteId, ...siteOp] = tail as [string | undefined, ...string[]];
          const op = siteOp.join("/");
          if (method !== "GET") return errorJson(404, "route_not_allowed", "Not found.");
          if (siteId === undefined) {
            return json(
              await client.requestJson(
                "GET",
                `${base}/published-artifacts`,
                undefined,
                pick(query, SITE_LIST_FIELDS) as Record<string, string>,
                call,
              ),
            );
          }
          if (!SEGMENT.test(siteId) || (op !== "" && op !== "content" && op !== "html")) {
            return errorJson(404, "route_not_allowed", "Not found.");
          }
          const versionId = query.versionId;
          if (
            versionId !== undefined &&
            (typeof versionId !== "string" || !SEGMENT.test(versionId))
          ) {
            reject(400, "version_invalid", "versionId is invalid.");
          }
          if (op === "html") {
            if (typeof versionId !== "string") {
              reject(400, "version_required", "versionId is required.");
            }
            const html = await downloadSessionProxySiteHtml(client, workspaceId, siteId, {
              versionId: versionId as string,
              signal: request.signal,
            });
            return new Response(boundedSiteHtml(html.body, request.signal), {
              headers: SITE_HTML_HEADERS,
            });
          }
          const item = `${base}/published-artifacts/${siteId}`;
          return json(
            await client.requestJson(
              "GET",
              op === "content" ? `${item}/content` : item,
              undefined,
              op === "content" && typeof versionId === "string" ? { versionId } : {},
              call,
            ),
          );
        }
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
        const input = createInput(await readJsonBody(request, maxBodyBytes), modelSelection);
        if (input.startMode === "realtime" && !realtimeVoiceEnabled) {
          return errorJson(404, "route_not_allowed", "Not found.");
        }
        const hooked = await options.createSession(input, context);
        if (hooked instanceof Response) return hooked;
        const created = withBrowserCreateChoices(
          toolServer ? withToolServer(hooked, toolServer, await toolToken()) : hooked,
          input,
        );
        const extras = await messageExtras({
          delivery: "create",
          ...(input.startMode ? { startMode: input.startMode } : {}),
        });
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

      if (op[0] === "realtime") {
        if (!realtimeVoiceEnabled) return errorJson(404, "route_not_allowed", "Not found.");
        const realtime = realtimeRoute(method, op.slice(1));
        if (!realtime) return errorJson(404, "route_not_allowed", "Not found.");
        if (!body) reject(400, "invalid_body", "A JSON object body is required.");
        const path = `${session}/${op.join("/")}`;
        if (realtime === "begin") {
          // The host may refuse a call; MCP credentials (including the tool
          // server's per-user token) are refreshed before voice can delegate.
          const extras = await messageExtras({
            sessionId,
            delivery: "realtime",
          });
          if (extras instanceof Response) return extras;
          await refreshRealtimeCredentials(sessionId, extras?.mcpCredentialUpdates ?? []);
        }
        let payload: Record<string, unknown> = body;
        if (realtime === "sync" && options.beforeForwardMessage && hasRealtimeMessages(body)) {
          const extras = await options.beforeForwardMessage(
            { sessionId, delivery: "realtime" },
            context,
          );
          if (extras instanceof Response) return extras;
          payload = withRealtimeContext(body, extras?.modelContext);
        }
        return json(await client.requestJson(method, path, payload));
      }

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
        case "GET goal":
          return await read(`${session}/goal`);
        case "PATCH goal": {
          // Pause and resume only: the objective, limits and completion stay
          // with the agent and the product's own server. A browser rationale is
          // dropped, so end-user text never reaches the goal record.
          const status = body?.status;
          if (
            (status !== "paused" && status !== "active") ||
            Object.keys(body ?? {}).some((key) => key !== "status" && key !== "rationale")
          ) {
            reject(
              403,
              "goal_update_not_allowed",
              "Only { status: paused | active } is available.",
            );
          }
          return json(await client.requestJson("PATCH", `${session}/goal`, { status }));
        }
        case "DELETE goal":
          await client.deleteGoal(workspaceId, sessionId);
          return new Response(null, { status: 204 });
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
      if (op[0] === "artifacts" && (op.length === 2 || op[2] === "content") && method === "GET") {
        // Retained screenshots: the API matches the artifact to this session;
        // the proxy first proves the user can read the session itself.
        if (!filesEnabled || op.length > 3) {
          return errorJson(404, "route_not_allowed", "Not found.");
        }
        await client.getSession(workspaceId, sessionId, call);
        if (op.length === 2) return await read(`${session}/artifacts/${op[1]}`);
        return retainedContent(
          await client.getSessionRetainedArtifactContent(workspaceId, sessionId, op[1]!, {
            ...retainedRange(request),
            signal: request.signal,
          }),
        );
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
      return errorResponse(error, rejectedKeyNotice);
    }
  };
}

/**
 * Methods any forwarded route uses. Module-level so the public API inventory
 * attributes a verb only to the routes that actually forward it.
 */
const PROXY_METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const UPLOAD_FIELDS = ["scope", "filename", "contentType", "sizeBytes", "sha256"] as const;

type RealtimeRoute = "begin" | "connect" | "heartbeat" | "end" | "activate" | "sync";
const REALTIME_CONNECT_ROUTES: ReadonlySet<string> = new Set(["webrtc", "gateway", "supergrok"]);
/** Ledger entries that become (or join) messages and so accept `modelContext`. */
const REALTIME_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "delegation_call",
  "user_transcript",
  "assistant_transcript",
]);

/**
 * The live voice routes a browser call uses, after `realtime/`: begin, provider
 * connect, heartbeat, end, connection activation, and transcript sync. Bodies
 * pass to Opengeni, which validates them and binds the call to the acting user.
 */
function realtimeRoute(method: string, rest: string[]): RealtimeRoute | null {
  if (rest.length === 0) return method === "POST" ? "begin" : null;
  if (rest.length === 1) {
    if (REALTIME_CONNECT_ROUTES.has(rest[0]!)) return method === "POST" ? "connect" : null;
    return method === "DELETE" ? "end" : null;
  }
  if (rest.length === 2 && rest[1] === "heartbeat") return method === "PATCH" ? "heartbeat" : null;
  if (rest.length === 2 && rest[1] === "sync") return method === "POST" ? "sync" : null;
  if (rest.length === 4 && rest[1] === "connections" && rest[3] === "activate") {
    return method === "POST" ? "activate" : null;
  }
  return null;
}

function hasRealtimeMessages(body: Record<string, unknown>): boolean {
  return (
    Array.isArray(body.entries) &&
    body.entries.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        REALTIME_MESSAGE_KINDS.has((entry as { kind?: unknown }).kind as string),
    )
  );
}

/** Server context goes before the browser's on each message-bearing entry. */
function withRealtimeContext(
  body: Record<string, unknown>,
  serverContext: string | undefined,
): Record<string, unknown> {
  if (!serverContext?.trim() || !Array.isArray(body.entries)) return body;
  return {
    ...body,
    entries: body.entries.map((entry: unknown) => {
      if (entry === null || typeof entry !== "object") return entry;
      const record = entry as Record<string, unknown>;
      if (!REALTIME_MESSAGE_KINDS.has(record.kind as string)) return entry;
      const modelContext = joinContext(
        serverContext,
        typeof record.modelContext === "string" ? record.modelContext : undefined,
      );
      return modelContext ? { ...record, modelContext } : entry;
    }),
  };
}

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
    // Opengeni calls the tool server from its own network; use a tunnel locally.
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
const SITE_LIST_FIELDS = ["limit", "cursor", "status"] as const;
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
// Same delivery contract as Opengeni's own route: the browser fetches the
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

/** The browser's byte range, passed through unchanged when well formed. */
function retainedRange(request: Request): { range?: string } {
  const range = request.headers.get("range");
  if (range === null) return {};
  if (range.length > 128 || /[^\x20-\x7e]/.test(range)) {
    reject(400, "invalid_range", "Range must be at most 128 printable ASCII bytes.");
  }
  return { range };
}

/** One bounded retained-artifact page, with the range facts the browser SDK verifies. */
function retainedContent(content: RetainedArtifactContent): Response {
  return new Response(content.bytes as Uint8Array<ArrayBuffer>, {
    status: content.status,
    headers: {
      "Content-Type": content.contentType,
      "Content-Length": String(content.contentLength),
      ...(content.contentRange ? { "Content-Range": content.contentRange } : {}),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      // Bytes for the conversation's own reader; never rendered on this origin.
      "Content-Security-Policy": "sandbox",
      "Content-Disposition": "attachment",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
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
  const bytes = await readBoundedBytes(request, maxBytes);
  if (bytes.byteLength === 0) {
    if (optional) return undefined;
    reject(400, "invalid_body", "A JSON object body is required.");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    reject(415, "unsupported_media_type", "Send application/json.");
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

async function readBoundedBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
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
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

function createInput(
  body: Record<string, unknown> | undefined,
  modelSelection: boolean,
): SessionProxyCreateInput {
  for (const key of Object.keys(body ?? {})) {
    if (!CREATE_FIELDS.has(key) && !(modelSelection && isModelField(key))) {
      reject(
        400,
        "create_field_not_allowed",
        `The server chooses session configuration; "${key}" cannot be set from the browser.`,
      );
    }
  }
  const initialMessage = body?.initialMessage;
  const idempotencyKey = body?.idempotencyKey;
  const startMode = body?.startMode;
  if (startMode !== undefined && startMode !== "realtime") {
    reject(400, "invalid_start_mode", "startMode must be realtime when supplied.");
  }
  if (startMode === "realtime" && initialMessage !== undefined && initialMessage !== "") {
    reject(
      400,
      "initial_message_not_allowed",
      "Voice-first creation does not send an initial message.",
    );
  }
  if (startMode !== "realtime" && (typeof initialMessage !== "string" || !initialMessage.trim())) {
    reject(400, "initial_message_required", "initialMessage is required.");
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey)) {
    reject(400, "invalid_idempotency_key", "idempotencyKey must be a non-empty string.");
  }
  const resources = createResources(body?.resources);
  if (startMode === "realtime" && resources.length > 0) {
    reject(400, "resource_not_allowed", "Keep attachments in the draft until a message is sent.");
  }
  const policy: Pick<SessionProxyCreateInput, "model" | "reasoningEffort" | "latencyMode"> = {};
  for (const field of MODEL_FIELDS) {
    const value = body?.[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value) {
      reject(400, "invalid_model_policy", `${field} must be a non-empty string.`);
    }
    (policy as Record<string, string>)[field] = value;
  }
  return {
    initialMessage: startMode === "realtime" ? "" : (initialMessage as string),
    ...(startMode === "realtime" ? { startMode } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(resources.length > 0 ? { resources } : {}),
    ...policy,
  };
}

function isModelField(key: string): boolean {
  return (MODEL_FIELDS as readonly string[]).includes(key);
}

/** First-message attachments: file references only, nothing else on them. */
function createResources(value: unknown): FileResourceRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    reject(403, "resource_not_allowed", "Only file attachments may be added from the browser.");
  }
  return value.map((resource: unknown) => {
    const file = resource as Partial<FileResourceRef> | null;
    if (
      !file ||
      typeof file !== "object" ||
      file.kind !== "file" ||
      typeof file.fileId !== "string" ||
      !file.fileId ||
      (file.mountPath !== undefined && typeof file.mountPath !== "string")
    ) {
      reject(403, "resource_not_allowed", "Only file attachments may be added from the browser.");
    }
    return {
      kind: "file",
      fileId: file.fileId,
      ...(file.mountPath !== undefined ? { mountPath: file.mountPath } : {}),
    };
  });
}

/** Browser attachments are added; explicit browser model choices win, as for messages. */
function withBrowserCreateChoices(
  created: CreateSessionRequest,
  input: SessionProxyCreateInput,
): CreateSessionRequest {
  const existing = created.resources ?? [];
  const attached = new Set(
    existing.flatMap((resource) => (resource.kind === "file" ? [resource.fileId] : [])),
  );
  const added = (input.resources ?? []).filter((resource) => !attached.has(resource.fileId));
  return {
    ...created,
    // Preserve browser retry identity even when a simple host hook omits it;
    // an explicit server-owned key continues to take precedence.
    ...(created.idempotencyKey === undefined && input.idempotencyKey
      ? { idempotencyKey: input.idempotencyKey }
      : {}),
    ...(input.startMode === "realtime" ? { startMode: "realtime", initialMessage: undefined } : {}),
    ...(added.length > 0 ? { resources: [...existing, ...added] } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.latencyMode ? { latencyMode: input.latencyMode } : {}),
  };
}

/** One multipart recording: only the audio, its MIME type, and its duration pass. */
async function transcriptionInput(request: Request): Promise<{
  audio: File;
  mimeType: string;
  durationSeconds?: number;
  signal: AbortSignal;
}> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\b/i.test(contentType)) {
    reject(415, "unsupported_media_type", "Send multipart/form-data.");
  }
  const bytes = await readBoundedBytes(request, MAX_TRANSCRIPTION_BODY_BYTES);
  // Only the fields this route reads; structural, so DOM and React Native
  // typings of FormData both satisfy it.
  let form: { get(name: string): File | string | null };
  try {
    form = (await new Response(bytes, {
      headers: { "Content-Type": contentType },
    }).formData()) as unknown as { get(name: string): File | string | null };
  } catch {
    reject(400, "invalid_audio", "The recording could not be read.");
  }
  const audio = form.get("audio");
  const mimeType = form.get("mimeType");
  const duration = form.get("durationSeconds");
  if (!(audio instanceof File)) reject(400, "invalid_audio", "Audio file is required.");
  const durationSeconds = typeof duration === "string" && duration ? Number(duration) : undefined;
  if (
    durationSeconds !== undefined &&
    !(Number.isFinite(durationSeconds) && durationSeconds >= 0)
  ) {
    reject(400, "invalid_audio", "durationSeconds must be a non-negative number.");
  }
  return {
    audio,
    mimeType: typeof mimeType === "string" && mimeType ? mimeType : audio.type,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    signal: request.signal,
  };
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

/**
 * The proxy always calls Opengeni with the server's own key, so an upstream
 * 401 means that key is wrong, expired or revoked, never that the end user is
 * signed out. Tell the developer once, in the server log, what to fix.
 */
function warnRejectedApiKey(error: OpenGeniApiError, notice: { sent: boolean }): void {
  if (notice.sent) return;
  notice.sent = true;
  console.warn(
    `[@opengeni/sdk] Opengeni rejected the session proxy's API key (401${
      error.correlationId ? `, reference ${error.correlationId}` : ""
    }). It may be expired, revoked or mistyped: create a new key in Opengeni under ` +
      "Organization settings > Developer and update OPENGENI_API_KEY on the server.",
  );
}

/** Preserve Opengeni's error envelope so the browser SDK keeps codes, retryability, and outcome facts. */
function errorResponse(error: unknown, rejectedKeyNotice: { sent: boolean }): Response {
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
    if (error.status === 401) warnRejectedApiKey(error, rejectedKeyNotice);
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
  // The browser gets no details; the host's server log needs the cause
  // (for example a missing OPENGENI_API_KEY).
  console.error("[@opengeni/sdk] Session proxy request failed:", error);
  return errorJson(500, "proxy_error", "Request could not be completed.");
}
