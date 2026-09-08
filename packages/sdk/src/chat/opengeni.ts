import { OpenGeniClient } from "../client";
import { OpenGeniApiError } from "../errors";
import type { CreateSessionRequest, Session, SessionEvent } from "../types";
import { ChatTurnFold, asRecord, stringValue } from "./fold";
import { chatIdempotencyKey, chatSessionId } from "./ids";
import {
  OpenGeniChatError,
  type ChatChunk,
  type ChatMessage,
  type ChatOptions,
  type ChatReply,
  type ChatRespondInput,
  type ChatSendOptions,
  type ChatSessionListOptions,
  type ChatTarget,
  type OpenGeniOptions,
} from "./types";

export const DEFAULT_OPENGENI_BASE_URL = "https://app.opengeni.ai";
export const DEFAULT_CHAT_SOURCE = "app";

type SubmittedTurn = { after: number; turnId: string | null };

type ChatInit = {
  workspaceId: string;
  sessionId: string;
  session: Session | null;
  buildCreate: ((text: string) => CreateSessionRequest) | null;
};

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

  /** Address one conversation; the session is created lazily on the first send. */
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
    const workspaceId = await this.workspaceId(options);
    const sessionId = await chatSessionId(workspaceId, options.conversation);
    const session = await this.findSession(workspaceId, sessionId);
    const endUser = options.user ? { source: this.source, id: options.user } : undefined;
    const buildCreate = (text: string): CreateSessionRequest => ({
      agentAccess,
      memoryScope,
      ...(endUser ? { endUser } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
      ...(options.skills !== undefined ? { skills: options.skills } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.create ?? {}),
      initialMessage: text,
      requestedSessionId: sessionId,
      idempotencyKey: chatIdempotencyKey(options.conversation),
    });
    return new Chat(this, { workspaceId, sessionId, session, buildCreate });
  }

  /** Address an existing session by id (for example decoded from a response id). */
  async chatBySessionId(target: { workspaceId: string; sessionId: string }): Promise<Chat> {
    const session = await this.client.getSession(target.workspaceId, target.sessionId);
    return new Chat(this, {
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
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
  private session: Session | null;
  private readonly buildCreate: ((text: string) => CreateSessionRequest) | null;
  private pendingTurnId: string | null = null;

  constructor(
    private readonly og: OpenGeni,
    init: ChatInit,
  ) {
    this.workspaceId = init.workspaceId;
    this.sessionId = init.sessionId;
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
    const submitted = options.steer ? await this.submitSteer(text) : await this.submit(text);
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
    if (!this.session) return [];
    const messages: ChatMessage[] = [];
    let lastAssistantTurn: string | null = null;
    let after = 0;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.og.client.listEventPage(this.workspaceId, this.sessionId, {
        after,
        includeTypes: ["user.message", "agent.message.completed"],
      });
      for (const event of result.events) {
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
      after = result.nextAfter;
    }
    return messages;
  }

  private async submit(text: string): Promise<SubmittedTurn> {
    if (!this.session) {
      if (!this.buildCreate) {
        throw new OpenGeniChatError("session_missing", "This session no longer exists.");
      }
      const created = await this.og.client.createSession(this.workspaceId, this.buildCreate(text));
      this.session = created;
      if (created.initialMessage === text) {
        return { after: 0, turnId: created.initialTurnId };
      }
      // The idempotent create replayed an earlier session; deliver this message too.
    }
    const event = await this.og.client.sendMessage(this.workspaceId, this.sessionId, text);
    return submittedFrom(event);
  }

  private async submitSteer(text: string): Promise<SubmittedTurn> {
    if (!this.session) return await this.submit(text);
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

function abortError(): Error {
  const error = new Error("The chat request was aborted.");
  error.name = "AbortError";
  return error;
}
