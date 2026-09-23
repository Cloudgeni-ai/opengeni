import type { FetchLike } from "../client";
import type {
  CreateSessionRequest,
  HumanInputAnswer,
  SessionEvent,
  Session,
  SessionSkill,
  ToolRef,
} from "../types";

/** Which other sessions the agent may reach from this one. */
export type ChatAgentAccess = "session" | "user" | "workspace";

/**
 * Compatibility option for personal or workspace Knowledge. `false` initializes
 * Knowledge authoring to Off; authorized retrieval remains available. Omitted
 * follows user/workspace agent reach; session-only reach defaults to false.
 * Task notes cover temporary session-tree data.
 */
export type ChatMemory = "user" | "workspace" | false;

export type OpenGeniOptions = {
  /** Organization API key. Keep it on the server. */
  apiKey: string;
  /** The organization (account) id that owns every tenant workspace. */
  organizationId: string;
  /** Defaults to `https://app.opengeni.ai`. */
  baseUrl?: string | undefined;
  /**
   * The product identity used as the external-source label for tenant
   * workspaces and end users. Defaults to `"app"`.
   */
  source?: string | undefined;
  fetch?: FetchLike | undefined;
  /** Display name for a tenant workspace created on first use. Defaults to the tenant id. */
  workspaceName?: ((tenant: string) => string) | undefined;
};

export type ChatTarget =
  | { tenant: string; workspaceId?: undefined }
  | { workspaceId: string; tenant?: undefined };

export type ChatOptions = ChatTarget & {
  /** Host-authenticated external user; resolved through server-side asUser(). */
  user?: string | undefined;
  /** Stable conversation id; the session id is derived from it deterministically. */
  conversation: string;
  /** Prefer the actual OpenGeni session ID for shared or existing conversations.
   * The acting user is independent of the conversation's identity. */
  sessionId?: string | undefined;
  /** Defaults to `"session"`: the agent sees only this conversation. */
  agentAccess?: ChatAgentAccess | undefined;
  memory?: ChatMemory | undefined;
  model?: string | undefined;
  instructions?: string | undefined;
  skills?: SessionSkill[] | undefined;
  tools?: ToolRef[] | undefined;
  /**
   * Raw create-request passthrough (for example `sandboxBackend: "none"` for a
   * pure chat). Explicit values win over facade-derived ones; the message and
   * identity/idempotency fields always come from the facade.
   */
  create?: Partial<CreateSessionRequest> | undefined;
};

/** A turn stopped to wait for a human decision. */
export type ChatPending = {
  kind: "approval" | "human_input";
  /** The id to pass back through `chat.respond`. */
  requestId: string;
  /** Tool name for an approval; null for structured human input. */
  name: string | null;
  /** The producer's exact payload (approval entry or human-input request). */
  payload: unknown;
};

export type ChatReplyStatus = "completed" | "pending" | "cancelled";

export type ChatReply = {
  text: string;
  sessionId: string;
  workspaceId: string;
  turnId: string | null;
  /** `pending` waits on `chat.respond`; `cancelled` carries the text produced before the cancel. */
  status: ChatReplyStatus;
  /** Set when the turn is waiting on `chat.respond` instead of finished. */
  pending: ChatPending | null;
  /** Every event consumed while folding this turn. */
  events: SessionEvent[];
  toString(): string;
};

export type ChatToolStatus = "started" | "completed" | "failed";

export type ChatChunk =
  | { type: "text"; text: string }
  | {
      type: "tool";
      name: string;
      status: ChatToolStatus;
      callId?: string | undefined;
      input?: unknown;
    }
  | { type: "pending"; pending: ChatPending }
  | { type: "done"; reply: ChatReply };

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  sequence: number;
};

/** Durable text and unresolved decisions restored when a chat is reopened. */
export type ChatSnapshot = {
  messages: ChatMessage[];
  pending: ChatPending[];
  status: Session["status"] | null;
};

export type ChatRespondInput =
  | { requestId: string; decision: "approve" | "reject"; message?: string | undefined }
  | { requestId: string; answers: HumanInputAnswer[] }
  | { requestId: string; skip: true };

/** One earlier message from the product's own history, imported as context on the first send. */
export type ChatImportedMessage = { role: "user" | "assistant" | "system"; text: string };

export type ChatSendOptions = {
  signal?: AbortSignal | undefined;
  /** Supersede the current inference instead of queueing behind it. */
  steer?: boolean | undefined;
  /**
   * Earlier messages the product already holds, oldest first. Used only when
   * this send creates the session: they become the first message's
   * `modelContext` (skipped when `create.modelContext` was supplied), trimmed
   * from the oldest end to 30,000 characters. Never resent on later turns:
   * after the first message OpenGeni owns the history.
   */
  importedHistory?: ChatImportedMessage[] | undefined;
};

export type ChatSessionListOptions = ChatTarget & {
  user?: string | undefined;
  limit?: number | undefined;
};

/** A turn ended without a usable reply, or the facade was misused. */
export class OpenGeniChatError extends Error {
  readonly code: string;
  readonly event: SessionEvent | null;

  constructor(code: string, message: string, event: SessionEvent | null = null) {
    super(message);
    this.name = "OpenGeniChatError";
    this.code = code;
    this.event = event;
  }
}
