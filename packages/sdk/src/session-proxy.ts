import type { OpenGeniEmbeddingClient } from "./embedding-client";
import { OpenGeniApiError, OpenGeniSetupError } from "./errors";
import { chatDefaults, type Chats } from "./chats";
import { SESSION_SCOPE_HEADER } from "./message-links";
import type { WorkspaceIdOptions, WorkspaceIdTarget } from "./tenant-workspaces";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "./types";
import type {
  AccessGrant,
  AccessContext,
  CreateSessionRequest,
  FileResourceRef,
  LatencyMode,
  ReasoningEffort,
  SessionMcpCredentialUpdateInput,
} from "./types";
import { mintToolToken, resolveToolTokenSecret } from "./tool-auth";
import { getSessionProxyWorkspaceGrant } from "./session-proxy-client";
import { normalizeMessageTimeZone } from "@opengeni/contracts/message-time-zone";
export {
  getSessionProxyArtifactAssociation,
  getSessionProxyWorkspaceGrant,
} from "./session-proxy-client";

/**
 * The product relay: Opengeni's API, served from the product's own origin to
 * the product's signed-in users.
 *
 * Mount the handler at a catch-all route (for example `/api/opengeni/*`) and
 * point an unmodified browser `OpenGeniClient({ baseUrl: "/api/opengeni" })`,
 * or any packaged Opengeni UI, at it. On every request the host's `resolve`
 * hook names the user; the relay pins the request to that user's workspace and
 * forwards it to Opengeni as that user (`asUser`), never with the organization
 * key's own authority. Opengeni's permissions for that user decide what the
 * request may do, exactly as they do in Opengeni's own app; the organization
 * key's permissions cap them for every user of the product.
 *
 * What the relay adds is only what the product's server owns: who the user is
 * and which workspace they use (`resolve`, `chats`), how chats are set up when
 * the server builds them (`createSession`, `toolServer`), what the server adds
 * to each message and admits before work starts (`beforeForwardMessage`),
 * which chats a user may open (`authorizeSession`), any routes it keeps closed
 * (`refuse`), and what it records once Opengeni has answered (`afterForward`).
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
 * from `@opengeni/sdk/chat`; workspaces are created on first use. A tenant
 * workspace's signed-in user is added with the facade's `memberPermissions`
 * when those are set, else by Opengeni on their first request.
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
   * files unless the handler sets `visitorUploads: true`; everything else is
   * unchanged.
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
  /** The `asUser` client the relay uses for this request. */
  client: ProxyClient;
  /**
   * The Opengeni route in the resolved workspace this request acts on. Absent
   * only for the bootstrap reads outside the workspace (`GET /v1/workspaces`,
   * `GET /v1/access/me`, `GET /v1/config/client`), the credits checkout read
   * (`GET /v1/billing/checkout/{id}`) and the user's inbox.
   */
  route?: SessionProxyRoute | undefined;
};

/**
 * One Opengeni route in the resolved workspace that the relay is about to
 * forward, for {@link SessionProxyHandlerOptions.refuse}.
 */
export type SessionProxyRoute = {
  method: string;
  /**
   * Path segments after `/v1/workspaces/{workspaceId}`, decoded: `[]` for the
   * workspace itself, `["sessions", "<id>", "archive"]` for a chat's archive.
   */
  segments: readonly string[];
  /** The chat a `sessions/{id}/...` route acts on, else the chat named in `x-opengeni-session-id`. */
  sessionId?: string | undefined;
};

/**
 * What the browser supplies when creating a chat while the server owns chat
 * setup (`createSession` is set), besides `modelContext`: as for follow-up
 * messages, `beforeForwardMessage` receives it as `browserContext`, and the
 * relay appends it (or what that hook returns in its place) after the
 * server's context. After the hook returns, the relay adds the
 * attached files to the created request (deduplicated by file id) and, when
 * `modelSelection` is not `false`, applies the browser's explicit model
 * choices over the hook's, exactly as follow-up messages carry them. Return a
 * `Response` from the hook to refuse an input.
 */
export type SessionProxyCreateInput = {
  /** Empty for a voice-first session; no initial user message is fabricated. */
  initialMessage: string;
  /** A voice-first chat that starts in live voice. */
  startMode?: "realtime" | undefined;
  /** Browser retry key; replay is scoped to the acting user by the API. */
  idempotencyKey?: string | undefined;
  /** Files attached to the first message (uploaded through this relay). */
  resources?: FileResourceRef[] | undefined;
  /** The user's model choice; only when `modelSelection` is not `false`. */
  model?: string | undefined;
  /** The user's reasoning choice; only when `modelSelection` is not `false`. */
  reasoningEffort?: ReasoningEffort | undefined;
  /** The user's latency choice; only when `modelSelection` is not `false`. */
  latencyMode?: LatencyMode | undefined;
};

/**
 * Which browser action is about to forward a user message or response, or to
 * start the agent working again without one.
 */
export type SessionProxyMessageInput = {
  /** Absent for `create`. */
  sessionId?: string | undefined;
  /** An empty voice-first session shell, not an initial model-producing turn. */
  startMode?: "realtime" | undefined;
  /**
   * - `create`, `send`, `steer` and `submit` (a saved composer draft, sent or
   *   steered) carry a new message: `modelContext` applies.
   * - `approval` and `answer` are the person's decision on a tool call and
   *   their reply to the agent's question.
   * - `resume` (a paused chat), `retry` (a failed turn) and `queue-steer` (a
   *   queued message moved into the running turn) start work without new text.
   * `realtime` is live voice: once when a call starts (refuse it, or rotate
   * MCP credentials), and once for each finalized transcript or spoken request
   * before its batch is saved (refuse the batch, or decide the entry's
   * context; `realtimeKind` names the entry).
   */
  delivery:
    | "create"
    | "send"
    | "steer"
    | "submit"
    | "approval"
    | "answer"
    | "resume"
    | "retry"
    | "queue-steer"
    | "realtime";
  /**
   * The browser's key for this action (`clientEventId`, or `idempotencyKey`
   * for `create`). Opengeni accepts an action once per key, so a retry carries
   * the same key: use it to make your own bookkeeping (billing, context)
   * idempotent. For a voice entry, the entry's `operationId`. Absent when the
   * browser sent none.
   */
  clientEventId?: string | undefined;
  /**
   * The model context the browser attached to this message or voice entry
   * (for example the page, record or selection it was sent from). It is the
   * browser's claim, unverified. The relay forwards it after your own
   * `modelContext` unless you return `browserContext`. Absent when the
   * browser sent none.
   */
  browserContext?: string | undefined;
  /** For a live voice entry, which kind of entry is about to be saved. */
  realtimeKind?: "user_transcript" | "assistant_transcript" | "delegation_call" | undefined;
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
   * What the model gets in place of the browser's `browserContext`: omit it
   * to keep the browser's context as sent, return a string to replace it (for
   * example the validated, normalized form your product accepts), or `null`
   * to drop it. Return a `Response` instead to refuse a malformed claim. Keep
   * it the same for a retry with the same `clientEventId`.
   */
  browserContext?: string | null | undefined;
  /**
   * Header-only credential rotation for MCP servers already attached to the
   * session (for example a fresh short-lived per-user bearer), applied
   * atomically as the message or response is accepted. Ignored for `create`,
   * where the `createSession` hook sets the initial headers.
   */
  mcpCredentialUpdates?: SessionMcpCredentialUpdateInput[] | undefined;
};

/**
 * Your product's own MCP tool server, attached to every chat this relay
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
  /**
   * Tools the agent has from the first model request, so everyday reads (for
   * example search and get-by-id) need no `tool_search` round trip: unprefixed
   * MCP tool names, or `true` for every tool. Other tools stay searchable. Keep
   * the list short and stable: every listed schema is part of each request.
   */
  eager?: string[] | true | undefined;
  /** Token signing secret. Defaults to `OPENGENI_API_KEY`; `verifyToolRequest` must use the same. */
  secret?: string | undefined;
  /** Token lifetime in seconds. Defaults to 24 hours; refreshed on every message, approval, and answer. */
  ttlSeconds?: number | undefined;
};

export type SessionProxyHandlerOptions = {
  /**
   * Private (default) uses personal Knowledge and session-only reach; shared uses
   * workspace Knowledge and reach. Isolated also gives each user their own tenant workspace.
   * With `createSession` these are the server's choice for every chat; without
   * it they fill in what the browser's create request leaves out.
   */
  chats?: Chats | undefined;
  /** Mandatory host auth hook, called on every request. */
  resolve: SessionProxyResolve;
  /**
   * Host CSRF/session policy for non-GET requests. Without it the relay
   * rejects `Sec-Fetch-Site: cross-site` requests and the content types a
   * cross-site HTML form can send (`text/plain`,
   * `application/x-www-form-urlencoded`). Cookie-authenticated hosts should
   * supply their existing CSRF check.
   */
  authorizeMutation?: ((request: Request) => boolean | Promise<boolean>) | undefined;
  /**
   * Optional product-level chat check (for example "this ticket's chat belongs
   * to this user"), run for every `sessions/{id}/...` route and for requests
   * that name a chat in `x-opengeni-session-id`. Opengeni still enforces
   * membership and private visibility on every call.
   */
  authorizeSession?:
    | ((sessionId: string, context: SessionProxyContext) => boolean | Promise<boolean>)
    | undefined;
  /**
   * Server-owned chat setup. When set, the browser supplies only
   * {@link SessionProxyCreateInput}; this hook returns the complete create
   * request (agent, tools, MCP servers, Skills, instructions, model policy), and
   * the relay refuses the routes that would change that setup afterwards: a
   * chat's agent, tool policy, Skills, variable sets, usage limit, visibility,
   * active sandbox and Codex account, forks, and `chat/completions`.
   *
   * Without it, the browser creates chats with Opengeni's own create request,
   * limited by the user's permissions.
   */
  createSession?:
    | ((
        input: SessionProxyCreateInput,
        context: SessionProxyContext,
      ) => CreateSessionRequest | Response | Promise<CreateSessionRequest | Response>)
    | undefined;
  /**
   * Called before every forwarded user message (send, steer, composer submit,
   * and browser-started create), approval decision, human-input answer, every
   * request that starts the agent working again without a message (resume,
   * retry, queue steer), and live voice start and transcript save
   * (`delivery: "realtime"`): every browser action that starts model work.
   * Return server-owned `modelContext` and what replaces the browser's own
   * context (`browserContext`; both for messages and voice transcripts only),
   * MCP credential rotations, or a `Response` to reject the action. For
   * actions without a message body, the relay applies the rotations before
   * forwarding.
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
   * Keep routes closed that Opengeni would let this user reach. Return `true`
   * to answer 404 `route_not_allowed`, or your own `Response`. Prefer narrowing
   * the organization key's permissions or the members' roles: those apply to
   * every client, this only to the relay.
   */
  refuse?:
    | ((
        route: SessionProxyRoute,
        context: SessionProxyContext,
      ) => boolean | Response | undefined | Promise<boolean | Response | undefined>)
    | undefined;
  /**
   * Called with Opengeni's answer to every request the relay forwarded in the
   * resolved workspace, before the browser gets it: record what the product
   * keeps beside Opengeni (a file's owner from an upload's answer, a new chat's
   * id, a chat's last activity). Return a `Response` to answer the browser
   * instead, or nothing to pass Opengeni's answer on. Opengeni has already
   * acted: refusing here does not undo it. The response may be an event
   * stream; read only bodies of routes you recognize, from `response.clone()`.
   */
  afterForward?:
    | ((
        route: SessionProxyRoute,
        response: Response,
        context: SessionProxyContext,
      ) => Response | undefined | Promise<Response | undefined>)
    | undefined;
  /**
   * Attach your product's MCP tool server to every chat this relay creates,
   * authenticated as the resolved user. The relay mints the token, adds the
   * `mcpServers` entry (with its `eager` tools, or every tool when the request
   * lists explicit `tools`), and rotates the token on every send, steer,
   * submit, approval decision, and human-input answer by the chat's creator.
   */
  toolServer?: SessionProxyToolServer | undefined;
  /** Mount prefix, e.g. `/api/opengeni`. Defaults to everything before the first `/v1/`. */
  basePath?: string | undefined;
  /** Maximum JSON body for the requests the relay reads (create and messages). Defaults to 1 MiB. */
  maxBodyBytes?: number | undefined;
  /**
   * Let anonymous visitors (`resolve` returned `visitor: true`) upload files.
   * Defaults to false: for a visitor the client config reports file uploads
   * off, so stock UIs hide the attach button, and the upload routes are
   * refused.
   */
  visitorUploads?: boolean | undefined;
  /**
   * Let the browser choose model, reasoning effort, and latency per message,
   * draft, or new chat (still limited by the workspace model catalog). When
   * false those choices are removed from messages and draft saves, and refused
   * on create. Saves use the actor's
   * server-owned draft policy (initially the session defaults). Submit must repeat
   * the saved policy unchanged as an integrity fence, not a new selection: the
   * API atomically checks the saved revision/content or replays the original
   * receipt. Defaults to true.
   * Pass `true` explicitly to also show end users the stock model picker
   * (`SessionConversation`/`OpenGeniChat` hide it unless asked).
   */
  modelSelection?: boolean | undefined;
  /**
   * The editable-artifact live socket URL the browser connects to directly,
   * when it differs from the relay client's own API URL (for example an
   * internal service address). Ticket-authenticated; never relayed.
   */
  editableLiveUrl?: string | undefined;
  /**
   * Event-stream heartbeat interval. Defaults to 5 seconds, under Bun.serve's
   * default 10-second `idleTimeout`, which otherwise closes a quiet stream.
   */
  heartbeatMs?: number | undefined;
};

/**
 * Default event-stream heartbeat. Bun.serve closes a connection that sends
 * nothing for 10 seconds by default, and Opengeni's own heartbeat is slower.
 */
const SESSION_PROXY_DEFAULT_HEARTBEAT_MS = 5_000;

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** A Stripe Checkout session id, as the billing routes accept it. */
const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/;
/**
 * A decoded path segment the relay forwards: Opengeni paths carry ids, keys and
 * subject ids (`user:…`), so any text is allowed except empty, dot, separator
 * and control-character segments. Forwarded segments are re-encoded.
 */
const MAX_SEGMENT_LENGTH = 512;
function relayableSegment(decoded: string): boolean {
  return (
    decoded.length > 0 &&
    decoded.length <= MAX_SEGMENT_LENGTH &&
    decoded !== "." &&
    decoded !== ".." &&
    !/[/\\\u0000-\u001f\u007f]/u.test(decoded)
  );
}
const CREATE_FIELDS: ReadonlySet<string> = new Set([
  "initialMessage",
  "idempotencyKey",
  "resources",
  "startMode",
  "modelContext",
  // The person's own time zone, so the agent sees their local time.
  "timeZone",
  // Packaged-app bookkeeping; see `browserCreateFields`.
  "visibility",
  "clientEventId",
  "connectionAccounts",
  "expectedNewSessionDraftRevision",
]);
const MODEL_FIELDS = ["model", "reasoningEffort", "latencyMode"] as const;

/** Methods the relay forwards. */
const PROXY_METHODS: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Request headers the browser's own request may carry to Opengeni: content
 * negotiation, stream resume, ranges, conditional reads, and Opengeni's own
 * request metadata (chat scope, correlation, voice chunk facts). Never cookies,
 * credentials or attribution: the relay alone decides who is acting.
 */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "range",
  "if-none-match",
  "if-match",
  "if-modified-since",
  "x-opengeni-session-id",
  "x-opengeni-correlation-id",
  "x-opengeni-chunk-sha256",
  "x-opengeni-chunk-start-milliseconds",
  "x-opengeni-chunk-duration-milliseconds",
] as const;

/** Response headers relayed besides Opengeni's own `x-opengeni-*` metadata. */
const RELAYED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "retry-after",
  "cross-origin-resource-policy",
] as const;

/**
 * Chat setup the server owns when `createSession` is set, as
 * `${method} ${route after sessions/{id}}`, or the workspace route.
 */
const SERVER_OWNED_SESSION_ROUTES: ReadonlySet<string> = new Set([
  "PUT agent",
  "PUT tool-policy",
  "PUT skills",
  "PUT variable-sets",
  "PUT usage-limit",
  "PUT visibility",
  "POST active-sandbox",
  "POST codex-account",
  "POST forks",
]);

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

const notAllowed = () => errorJson(404, "route_not_allowed", "Not found.");

function isFacade(target: ProxyClient | ProxyFacade): target is ProxyFacade {
  return !("asUser" in target) && "client" in target;
}

/**
 * Create the product relay. Returns a web-standard
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
  // Null when the relay client has no absolute API URL and none is given:
  // the artifact viewer is then off.
  const editableLiveUrl = optionalLiveSocketUrl(
    options.editableLiveUrl ?? service.apiUrl(EDITABLE_ARTIFACT_LIVE_PATH),
    options.editableLiveUrl !== undefined,
  );
  const modelSelection = options.modelSelection ?? true;
  const heartbeatMs = options.heartbeatMs ?? SESSION_PROXY_DEFAULT_HEARTBEAT_MS;
  const serverOwnsSetup = options.createSession !== undefined;
  const chats = options.chats ?? "private";
  const defaults = chatDefaults(chats);
  const toolServer = options.toolServer ? normalizeToolServer(options.toolServer) : undefined;
  // Whether a session carries this relay's tool server (attachments are immutable).
  const toolSessions = new Map<string, Promise<string | null>>();
  // Canonical subject per external user, for the tool server's creator check.
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
      const reading = method === "GET" || method === "HEAD";
      if (reading) {
        // Catalog logos beside connectors and tools; not user data.
        const asset = catalogAssetPath(url.pathname, options.basePath);
        if (asset) {
          try {
            const blob = await service.downloadCatalogAsset(asset, { signal: request.signal });
            return new Response(blob, {
              headers: {
                "Content-Type": blob.type,
                "Cache-Control": "public, max-age=3600",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                "X-Content-Type-Options": "nosniff",
              },
            });
          } catch {
            // Missing, malformed or not an image: the app shows its fallback mark.
            return notAllowed();
          }
        }
      }
      const segments = routeSegments(url.pathname, options.basePath);
      if (!segments) return notAllowed();

      if (!reading) {
        const allowed = options.authorizeMutation
          ? await options.authorizeMutation(request)
          : defaultMutationPolicy(request);
        if (!allowed) return errorJson(403, "mutation_denied", "Request denied.");
      }
      const source = resolved.source ?? defaultSource;
      const workspaceId = await resolveWorkspace(target, resolved, source, chats);
      const client = service.asUser(resolved.user, { source });
      const context: SessionProxyContext = {
        request,
        workspaceId,
        user: resolved.user,
        source,
        client,
      };
      const call = { signal: request.signal };
      const query = Object.fromEntries(url.searchParams);
      const uploadsEnabled = resolved.visitor !== true || options.visitorUploads === true;

      const [root, ...rest] = segments;
      if (root === "inbox") {
        // The user's own inbox, as the user: its items in this workspace only,
        // and their inbox settings (`authorizeMutation` can keep those read-only).
        const listing = rest.length === 0 && reading;
        const item =
          rest.length === 2 && rest[0] === "items" && SEGMENT.test(rest[1]!) && method === "PATCH";
        const settings =
          rest.length === 1 && rest[0] === "settings" && (reading || method === "PUT");
        if (!listing && !item && !settings) return notAllowed();
        const inboxUrl = new URL(
          client.apiUrl(`/v1/${segments.map(encodeURIComponent).join("/")}`),
        );
        if (listing || item) inboxUrl.searchParams.set("workspaceId", workspaceId);
        return relayResponse(
          await client.fetchApi(inboxUrl.toString(), {
            method,
            headers: forwardedHeaders(request, false),
            ...(reading || request.body === null ? {} : { body: request.body, duplex: "half" }),
            signal: request.signal,
          } as RequestInit),
          heartbeatMs,
          rejectedKeyNotice,
        );
      }
      if (root !== "workspaces" || rest.length === 0) {
        // Outside the workspace, only the app's bootstrap reads, answered for
        // the resolved workspace alone, never the user's other workspaces or
        // the key's own authority.
        if (!reading) return notAllowed();
        if (root === "workspaces") {
          // One read of the resolved workspace as the user, not a list of all of theirs.
          try {
            return json([await client.getWorkspace(workspaceId)]);
          } catch (error) {
            const notReadable =
              error instanceof OpenGeniApiError && (error.status === 403 || error.status === 404);
            if (notReadable) return json([]);
            throw error;
          }
        }
        if (root === "access" && rest.length === 1 && rest[0] === "me") {
          // An external actor's access inventory is empty: its authority for
          // this workspace is the effective grant, so the app gets exactly that.
          const [access, grant] = await Promise.all([
            client.getAccessContext(),
            getSessionProxyWorkspaceGrant(client, workspaceId, call),
          ]);
          return json(scopedAccessContext(access, grant));
        }
        if (root === "config" && rest.length === 1 && rest[0] === "client") {
          return json(
            await clientConfig({
              client,
              workspaceId,
              source,
              query,
              editableLiveUrl,
              uploadsEnabled,
              modelSelection: options.modelSelection,
              chatConnections: !serverOwnsSetup,
              call,
            }),
          );
        }
        if (
          root === "billing" &&
          rest.length === 2 &&
          rest[0] === "checkout" &&
          CHECKOUT_SESSION_ID.test(rest[1]!)
        ) {
          // A credits payment the chat confirms: one checkout of the resolved
          // workspace's own organization, read as the user, so Opengeni checks
          // their billing:read on that organization and that the checkout is
          // its own. The browser can't name another organization.
          // Like the other account-level reads above, it runs before `refuse`
          // and `authorizeSession`: it names no chat, and it can only read,
          // with the user's own permission, a checkout of this workspace's
          // organization.
          const grant = await getSessionProxyWorkspaceGrant(client, workspaceId, call);
          const checkoutUrl = new URL(
            client.apiUrl(`/v1/billing/checkout/${encodeURIComponent(rest[1]!)}`),
          );
          checkoutUrl.searchParams.set("accountId", grant.accountId);
          return relayResponse(
            await client.fetchApi(checkoutUrl.toString(), {
              method,
              headers: forwardedHeaders(request, false),
              signal: request.signal,
            }),
            heartbeatMs,
            rejectedKeyNotice,
          );
        }
        return notAllowed();
      }

      const [pathWorkspaceId, ...route] = rest as [string, ...string[]];
      if (pathWorkspaceId !== workspaceId) {
        return errorJson(403, "workspace_not_allowed", "This workspace is not available.");
      }
      const inSession = route[0] === "sessions" && route.length >= 2;
      // Chat ids are opaque tokens; `authorizeSession` never sees other text.
      if (inSession && !SEGMENT.test(route[1]!)) return notAllowed();
      let sessionId = inSession ? route[1] : undefined;
      if (!sessionId) {
        const named = request.headers.get(SESSION_SCOPE_HEADER)?.trim();
        if (named) {
          if (!SEGMENT.test(named)) {
            reject(400, "session_scope_invalid", "x-opengeni-session-id is invalid.");
          }
          sessionId = named;
        }
      }
      const routeInfo: SessionProxyRoute = { method, segments: route, sessionId };
      context.route = routeInfo;
      if (
        sessionId &&
        options.authorizeSession &&
        !(await options.authorizeSession(sessionId, context))
      ) {
        return errorJson(404, "session_not_found", "Session not found.");
      }
      const op = inSession ? `${method} ${route.slice(2).join("/")}` : "";
      if (serverOwnsSetup && (SERVER_OWNED_SESSION_ROUTES.has(op) || isChatCompletions(route))) {
        return notAllowed();
      }
      // MCP credentials are the server's (`beforeForwardMessage`, `toolServer`).
      if (op === "POST mcp-credentials/rotate") return notAllowed();
      // Imported history is written as genuine transcript: only the product's
      // server can vouch for it (`@opengeni/sdk/session-history-import`).
      if (route[0] === "session-imports") return notAllowed();
      if (!uploadsEnabled && route[0] === "files" && route[1] === "uploads") {
        return notAllowed();
      }
      if (options.refuse) {
        const refused = await options.refuse(routeInfo, context);
        if (refused instanceof Response) return refused;
        if (refused) return notAllowed();
      }

      const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}${
        route.length > 0 ? `/${route.map(encodeURIComponent).join("/")}` : ""
      }`;
      const forward = async (body?: Record<string, unknown>): Promise<Response> => {
        const send = async () =>
          await client.fetchApi(client.apiUrl(`${path}${url.search}`), {
            method,
            headers: forwardedHeaders(request, body !== undefined),
            ...(body !== undefined
              ? { body: JSON.stringify(body) }
              : reading || request.body === null
                ? {}
                : { body: request.body, duplex: "half" }),
            signal: request.signal,
          } as RequestInit);
        // Opengeni accepts a keyed action once and answers a repeat with the
        // first outcome, so when this hop cannot tell whether the first attempt
        // landed (the connection failed, or Opengeni answered 408 or 5xx) the
        // relay sends it once more instead of losing or doubling it.
        const retryable = body !== undefined && actionKey(body) !== undefined;
        let upstream: Response;
        try {
          upstream = await send();
        } catch (error) {
          if (!retryable || request.signal.aborted) throw error;
          upstream = await send();
        }
        if (retryable && outcomeUnknown(upstream.status) && !request.signal.aborted) {
          await upstream.body?.cancel().catch(() => undefined);
          upstream = await send();
        }
        const relayed = relayResponse(upstream, heartbeatMs, rejectedKeyNotice);
        return (await options.afterForward?.(routeInfo, relayed, context)) ?? relayed;
      };

      // --- Server-owned additions: the few routes whose body the relay reads.

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
      const toolServerOwner = (id: string): Promise<string | null> => {
        const key = `${workspaceId}\u0000${id}`;
        let attached = toolSessions.get(key);
        if (!attached) {
          attached = client
            .getSession(workspaceId, id, call)
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
      /** A browser message sanitized, then server-owned extras merged in, or the hook's refusal. */
      const userMessage = async (
        value: unknown,
        input: SessionProxyMessageInput,
      ): Promise<Record<string, unknown> | Response> => {
        // Submit repeats the saved policy as a mandatory integrity fence. Never
        // replace it with a newer draft's policy: outcome-unknown retries must
        // retain the original receipt hash. The API rejects any new selection.
        const { modelContext: sent, ...message } = sanitizeMessage(
          value,
          modelSelection || input.delivery === "submit",
        );
        const browser = withBrowserContext(sent);
        const extras = await messageExtras({ ...input, ...browser });
        if (extras instanceof Response) return extras;
        const modelContext = joinContext(
          extras?.modelContext,
          decidedBrowserContext(extras, browser.browserContext),
        );
        return {
          ...message,
          ...(modelContext ? { modelContext } : {}),
          ...(extras?.mcpCredentialUpdates?.length
            ? { mcpCredentialUpdates: extras.mcpCredentialUpdates }
            : {}),
        };
      };
      const forwardMessage = async (value: unknown, input: SessionProxyMessageInput) => {
        const message = await userMessage(value, input);
        return message instanceof Response ? message : await forward(message);
      };
      /**
       * An action that starts work without a message (resume, retry, queue
       * steer): the host admits it, and its credential rotations are applied
       * before the agent continues.
       */
      const forwardRestart = async (
        body: Record<string, unknown>,
        input: SessionProxyMessageInput & { sessionId: string },
      ) => {
        const extras = await messageExtras(input);
        if (extras instanceof Response) return extras;
        await refreshSessionCredentials(
          client,
          workspaceId,
          input.sessionId,
          extras?.mcpCredentialUpdates ?? [],
          call,
        );
        return await forward(body);
      };

      if (route.length === 1 && route[0] === "sessions" && method === "POST") {
        const body = (await readJsonBody(request, maxBodyBytes))!;
        if (!options.createSession) {
          // Opengeni's own create request, as the user, with the server's additions.
          const { modelContext: sent, ...created } = browserPayload(body) as CreateSessionRequest;
          if (!modelSelection) for (const field of MODEL_FIELDS) delete created[field];
          const browser = withBrowserContext(sent);
          const extras = await messageExtras({
            delivery: "create",
            ...(created.startMode === "realtime" ? { startMode: "realtime" as const } : {}),
            ...keyed(actionKey(created)),
            ...browser,
          });
          if (extras instanceof Response) return extras;
          const modelContext = joinContext(
            extras?.modelContext,
            decidedBrowserContext(extras, browser.browserContext),
          );
          return await forward({
            ...defaults,
            ...(toolServer
              ? withToolServer(created, toolServer, await toolToken(), "browser")
              : created),
            ...(modelContext ? { modelContext } : {}),
          });
        }
        const input = createInput(body, modelSelection);
        const browser = browserCreateFields(body);
        const hooked = await options.createSession(input, context);
        if (hooked instanceof Response) return hooked;
        const created = withBrowserCreateChoices(
          toolServer
            ? withToolServer(hooked, toolServer, await toolToken(), "createSession")
            : hooked,
          input,
          browser,
        );
        const extras = await messageExtras({
          delivery: "create",
          ...(input.startMode ? { startMode: input.startMode } : {}),
          ...keyed(input.idempotencyKey),
          ...withBrowserContext(browser.modelContext),
        });
        if (extras instanceof Response) return extras;
        const modelContext = joinContext(
          extras?.modelContext,
          created.modelContext,
          decidedBrowserContext(extras, browser.modelContext),
        );
        const response = await forward({
          ...created,
          visibility: created.visibility ?? defaults.visibility,
          agentAccess: created.agentAccess ?? defaults.agentAccess,
          memoryScope: created.memoryScope ?? defaults.memoryScope,
          ...(modelContext ? { modelContext } : {}),
        });
        if (
          response.ok &&
          browser.expectedNewSessionDraftRevision !== undefined &&
          input.startMode !== "realtime"
        ) {
          await clearSentNewSessionDraft(
            client,
            workspaceId,
            browser.expectedNewSessionDraftRevision,
          );
        }
        return response;
      }

      if (inSession && sessionId) {
        switch (op) {
          case "POST events": {
            const body = await readJsonBody(request, maxBodyBytes);
            const event = body as Record<string, unknown>;
            if (event.type === "user.message") {
              const sent = await userMessage(event.payload, {
                sessionId,
                delivery: "send",
                ...keyed(actionKey(event)),
              });
              return sent instanceof Response ? sent : await forward({ ...event, payload: sent });
            }
            if (
              event.type === "user.approvalDecision" ||
              event.type === "user.humanInputResponse"
            ) {
              // Responses carry no new text; only credentials are added.
              const payload = browserPayload(event.payload);
              const extras = await messageExtras({
                sessionId,
                delivery: event.type === "user.approvalDecision" ? "approval" : "answer",
                ...keyed(actionKey(event)),
              });
              if (extras instanceof Response) return extras;
              return await forward({
                ...event,
                payload: {
                  ...payload,
                  ...(extras?.mcpCredentialUpdates?.length
                    ? { mcpCredentialUpdates: extras.mcpCredentialUpdates }
                    : {}),
                },
              });
            }
            return await forward(event);
          }
          case "POST steer": {
            const body = await readJsonBody(request, maxBodyBytes);
            return await forwardMessage(body, {
              sessionId,
              delivery: "steer",
              ...keyed(actionKey(body)),
            });
          }
          case "POST composer-draft/submit": {
            const body = await readJsonBody(request, maxBodyBytes);
            return await forwardMessage(body, {
              sessionId,
              delivery: "submit",
              ...keyed(actionKey(body)),
            });
          }
          case "POST control": {
            const body = (await readJsonBody(request, maxBodyBytes))!;
            if (body.action !== "resume") return await forward(body);
            return await forwardRestart(body, {
              sessionId,
              delivery: "resume",
              ...keyed(actionKey(body)),
            });
          }
          case "POST retry": {
            // A retried turn may pick its model, like a new message.
            const body = browserPayload(await readJsonBody(request, maxBodyBytes));
            if (!modelSelection) for (const field of MODEL_FIELDS) delete body[field];
            return await forwardRestart(body, {
              sessionId,
              delivery: "retry",
              ...keyed(actionKey(body)),
            });
          }
          case "PUT composer-draft": {
            const message = sanitizeMessage(
              await readJsonBody(request, maxBodyBytes),
              modelSelection,
            );
            if (modelSelection) return await forward(message);
            // Save requires explicit policy fields. Use this actor's durable draft,
            // not browser choices. The API's expectedRevision fence rejects races.
            const draft = await client.getComposerDraft(workspaceId, sessionId, call);
            return await forward({
              ...message,
              model: draft.model,
              reasoningEffort: draft.reasoningEffort,
              latencyMode: draft.latencyMode,
            });
          }
          case "POST realtime": {
            // The host may refuse a call; MCP credentials (including the tool
            // server's per-user token) are refreshed before voice can delegate.
            const extras = await messageExtras({ sessionId, delivery: "realtime" });
            if (extras instanceof Response) return extras;
            await refreshSessionCredentials(
              client,
              workspaceId,
              sessionId,
              extras?.mcpCredentialUpdates ?? [],
              call,
            );
            return await forward();
          }
        }
        if (
          method === "POST" &&
          route.length === 5 &&
          route[2] === "queue" &&
          route[4] === "steer"
        ) {
          const body = (await readJsonBody(request, maxBodyBytes))!;
          return await forwardRestart(body, {
            sessionId,
            delivery: "queue-steer",
            ...keyed(actionKey(body)),
          });
        }
        if (
          method === "POST" &&
          route.length === 5 &&
          route[2] === "realtime" &&
          route[4] === "sync" &&
          options.beforeForwardMessage
        ) {
          const body = (await readJsonBody(request, maxBodyBytes))!;
          if (!hasRealtimeMessages(body)) return await forward(body);
          // Each transcript or spoken request becomes its own message, with its
          // own key and its own page: the host decides each entry's context.
          const entries: unknown[] = [];
          for (const entry of body.entries as unknown[]) {
            if (!isRealtimeMessage(entry)) {
              entries.push(entry);
              continue;
            }
            const { modelContext: sent, ...fields } = entry;
            const browser = withBrowserContext(sent);
            const extras = await options.beforeForwardMessage(
              {
                sessionId,
                delivery: "realtime",
                ...keyed(typeof fields.operationId === "string" ? fields.operationId : undefined),
                realtimeKind: fields.kind,
                ...browser,
              },
              context,
            );
            if (extras instanceof Response) return extras;
            const modelContext = joinContext(
              extras?.modelContext,
              decidedBrowserContext(extras, browser.browserContext),
            );
            entries.push(modelContext ? { ...fields, modelContext } : fields);
          }
          return await forward({ ...body, entries });
        }
      }
      return await forward();
    } catch (error) {
      return errorResponse(error, rejectedKeyNotice);
    }
  };
}

/** The workspace this resolution acts in. */
async function resolveWorkspace(
  target: ProxyClient | ProxyFacade,
  resolved: SessionProxyResolution,
  source: string,
  chats: Chats,
): Promise<string> {
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
    return await target.workspaceIdFor(
      { tenant: resolved.tenant, user: resolved.user, source },
      { isolation: "user" },
    );
  }
  if (resolved.workspaceId) return resolved.workspaceId;
  if (resolved.tenant && isFacade(target)) {
    // A signed-in user joins with the facade's `memberPermissions` when those
    // are set; an anonymous visitor is left to Opengeni's first-use defaults.
    return target.workspaceIdFor && !resolved.visitor
      ? await target.workspaceIdFor(
          { tenant: resolved.tenant, user: resolved.user, source },
          { isolation: "tenant" },
        )
      : await target.workspaceId({ tenant: resolved.tenant });
  }
  if (
    !("tenant" in resolved) &&
    !("workspaceId" in resolved) &&
    isFacade(target) &&
    target.workspaceIdFor
  ) {
    // A user alone: their own workspace, keyed by the identity source.
    return await target.workspaceIdFor({ user: resolved.user, source }, { isolation: "user" });
  }
  throw new TypeError(
    "resolve must return a workspaceId (or a tenant or a user alone when given the Opengeni facade).",
  );
}

/** Without a host policy: no cross-site requests and no cross-site form encodings. */
function defaultMutationPolicy(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  return !(
    contentType.startsWith("text/plain") ||
    contentType.startsWith("application/x-www-form-urlencoded")
  );
}

function isChatCompletions(route: readonly string[]): boolean {
  return route.length === 2 && route[0] === "chat" && route[1] === "completions";
}

/** The browser's neutral request headers. */
function forwardedHeaders(request: Request, jsonBody: boolean): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (jsonBody) headers.set("content-type", "application/json");
  if (!headers.has("accept")) headers.set("accept", "application/json");
  return headers;
}

/**
 * Opengeni's answer, errors included, with neutral headers only. Bytes the
 * relay serves from the product's origin never run as a page there: they keep
 * Opengeni's own content security policy, else a sandboxing one.
 */
function relayResponse(
  upstream: Response,
  heartbeatMs: number,
  rejectedKeyNotice: { sent: boolean },
): Response {
  if (upstream.status === 401) warnRejectedApiKey(upstream, rejectedKeyNotice);
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-opengeni-") && lower !== OPENGENI_API_CONTRACT_HEADER) {
      headers.set(name, value);
    }
  });
  headers.set(
    "Content-Security-Policy",
    upstream.headers.get("content-security-policy") ?? "sandbox",
  );
  headers.set("X-Content-Type-Options", "nosniff");
  const status = upstream.status;
  if (status === 204 || status === 205 || status === 304 || upstream.body === null) {
    return new Response(null, { status, headers });
  }
  if (/^text\/event-stream\b/i.test(upstream.headers.get("content-type") ?? "")) {
    headers.set("Cache-Control", "no-cache, no-transform");
    headers.delete("content-length");
    return new Response(withHeartbeat(upstream.body, heartbeatMs), { status, headers });
  }
  return new Response(upstream.body, { status, headers });
}

const HEARTBEAT = new TextEncoder().encode(": ping\n\n");

/**
 * An event stream with a comment line between events every `heartbeatMs`, so
 * hosts and intermediaries with short idle timeouts keep a quiet stream open.
 * Comments go only between whole events, never inside one.
 */
function withHeartbeat(
  body: ReadableStream<Uint8Array>,
  heartbeatMs: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  // The last bytes sent, to tell whether the stream is between events.
  let tail: number[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (!betweenEvents(tail)) return;
        try {
          controller.enqueue(HEARTBEAT);
        } catch {
          stop();
        }
      }, heartbeatMs);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          stop();
          controller.close();
          return;
        }
        if (value.byteLength > 0) {
          tail = [...tail, ...value.subarray(Math.max(0, value.byteLength - 4))].slice(-4);
          controller.enqueue(value);
        }
      } catch (error) {
        stop();
        controller.error(error);
      }
    },
    async cancel(reason) {
      stop();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** Whether the bytes so far end an event (a blank line), or nothing was sent yet. */
function betweenEvents(tail: readonly number[]): boolean {
  if (tail.length === 0) return true;
  const end = tail.slice(-2);
  if (end.length === 2 && end[0] === 10 && end[1] === 10) return true; // \n\n
  if (end.length === 2 && end[0] === 13 && end[1] === 13) return true; // \r\r
  return tail.length === 4 && tail[0] === 13 && tail[1] === 10 && tail[2] === 13 && tail[3] === 10;
}

/** The client config the relay's browser reads: Opengeni's, for this workspace and user. */
async function clientConfig(input: {
  client: ProxyClient;
  workspaceId: string;
  source: string;
  query: Record<string, string>;
  editableLiveUrl: string | null;
  uploadsEnabled: boolean;
  modelSelection: boolean | undefined;
  chatConnections: boolean;
  call: { signal: AbortSignal };
}): Promise<Record<string, unknown>> {
  const { client, workspaceId, call } = input;
  const config = await client.requestJson<Record<string, unknown>>(
    "GET",
    "/v1/config/client",
    undefined,
    { ...input.query, workspaceId },
    call,
  );
  let artifacts: Awaited<ReturnType<typeof artifactViewerCapability>> | false = false;
  try {
    // The editor's live socket is reached directly with a ticket; the cache
    // partition keeps this user's cached artifacts apart from other users'.
    if (input.editableLiveUrl) {
      artifacts = {
        editableLiveUrl: input.editableLiveUrl,
        cachePartition: await cachePartition(
          await getSessionProxyWorkspaceGrant(client, workspaceId, call),
          workspaceId,
          input.source,
        ),
      };
    }
  } catch (error) {
    // Older APIs have no effective-grant read: only the artifact viewer is off.
    if (!(error instanceof OpenGeniApiError) || error.status !== 404) throw error;
  }
  // Task usage limits are set by the product's server, never by the browser.
  const {
    artifacts: _upstreamArtifacts,
    sessionUsageLimits: _upstreamUsageLimits,
    ...conversationConfig
  } = config;
  if (!input.uploadsEnabled) {
    // Stock UIs hide the attach control.
    const uploads = config.fileUploads;
    conversationConfig.fileUploads = {
      ...(uploads && typeof uploads === "object" ? uploads : {}),
      enabled: false,
    };
  }
  return {
    ...conversationConfig,
    // The browser speaks this relay's contract, not the upstream deployment's:
    // report the server SDK's revision so an Opengeni deploy never makes the
    // embedded page look stale (and never triggers a host reload).
    apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
    // The resolved workspace: a browser given only the relay's baseUrl reads
    // it here instead of knowing any Opengeni id.
    workspaceId,
    artifacts,
    // Explicit true also tells stock UIs to offer end users the model picker.
    ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
    // With `createSession` the server owns chat tools, so the browser cannot
    // add a newly connected capability to a chat: stock UIs then leave agent
    // capability cards to the host.
    chatConnections: input.chatConnections,
  };
}

/**
 * The app's access context: the resolved workspace's effective grant only,
 * never the user's other workspaces or the key's own authority.
 */
function scopedAccessContext(access: AccessContext, grant: AccessGrant): AccessContext {
  const { credential: _credential, ...rest } = access;
  return {
    ...rest,
    subjectId: grant.subjectId,
    workspaceGrants: [grant],
    accountGrants: access.accountGrants.filter(
      (accountGrant) => accountGrant.accountId === grant.accountId,
    ),
    defaultWorkspaceId: grant.workspaceId,
    defaultAccountId: grant.accountId,
  };
}

/** `catalog-assets/...` under this relay's base path, or null. */
function catalogAssetPath(pathname: string, basePath: string | undefined): string | null {
  const prefix = `${basePath !== undefined ? basePath.replace(/\/+$/, "") : ""}/v1/catalog-assets/`;
  const start = basePath !== undefined ? 0 : pathname.indexOf("/v1/catalog-assets/");
  if (start < 0 || !pathname.startsWith(prefix, start)) return null;
  const asset = pathname.slice(start + prefix.length);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(asset)) return null;
  return `catalog-assets/${asset}`;
}

/** Ledger entries that become (or join) messages and so accept `modelContext`. */
const REALTIME_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "delegation_call",
  "user_transcript",
  "assistant_transcript",
]);

type RealtimeMessageEntry = Record<string, unknown> & {
  kind: NonNullable<SessionProxyMessageInput["realtimeKind"]>;
};

function isRealtimeMessage(entry: unknown): entry is RealtimeMessageEntry {
  return (
    entry !== null &&
    typeof entry === "object" &&
    REALTIME_MESSAGE_KINDS.has((entry as { kind?: unknown }).kind as string)
  );
}

function hasRealtimeMessages(body: Record<string, unknown>): boolean {
  return Array.isArray(body.entries) && body.entries.some(isRealtimeMessage);
}

/**
 * Best-effort standalone rotation before work starts without a message body to
 * carry it (a voice call, resume, retry, queue steer). Opengeni refuses it
 * while a turn is running; that turn's message already refreshed them.
 */
async function refreshSessionCredentials(
  client: ProxyClient,
  workspaceId: string,
  sessionId: string,
  updates: SessionMcpCredentialUpdateInput[],
  call: { signal: AbortSignal },
): Promise<void> {
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
  const eager = toolServer.eager;
  if (eager !== undefined && eager !== true && !(Array.isArray(eager) && eager.every(isToolName))) {
    throw new TypeError("toolServer.eager must be true or a list of tool names.");
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

/**
 * Attach the product tool server with a fresh per-user token. An id collision
 * in the browser's own create request is the browser's error; one returned by
 * `createSession` is the product's, so it fails as a server error.
 */
function withToolServer(
  created: CreateSessionRequest,
  toolServer: NormalizedToolServer,
  token: string,
  from: "browser" | "createSession",
): CreateSessionRequest {
  const servers = created.mcpServers ?? [];
  if (servers.some((server) => server.id === toolServer.id)) {
    if (from === "createSession") {
      throw new TypeError(
        `createSession already attaches an MCP server with the toolServer id "${toolServer.id}".`,
      );
    }
    throw new ProxyRejection(
      400,
      "tool_server_id_taken",
      `An MCP server with the tool server id "${toolServer.id}" is already attached.`,
    );
  }
  const ask = toolServer.approvals?.ask;
  const eager =
    toolServer.eager === true
      ? true
      : toolServer.eager?.length
        ? [...new Set(toolServer.eager)]
        : undefined;
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
        ...(eager !== undefined ? { eager } : {}),
      },
    ],
    // Omitted tools keep workspace defaults; the attachment alone selects the
    // server, and its `eager` marker names the first-request tools. An explicit
    // allow-list without an `eager` choice gets every server tool on the first
    // request.
    ...(Array.isArray(tools) && !tools.some((tool) => tool.id === toolServer.id)
      ? {
          tools: [...tools, { kind: "mcp" as const, id: toolServer.id, eager: eager ?? true }],
        }
      : {}),
  };
}

const EDITABLE_ARTIFACT_LIVE_PATH = "/v1/editable-artifacts/live";

function optionalLiveSocketUrl(value: string, explicit: boolean): string | null {
  try {
    return liveSocketUrl(value);
  } catch (error) {
    if (explicit) throw error;
    return null;
  }
}

function liveSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new TypeError("editableLiveUrl must be an HTTP(S) or WS(S) URL");
  }
  return url.href;
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
  grant: AccessGrant,
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
): Promise<AccessGrant> {
  const access = await client.getAccessContext();
  const grant = access.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId);
  if (!grant) reject(403, "workspace_not_allowed", "This workspace is not available.");
  return grant;
}

/** Native path segments after the mount prefix, starting at `v1`'s child; null when not a relayed path. */
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
    // Rejects empty, dot, and encoded-separator segments before any path is built.
    if (!relayableSegment(decoded)) return null;
    segments.push(decoded);
  }
  return segments;
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown> | undefined> {
  const bytes = await readBoundedBytes(request, maxBytes);
  if (bytes.byteLength === 0) {
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
type BrowserCreateFields = {
  modelContext?: string | undefined;
  timeZone?: string | undefined;
  clientEventId?: string | undefined;
  expectedNewSessionDraftRevision?: number | undefined;
};

/**
 * The browser's own context and the packaged app's create bookkeeping. Message
 * context is appended after the server's, as on follow-up messages. The app
 * also sends the id of its first message event and the revision of the
 * new-chat draft it sent, which the relay clears once the chat exists. It
 * sends `visibility` and an empty `connectionAccounts` too: the server chooses
 * both, so those are dropped, and any account selection is refused.
 */
function browserCreateFields(body: Record<string, unknown> | undefined): BrowserCreateFields {
  const fields: BrowserCreateFields = {};
  const modelContext = body?.modelContext;
  if (modelContext !== undefined && typeof modelContext !== "string") {
    reject(400, "invalid_model_context", "modelContext must be a string.");
  }
  if (modelContext?.trim()) fields.modelContext = modelContext;
  const timeZone = normalizeMessageTimeZone(body?.timeZone);
  if (timeZone) fields.timeZone = timeZone;
  const visibility = body?.visibility;
  if (visibility !== undefined && visibility !== "workspace" && visibility !== "private") {
    reject(400, "invalid_visibility", "visibility must be workspace or private.");
  }
  const accounts = body?.connectionAccounts;
  if (accounts !== undefined && (!Array.isArray(accounts) || accounts.length > 0)) {
    reject(
      403,
      "connection_account_not_allowed",
      "The server chooses which connected accounts a chat uses.",
    );
  }
  const clientEventId = body?.clientEventId;
  if (clientEventId !== undefined) {
    if (typeof clientEventId !== "string" || !clientEventId) {
      reject(400, "invalid_client_event_id", "clientEventId must be a non-empty string.");
    }
    fields.clientEventId = clientEventId;
  }
  const revision = body?.expectedNewSessionDraftRevision;
  if (revision !== undefined) {
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
      reject(
        400,
        "invalid_draft_revision",
        "expectedNewSessionDraftRevision must be a non-negative integer.",
      );
    }
    fields.expectedNewSessionDraftRevision = revision;
  }
  return fields;
}

function withBrowserCreateChoices(
  created: CreateSessionRequest,
  input: SessionProxyCreateInput,
  browser: BrowserCreateFields = {},
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
    ...(created.clientEventId === undefined && browser.clientEventId
      ? { clientEventId: browser.clientEventId }
      : {}),
    // The person's zone unless the host chose one for this create.
    ...(created.timeZone === undefined && browser.timeZone && input.startMode !== "realtime"
      ? { timeZone: browser.timeZone }
      : {}),
  };
}

/**
 * Clear the new-chat draft the packaged app just sent. The API can clear it
 * during create only when the create request is that draft, and the
 * `createSession` hook decides the request, so the relay clears it after the
 * chat exists: the same text-free next draft, one revision on. A draft that
 * changed meanwhile is left alone, and a failure here never fails the create.
 */
async function clearSentNewSessionDraft(
  client: ProxyClient,
  workspaceId: string,
  revision: number,
): Promise<void> {
  try {
    const draft = await client.getNewSessionDraft(workspaceId);
    if (draft.revision !== revision) return;
    const {
      revision: _revision,
      selectionHistory: _history,
      updatedAt: _updatedAt,
      ...rest
    } = draft;
    await client.saveNewSessionDraft(workspaceId, {
      ...rest,
      text: "",
      resources: draft.resources.filter((resource) => resource.kind === "repository"),
      expectedRevision: revision,
    });
  } catch (error) {
    if (!(error instanceof OpenGeniApiError)) throw error;
  }
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

/** The browser's model context as hook input, when it sent some. */
function withBrowserContext(context: unknown): { browserContext?: string } {
  if (context === undefined) return {};
  if (typeof context !== "string") {
    reject(400, "invalid_model_context", "modelContext must be a string.");
  }
  return context.trim() ? { browserContext: context } : {};
}

/** The browser's context as the host decided: kept (absent), replaced (a string) or dropped (`null`). */
function decidedBrowserContext(
  extras: SessionProxyMessageExtras | undefined,
  sent: string | undefined,
): string | undefined {
  if (extras?.browserContext === undefined) return sent;
  return extras.browserContext ?? undefined;
}

function joinContext(...parts: Array<string | undefined>): string | undefined {
  const joined = parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join("\n\n");
  return joined || undefined;
}

/** The key Opengeni accepts an action once under: `clientEventId`, else `idempotencyKey`. */
function actionKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const body = value as { clientEventId?: unknown; idempotencyKey?: unknown };
  for (const key of [body.clientEventId, body.idempotencyKey]) {
    if (typeof key === "string" && key.trim()) return key.trim();
  }
  return undefined;
}

function keyed(key: string | undefined): { clientEventId?: string } {
  return key ? { clientEventId: key } : {};
}

/** Statuses after which the relay cannot tell whether Opengeni acted. */
function outcomeUnknown(status: number): boolean {
  return status === 408 || status >= 500;
}

/**
 * The relay always calls Opengeni with the server's own key, so an upstream
 * 401 means that key is wrong, expired or revoked, never that the end user is
 * signed out. Tell the developer once, in the server log, what to fix.
 */
function warnRejectedApiKey(error: OpenGeniApiError | Response, notice: { sent: boolean }): void {
  if (notice.sent) return;
  notice.sent = true;
  const correlationId =
    error instanceof Response
      ? error.headers.get("x-opengeni-correlation-id")
      : error.correlationId;
  console.warn(
    `[@opengeni/sdk] Opengeni rejected the session proxy's API key (401${
      correlationId ? `, reference ${correlationId}` : ""
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
