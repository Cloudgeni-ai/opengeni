import { OpenGeniEmbeddingClient as OpenGeniClient } from "../embedding-client";
import { OpenGeniApiError } from "../errors";
import { chatDefaults } from "../chats";
import {
  createWorkspaceIdResolver,
  type WorkspaceIdOptions,
  type WorkspaceIdTarget,
} from "../tenant-workspaces";
import type { SendMessageInput } from "../client";
import type { CreateSessionRequest, CreateSessionResponse, Session, SessionEvent } from "../types";
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

type BuildCreate = (text: string, send: ChatSendOptions) => CreateSessionRequest;
type SubmitCreate = (request: CreateSessionRequest) => Promise<CreateSessionResponse>;

type ChatInit = {
  workspaceId: string;
  sessionId: string;
  conversation: string | null;
  session: Session | null;
  buildCreate: BuildCreate | null;
  submitCreate?: SubmitCreate | undefined;
};

/** Upper bound on the `modelContext` built from `importedHistory`, header included. */
export const IMPORTED_HISTORY_MAX_CHARS = 30_000;
/** Server limit for one message's `modelContext`. */
const MODEL_CONTEXT_MAX_CHARS = 32_768;
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
    /** Sessions visible to the selected canonical user, or explicit service caller. */
    list: (options: ChatSessionListOptions) => Promise<Session[]>;
  };
  private readonly resolveWorkspaceId: ReturnType<typeof createWorkspaceIdResolver>;
  private implicitAgentAdmission: boolean | undefined;

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
    this.resolveWorkspaceId = createWorkspaceIdResolver(this.client, {
      organizationId: this.organizationId,
      source: this.source,
      workspaceName: options.workspaceName,
    });
    this.sessions = { list: (listOptions) => this.listSessions(listOptions) };
  }

  /** The workspace id for a tenant (created on first use, cached per instance) or an explicit id. */
  async workspaceId(
    target: ChatTarget | { tenant?: string | undefined; workspaceId?: string | undefined },
  ): Promise<string> {
    if (target.workspaceId) return target.workspaceId;
    const tenant = target.tenant;
    if (!tenant) throw new TypeError("Pass either tenant or workspaceId.");
    return await this.workspaceIdFor({ tenant }, { isolation: "tenant" });
  }

  /** Resolve a tenant workspace, or provision its separate user workspace and external member. */
  async workspaceIdFor(target: WorkspaceIdTarget, options: WorkspaceIdOptions): Promise<string> {
    return await this.resolveWorkspaceId(target, options);
  }

  /**
   * Address one conversation; the session is created lazily on the first send.
   * Identity selects authority, not the conversation address. Workspace
   * membership must be provisioned by the host's explicit onboarding flow.
   * Legacy user-namespaced conversations remain accessible by their session ID.
   */
  async chat(options: ChatOptions): Promise<Chat> {
    if (!options.conversation) throw new TypeError("chat() requires a conversation id.");
    if (options.chats === "private" && !options.user) {
      throw new OpenGeniChatError(
        "chats_requires_user",
        'chats: "private" requires an authenticated product user. Pass user or use chats: "shared".',
      );
    }
    const legacy = options.chats === undefined && !options.user;
    const defaults = legacy
      ? {
          visibility: "workspace" as const,
          agentAccess: "session" as const,
          memoryScope: "off" as const,
        }
      : chatDefaults(options.chats ?? "private");
    const explicitAgent = options.agent !== undefined || options.create?.agent !== undefined;
    const agentAccess = options.agentAccess ?? defaults.agentAccess;
    const memoryScope =
      options.memory === false
        ? "off"
        : (options.memory ??
          (legacy ? (agentAccess === "session" ? "off" : agentAccess) : defaults.memoryScope));
    if (memoryScope === "user" && !options.user) {
      throw new OpenGeniChatError(
        "memory_scope_requires_user",
        'memory: "user" requires an authenticated product user.',
      );
    }
    const client = options.user
      ? this.client.asUser(options.user, { source: this.source })
      : this.client;
    const workspaceId =
      options.chats === "isolated"
        ? await this.workspaceIdFor(
            { tenant: options.tenant ?? "", user: options.user },
            { isolation: "user" },
          )
        : await this.workspaceId(options);
    const sessionId = options.sessionId ?? (await chatSessionId(workspaceId, options.conversation));
    const session = await this.findSession(client, workspaceId, sessionId);
    const buildCreate: BuildCreate = (text, send) => {
      const { modelContext: createContext, ...create } = options.create ?? {};
      const messageContext = send.modelContext?.trim() || undefined;
      const reserved = messageContext ? messageContext.length + 2 : 0;
      const baseContext =
        createContext ??
        (send.importedHistory
          ? formatImportedHistory(
              send.importedHistory,
              Math.min(IMPORTED_HISTORY_MAX_CHARS, MODEL_CONTEXT_MAX_CHARS - reserved),
            )
          : undefined);
      const context = [baseContext, messageContext].filter(Boolean).join("\n\n") || undefined;
      return {
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        ...(options.skills !== undefined ? { skills: options.skills } : {}),
        ...(options.tools !== undefined ? { tools: options.tools } : {}),
        ...create,
        visibility: create.visibility ?? defaults.visibility,
        agentAccess: create.agentAccess ?? agentAccess,
        memoryScope: create.memoryScope ?? memoryScope,
        agent: {
          capabilities: create.agent?.capabilities ?? options.agent?.capabilities,
          identity:
            create.agent?.identity !== undefined ? create.agent.identity : options.agent?.identity,
          instructions: create.agent?.instructions ?? options.agent?.instructions,
          renderer: create.agent?.renderer ?? options.agent?.renderer ?? "markdown",
        },
        ...(context !== undefined ? { modelContext: context } : {}),
        ...messagePolicy(send),
        initialMessage: text,
        requestedSessionId: sessionId,
        idempotencyKey: chatIdempotencyKey(sessionId),
      };
    };
    return new Chat(client, {
      workspaceId,
      sessionId,
      conversation: options.conversation,
      session,
      buildCreate,
      submitCreate: (request) =>
        this.createChatSession(client, workspaceId, request, explicitAgent),
    });
  }

  private async createChatSession(
    client: OpenGeniClient,
    workspaceId: string,
    request: CreateSessionRequest,
    explicitAgent: boolean,
  ): Promise<CreateSessionResponse> {
    const { agent, ...withoutAgent } = request;
    const implicitAgent = !explicitAgent && this.implicitAgentAdmission !== false;
    try {
      return await client.createSession(
        workspaceId,
        explicitAgent || implicitAgent ? { ...withoutAgent, agent } : withoutAgent,
      );
    } catch (error) {
      if (
        !(error instanceof OpenGeniApiError) ||
        error.status !== 422 ||
        !(
          error.code === "agent_config_not_enabled" ||
          (error.code === "SESSION_CREATE_REJECTED" &&
            error.details?.code === "agent_config_not_enabled")
        ) ||
        error.outcomeUnknown
      )
        throw error;
      if (explicitAgent) {
        throw new OpenGeniApiError(error.status, error.body, {
          code: error.code,
          retryable: false,
          correlationId: error.correlationId,
          displayMessage:
            "Explicit agent configuration requires the deployment operator to set " +
            "OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED=true. The SDK has kept your agent settings unchanged.",
        });
      }
      if (!implicitAgent) throw error;
      // This exact 422 refused the create. Retry only the implicit renderer,
      // retaining the session/idempotency keys and every caller-owned field.
      this.implicitAgentAdmission = false;
      return await client.createSession(workspaceId, withoutAgent);
    }
  }

  /**
   * Address an existing session with native API authorization. The same shared
   * session can be opened by different authorized users. Pass null only for an
   * explicitly service-owned operation; the API still enforces service access.
   */
  async chatBySessionId(target: {
    workspaceId: string;
    sessionId: string;
    user: string | null;
  }): Promise<Chat> {
    const client =
      target.user !== null ? this.client.asUser(target.user, { source: this.source }) : this.client;
    const session = await client.getSession(target.workspaceId, target.sessionId);
    return new Chat(client, {
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
      conversation: null,
      session,
      buildCreate: null,
    });
  }

  private async findSession(
    client: OpenGeniClient,
    workspaceId: string,
    sessionId: string,
  ): Promise<Session | null> {
    try {
      return await client.getSession(workspaceId, sessionId);
    } catch (error) {
      if (error instanceof OpenGeniApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async listSessions(options: ChatSessionListOptions): Promise<Session[]> {
    const workspaceId =
      options.chats === "isolated"
        ? await this.workspaceIdFor(
            { tenant: options.tenant ?? "", user: options.user },
            { isolation: "user" },
          )
        : await this.workspaceId(options);
    const client = options.user
      ? this.client.asUser(options.user, { source: this.source })
      : this.client;
    return await client.requestJson<Session[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions`,
      undefined,
      {
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
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
  private readonly submitCreate: SubmitCreate;
  private pendingTurnId: string | null = null;

  constructor(
    private readonly client: OpenGeniClient,
    init: ChatInit,
  ) {
    this.workspaceId = init.workspaceId;
    this.sessionId = init.sessionId;
    this.conversation = init.conversation;
    this.session = init.session;
    this.buildCreate = init.buildCreate;
    this.submitCreate =
      init.submitCreate ?? ((request) => this.client.createSession(this.workspaceId, request));
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
      ? await this.submitSteer(text, options)
      : await this.submit(text, options);
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
    // Commentary is activity, not history. Like the live fold, a turn that
    // settles without an answer keeps only its latest commentary.
    let heldCommentary: { turnId: string | null; text: string; sequence: number } | null = null;
    const releaseHeldCommentary = (turnId: string | null) => {
      if (!heldCommentary || heldCommentary.turnId !== turnId) return;
      const held = heldCommentary;
      heldCommentary = null;
      const index = messages.findIndex((message) => message.sequence > held.sequence);
      const message: ChatMessage = { role: "assistant", text: held.text, sequence: held.sequence };
      if (index === -1) messages.push(message);
      else messages.splice(index, 0, message);
    };
    let after = 0;
    while (true) {
      const result = await this.client.listEventPage(this.workspaceId, this.sessionId, {
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
        const turnId = typeof event.turnId === "string" ? event.turnId : null;
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.cancelled" ||
          event.type === "session.requiresAction" ||
          event.type === "session.humanInput.requested"
        ) {
          releaseHeldCommentary(turnId);
        }
        const text = stringValue(asRecord(event.payload).text);
        if (!text) continue;
        if (event.type === "user.message") {
          messages.push({ role: "user", text, sequence: event.sequence });
          lastAssistantTurn = null;
          continue;
        }
        if (event.type !== "agent.message.completed") continue;
        if (asRecord(event.payload).phase === "commentary") {
          heldCommentary = { turnId, text, sequence: event.sequence };
          continue;
        }
        if (heldCommentary?.turnId === turnId) heldCommentary = null;
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

  private async submit(text: string, send: ChatSendOptions): Promise<SubmittedTurn> {
    if (!this.session) {
      if (!this.buildCreate) {
        throw new OpenGeniChatError("session_missing", "This session no longer exists.");
      }
      const created = await this.submitCreate(this.buildCreate(text, send));
      this.session = created;
      if (created.initialMessage === text) {
        return { after: 0, turnId: created.initialTurnId };
      }
      // The idempotent create replayed an earlier session; deliver this message too.
    }
    const event = await this.client.sendMessage(
      this.workspaceId,
      this.sessionId,
      messageInput(text, send),
    );
    return submittedFrom(event);
  }

  private async submitSteer(text: string, send: ChatSendOptions): Promise<SubmittedTurn> {
    if (!this.session) return await this.submit(text, send);
    const result = await this.client.steerMessage(
      this.workspaceId,
      this.sessionId,
      messageInput(text, send),
    );
    return { after: result.accepted.sequence, turnId: result.turn.id ?? null };
  }

  private async submitResponse(input: ChatRespondInput): Promise<SubmittedTurn> {
    let event: SessionEvent;
    if ("decision" in input) {
      event = await this.client.sendApprovalDecision(this.workspaceId, this.sessionId, {
        approvalId: input.requestId,
        decision: input.decision,
        ...(input.message !== undefined ? { message: input.message } : {}),
      });
    } else if ("answers" in input) {
      event = await this.client.submitHumanInputResponse(
        this.workspaceId,
        this.sessionId,
        input.requestId,
        { outcome: "answered", answers: input.answers },
      );
    } else {
      event = await this.client.submitHumanInputResponse(
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
    // Iterate by hand rather than with for-await: leaving a for-await loop
    // awaits the inner iterator's return(), which awaits the SSE body's
    // cancel(), and some fetch implementations (Next.js on Node) settle that
    // cancel only after the request is aborted. The finally below aborts
    // first and never waits on the inner unwinding.
    const events = this.client.streamEvents(this.workspaceId, this.sessionId, {
      after: submitted.after,
      signal: upstream.signal,
    });
    try {
      while (true) {
        const next = await events.next();
        if (next.done) break;
        const event = next.value;
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
      void Promise.resolve(events.return(undefined)).catch(() => undefined);
    }
  }
}

async function settle(chunks: AsyncIterable<ChatChunk>): Promise<ChatReply> {
  for await (const chunk of chunks) {
    if (chunk.type === "done") return chunk.reply;
  }
  throw new OpenGeniChatError("stream_ended", "The event stream ended before the turn settled.");
}

/** Per-message model policy fields that the send options carry. */
function messagePolicy(send: ChatSendOptions): Partial<SendMessageInput> {
  return {
    ...(send.model !== undefined ? { model: send.model } : {}),
    ...(send.reasoningEffort !== undefined ? { reasoningEffort: send.reasoningEffort } : {}),
    ...(send.latencyMode !== undefined ? { latencyMode: send.latencyMode } : {}),
  };
}

function messageInput(text: string, send: ChatSendOptions): SendMessageInput {
  const modelContext = send.modelContext?.trim();
  return { text, ...messagePolicy(send), ...(modelContext ? { modelContext } : {}) };
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
export function formatImportedHistory(
  messages: ChatImportedMessage[],
  maxChars: number = IMPORTED_HISTORY_MAX_CHARS,
): string | undefined {
  const lines = messages
    .filter(
      (message) =>
        IMPORTED_HISTORY_ROLES.has(message.role) &&
        typeof message.text === "string" &&
        message.text.trim().length > 0,
    )
    .map((message) => `${message.role}: ${message.text}`);
  if (lines.length === 0) return undefined;
  let budget = Math.min(maxChars, IMPORTED_HISTORY_MAX_CHARS) - IMPORTED_HISTORY_HEADER.length;
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
