import { OpenGeniClient } from "../client";
import { OpenGeniApiError } from "../errors";
import type { CreateSessionRequest, Session, SessionEvent } from "../types";
import { ChatPendingFold, ChatTurnFold, asRecord, stringValue } from "./fold";
import { chatIdempotencyKey, chatSessionId } from "./ids";
import {
  OpenGeniChatError,
  type ChatChunk,
  type ChatImportedMessage,
  type ChatMessage,
  type ChatOptions,
  type ChatReply,
  type ChatRespondInput,
  type ChatSendOptions,
  type ChatSessionListOptions,
  type ChatSnapshot,
  type ChatTarget,
  type OpenGeniOptions,
} from "./types";

export const DEFAULT_OPENGENI_BASE_URL = "https://app.opengeni.ai";
export const DEFAULT_CHAT_SOURCE = "app";

type SubmittedTurn = { after: number; turnId: string | null };

type BuildCreate = (
  text: string,
  importedHistory: ChatImportedMessage[] | undefined,
) => CreateSessionRequest;

type ChatInit = {
  workspaceId: string;
  sessionId: string;
  conversation: string | null;
  session: Session | null;
  buildCreate: BuildCreate | null;
};

/** Upper bound on the `modelContext` built from `importedHistory`, header included. */
export const IMPORTED_HISTORY_MAX_CHARS = 30_000;
const IMPORTED_HISTORY_HEADER = "Earlier conversation imported from the product, oldest first:";
const IMPORTED_HISTORY_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system"]);

/**
 * One-option-object entry point for products that already have a chat. Wraps
 * `OpenGeniClient` (exposed as `client`) with tenant workspaces, deterministic
 * conversation sessions, and text-first replies.
 */
export class OpenGeni {
  readonly client: OpenGeniClient;
  readonly organizationId: string;
  readonly source: string;
  readonly sessions: {
    /** Sessions of one tenant workspace, optionally filtered to one end user. */
    list: (options: ChatSessionListOptions) => Promise<Session[]>;
  };
  private readonly workspaceName: ((tenant: string) => string) | undefined;
  private readonly workspaces = new Map<string, Promise<string>>();

  constructor(options: OpenGeniOptions) {
    if (!options.apiKey) throw new TypeError("OpenGeni requires an apiKey.");
    if (!options.organizationId) throw new TypeError("OpenGeni requires an organizationId.");
    this.client = new OpenGeniClient({
      baseUrl: options.baseUrl ?? DEFAULT_OPENGENI_BASE_URL,
      apiKey: options.apiKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.organizationId = options.organizationId;
    this.source = options.source ?? DEFAULT_CHAT_SOURCE;
    this.workspaceName = options.workspaceName;
    this.sessions = { list: (listOptions) => this.listSessions(listOptions) };
  }

  /** The workspace id for a tenant (created on first use, cached per instance) or an explicit id. */
  async workspaceId(
    target: ChatTarget | { tenant?: string | undefined; workspaceId?: string | undefined },
  ): Promise<string> {
    if (target.workspaceId) return target.workspaceId;
    const tenant = target.tenant;
    if (!tenant) throw new TypeError("Pass either tenant or workspaceId.");
    let pending = this.workspaces.get(tenant);
    if (!pending) {
      pending = this.client
        .ensureWorkspace({
          accountId: this.organizationId,
          externalSource: this.source,
          externalId: tenant,
          name: this.workspaceName?.(tenant) ?? tenant,
        })
        .then((response) => response.workspace.id);
      pending.catch(() => {
        this.workspaces.delete(tenant);
      });
      this.workspaces.set(tenant, pending);
    }
    return await pending;
  }

  /**
   * Address one conversation; the session is created lazily on the first send.
   * With a `user`, the conversation id is namespaced to that user (a different
   * user with the same conversation id reaches a different session).
   */
  async chat(options: ChatOptions): Promise<Chat> {
    if (!options.conversation) throw new TypeError("chat() requires a conversation id.");
    const agentAccess = options.agentAccess ?? "session";
    const memoryScope =
      options.memory === false
        ? "off"
        : options.memory === undefined
          ? agentAccess
          : options.memory;
    if (memoryScope === "user" && !options.user) {
      throw new OpenGeniChatError(
        "memory_scope_requires_user",
        'memory: "user" requires a user label so memories can be scoped to that end user.',
      );
    }
    const endUser = options.user ? { source: this.source, id: options.user } : undefined;
    const workspaceId = await this.workspaceId(options);
    const sessionId = await chatSessionId(workspaceId, options.conversation, endUser);
    const session = await this.findSession(workspaceId, sessionId);
    // Reopening an existing session re-verifies the label it was created with.
    // The tuple derivation already makes a collision impossible; this keeps a
    // relabelled or hand-addressed session from crossing users regardless.
    if (session && endUser && !sameEndUser(session.endUser ?? null, endUser)) {
      throw new OpenGeniChatError(
        "conversation_not_authorized",
        "This conversation belongs to a different user.",
      );
    }
    const buildCreate: BuildCreate = (text, importedHistory) => {
      const context =
        options.create?.modelContext === undefined && importedHistory
          ? formatImportedHistory(importedHistory)
          : undefined;
      return {
        agentAccess,
        memoryScope,
        ...(endUser ? { endUser } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        ...(options.skills !== undefined ? { skills: options.skills } : {}),
        ...(options.tools !== undefined ? { tools: options.tools } : {}),
        ...(context !== undefined ? { modelContext: context } : {}),
        ...(options.create ?? {}),
        initialMessage: text,
        requestedSessionId: sessionId,
        idempotencyKey: chatIdempotencyKey(sessionId),
      };
    };
    return new Chat(this, {
      workspaceId,
      sessionId,
      conversation: options.conversation,
      session,
      buildCreate,
    });
  }

  /**
   * Address an existing session by id (for example decoded from a response id).
   * `user` is the end user the caller authenticated: the session must carry
   * exactly that end-user label (`{ source, id }`) or the call throws
   * `conversation_not_authorized`. Pass `null` only from trusted server code
   * that vouches for the session itself; a session reached with `null` is not
   * checked against any user.
   */
  async chatBySessionId(target: {
    workspaceId: string;
    sessionId: string;
    user: string | null;
  }): Promise<Chat> {
    const session = await this.client.getSession(target.workspaceId, target.sessionId);
    if (
      target.user !== null &&
      !sameEndUser(session.endUser ?? null, { source: this.source, id: target.user })
    ) {
      throw new OpenGeniChatError(
        "conversation_not_authorized",
        "This conversation belongs to a different user.",
      );
    }
    return new Chat(this, {
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
      conversation: null,
      session,
      buildCreate: null,
    });
  }

  private async findSession(workspaceId: string, sessionId: string): Promise<Session | null> {
    try {
      return await this.client.getSession(workspaceId, sessionId);
    } catch (error) {
      if (error instanceof OpenGeniApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async listSessions(options: ChatSessionListOptions): Promise<Session[]> {
    const workspaceId = await this.workspaceId(options);
    return await this.client.requestJson<Session[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions`,
      undefined,
      {
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
        ...(options.user ? { endUserSource: this.source, endUserId: options.user } : {}),
      },
    );
  }
}

/** One conversation bound to one deterministic session. */
export class Chat {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** The conversation id this chat was opened with; null when addressed by session id. */
  readonly conversation: string | null;
  private session: Session | null;
  private readonly buildCreate: BuildCreate | null;
  private pendingTurnId: string | null = null;

  constructor(
    private readonly og: OpenGeni,
    init: ChatInit,
  ) {
    this.workspaceId = init.workspaceId;
    this.sessionId = init.sessionId;
    this.conversation = init.conversation;
    this.session = init.session;
    this.buildCreate = init.buildCreate;
  }

  /** True once the session exists on the server. */
  get created(): boolean {
    return this.session !== null;
  }

  /** Send a message and wait for the agent's reply text. */
  async send(text: string, options: ChatSendOptions = {}): Promise<ChatReply> {
    return await settle(this.stream(text, options));
  }

  /** Send a message and observe the reply as it streams. Ends with a `done` chunk. */
  async *stream(
    text: string,
    options: ChatSendOptions = {},
  ): AsyncGenerator<ChatChunk, void, void> {
    const submitted = options.steer
      ? await this.submitSteer(text, options.importedHistory)
      : await this.submit(text, options.importedHistory);
    yield* this.streamTurn(submitted, options.signal);
  }

  /** Supersede the current inference with this message and wait for the reply. */
  async steer(text: string, options: Omit<ChatSendOptions, "steer"> = {}): Promise<ChatReply> {
    return await this.send(text, { ...options, steer: true });
  }

  /** Answer a pending approval or human-input request, then wait for the reply. */
  async respond(
    input: ChatRespondInput,
    options: Omit<ChatSendOptions, "steer"> = {},
  ): Promise<ChatReply> {
    return await settle(this.respondStream(input, options));
  }

  async *respondStream(
    input: ChatRespondInput,
    options: Omit<ChatSendOptions, "steer"> = {},
  ): AsyncGenerator<ChatChunk, void, void> {
    const submitted = await this.submitResponse(input);
    yield* this.streamTurn(submitted, options.signal);
  }

  /** User and assistant text in order, from the durable event log. */
  async history(): Promise<ChatMessage[]> {
    return (await this.snapshot()).messages;
  }

  /** Restore history and pending decisions from the complete ordered timeline. */
  async snapshot(): Promise<ChatSnapshot> {
    if (!this.session) return { messages: [], pending: [], status: null };
    const pending = new ChatPendingFold();
    let status = this.session.status;
    const messages: ChatMessage[] = [];
    let lastAssistantTurn: string | null = null;
    let after = 0;
    while (true) {
      const result = await this.og.client.listEventPage(this.workspaceId, this.sessionId, {
        after,
        includeTypes: [
          "user.message",
          "agent.message.completed",
          "session.requiresAction",
          "session.humanInput.requested",
          "user.approvalDecision",
          "user.humanInputResponse",
          "turn.completed",
          "turn.failed",
          "turn.cancelled",
          "session.status.changed",
        ],
      });
      for (const event of result.events) {
        pending.push(event);
        if (event.type === "session.status.changed") {
          const next = asRecord(event.payload).status;
          if (typeof next === "string") status = next as Session["status"];
        }
        const text = stringValue(asRecord(event.payload).text);
        if (!text) continue;
        if (event.type === "user.message") {
          messages.push({ role: "user", text, sequence: event.sequence });
          lastAssistantTurn = null;
          continue;
        }
        if (event.type !== "agent.message.completed") continue;
        const turnId = typeof event.turnId === "string" ? event.turnId : null;
        const last = messages.at(-1);
        if (
          last?.role === "assistant" &&
          turnId !== null &&
          turnId === lastAssistantTurn &&
          text.startsWith(last.text)
        ) {
          last.text = text;
          last.sequence = event.sequence;
          continue;
        }
        messages.push({ role: "assistant", text, sequence: event.sequence });
        lastAssistantTurn = turnId;
      }
      if (!result.hasMore || result.nextAfter === null || result.events.length === 0) break;
      if (result.nextAfter <= after) {
        throw new OpenGeniChatError(
          "history_cursor_stalled",
          "History pagination did not advance.",
        );
      }
      after = result.nextAfter;
    }
    return { messages, pending: pending.pending(), status };
  }

  private async submit(
    text: string,
    importedHistory: ChatImportedMessage[] | undefined,
  ): Promise<SubmittedTurn> {
    if (!this.session) {
      if (!this.buildCreate) {
        throw new OpenGeniChatError("session_missing", "This session no longer exists.");
      }
      const created = await this.og.client.createSession(
        this.workspaceId,
        this.buildCreate(text, importedHistory),
      );
      this.session = created;
      if (created.initialMessage === text) {
        return { after: 0, turnId: created.initialTurnId };
      }
      // The idempotent create replayed an earlier session; deliver this message too.
    }
    const event = await this.og.client.sendMessage(this.workspaceId, this.sessionId, text);
    return submittedFrom(event);
  }

  private async submitSteer(
    text: string,
    importedHistory: ChatImportedMessage[] | undefined,
  ): Promise<SubmittedTurn> {
    if (!this.session) return await this.submit(text, importedHistory);
    const result = await this.og.client.steerMessage(this.workspaceId, this.sessionId, text);
    return { after: result.accepted.sequence, turnId: result.turn.id ?? null };
  }

  private async submitResponse(input: ChatRespondInput): Promise<SubmittedTurn> {
    let event: SessionEvent;
    if ("decision" in input) {
      event = await this.og.client.sendApprovalDecision(this.workspaceId, this.sessionId, {
        approvalId: input.requestId,
        decision: input.decision,
        ...(input.message !== undefined ? { message: input.message } : {}),
      });
    } else if ("answers" in input) {
      event = await this.og.client.submitHumanInputResponse(
        this.workspaceId,
        this.sessionId,
        input.requestId,
        { outcome: "answered", answers: input.answers },
      );
    } else {
      event = await this.og.client.submitHumanInputResponse(
        this.workspaceId,
        this.sessionId,
        input.requestId,
        { outcome: "skipped" },
      );
    }
    const submitted = submittedFrom(event);
    return { ...submitted, turnId: submitted.turnId ?? this.pendingTurnId };
  }

  private async *streamTurn(
    submitted: SubmittedTurn,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ChatChunk, void, void> {
    const upstream = new AbortController();
    const onAbort = (): void => upstream.abort();
    if (signal?.aborted) upstream.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const fold = new ChatTurnFold(this.workspaceId, this.sessionId, submitted.turnId);
    try {
      for await (const event of this.og.client.streamEvents(this.workspaceId, this.sessionId, {
        after: submitted.after,
        signal: upstream.signal,
      })) {
        const step = fold.push(event);
        for (const chunk of step.chunks) yield chunk;
        // Resuming one member of a parallel interruption group re-emits the
        // waiting status, but existing human-input requests are not recreated.
        // Recover the remaining decision instead of waiting forever for new text.
        if (
          !step.terminal &&
          event.type === "session.status.changed" &&
          asRecord(event.payload).status === "requires_action" &&
          (event.turnId == null || fold.turnId === null || event.turnId === fold.turnId)
        ) {
          const pending = (await this.snapshot()).pending[0];
          if (pending) {
            fold.pending = pending;
            this.pendingTurnId = fold.turnId;
            yield { type: "pending", pending };
            yield { type: "done", reply: fold.reply("pending") };
            return;
          }
        }
        if (!step.terminal) continue;
        if (step.terminal === "failed") throw fold.failureError();
        this.pendingTurnId = step.terminal === "pending" ? fold.turnId : null;
        yield { type: "done", reply: fold.reply(step.terminal) };
        return;
      }
      if (signal?.aborted) throw abortError();
      throw new OpenGeniChatError(
        "stream_ended",
        "The event stream ended before the turn settled.",
      );
    } finally {
      signal?.removeEventListener("abort", onAbort);
      upstream.abort();
    }
  }
}

async function settle(chunks: AsyncIterable<ChatChunk>): Promise<ChatReply> {
  for await (const chunk of chunks) {
    if (chunk.type === "done") return chunk.reply;
  }
  throw new OpenGeniChatError("stream_ended", "The event stream ended before the turn settled.");
}

function submittedFrom(event: SessionEvent): SubmittedTurn {
  return {
    after: event.sequence,
    turnId: typeof event.turnId === "string" ? event.turnId : null,
  };
}

/**
 * `modelContext` for imported history: a header line plus one `role: text`
 * line per message, oldest first, trimmed from the oldest end to
 * {@link IMPORTED_HISTORY_MAX_CHARS}. Undefined when nothing usable remains.
 */
export function formatImportedHistory(messages: ChatImportedMessage[]): string | undefined {
  const lines = messages
    .filter(
      (message) =>
        IMPORTED_HISTORY_ROLES.has(message.role) &&
        typeof message.text === "string" &&
        message.text.trim().length > 0,
    )
    .map((message) => `${message.role}: ${message.text}`);
  if (lines.length === 0) return undefined;
  let budget = IMPORTED_HISTORY_MAX_CHARS - IMPORTED_HISTORY_HEADER.length;
  const kept: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = line.length + 1;
    if (cost <= budget) {
      kept.unshift(line);
      budget -= cost;
      continue;
    }
    // The newest line alone overflows: keep its tail so the most recent text survives.
    if (kept.length === 0 && budget > 1) kept.unshift(line.slice(line.length - (budget - 1)));
    break;
  }
  if (kept.length === 0) return undefined;
  return `${IMPORTED_HISTORY_HEADER}\n${kept.join("\n")}`;
}

function abortError(): Error {
  const error = new Error("The chat request was aborted.");
  error.name = "AbortError";
  return error;
}

function sameEndUser(
  left: { source: string; id: string } | null,
  right: { source: string; id: string },
): boolean {
  return left !== null && left.source === right.source && left.id === right.id;
}
