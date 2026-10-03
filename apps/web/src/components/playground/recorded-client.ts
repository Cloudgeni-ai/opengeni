import type { SessionClientLike } from "@opengeni/react";
import {
  OPENGENI_API_CONTRACT_REVISION,
  OpenGeniApiError,
  type ComposerDraft,
  type Session,
  type SessionEvent,
  type SessionQueueSnapshot,
  type SessionTurn,
} from "@opengeni/sdk";

import {
  QUESTION_TITLES,
  matchQuestion,
  replyBeats,
  replyTimeline,
  type QuestionId,
} from "./acme-script";

/* ----------------------------------------------------------------------------
   The playground's client: an in-memory stand-in for the browser
   `OpenGeniClient` that the real `OpenGeniProvider` and `OpenGeniChat` run
   on. It answers only what those components ask (the chat list, a session,
   its events and live stream, the composer's draft and send), and plays the
   recorded Acme answers into the stream. Nothing reaches a server, calls a
   model or creates anything in a workspace.
   -------------------------------------------------------------------------- */

export const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-00000000ac3e";

type Chat = {
  session: Session;
  events: SessionEvent[];
  waiters: Set<() => void>;
  timers: ReturnType<typeof setTimeout>[];
  turn: number;
};

export type RecordedAnswer = Readonly<{ sessionId: string; question: QuestionId }>;

export type RecordedClient = SessionClientLike & {
  /** Ask in an existing chat, as if typed into its composer. */
  ask: (sessionId: string, text: string) => void;
  /** Start a new chat with this first message; returns its id. */
  startChat: (text: string) => string;
  /** Whether an answer is playing in that chat. */
  isPlaying: (sessionId: string) => boolean;
  /** Stops every timer (on unmount). */
  dispose: () => void;
};

const control: SessionQueueSnapshot["effectiveControl"] = {
  state: "active",
  directState: "active",
  controlVersion: 1,
  controlEtag: "playground",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
} as unknown as SessionQueueSnapshot["effectiveControl"];

function minutesAgo(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  const tail = (Date.now().toString(16) + idCounter.toString(16).padStart(4, "0")).slice(-12);
  return `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
}

function blankDraft(): ComposerDraft {
  return {
    revision: 0,
    text: "",
    resources: [],
    model: "acme-agent",
    reasoningEffort: "low",
    latencyMode: "standard",
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: null,
  } as ComposerDraft;
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function createRecordedClient({
  onAnswered,
  onAsked,
}: {
  /** An answer finished playing. */
  onAnswered?: (answer: RecordedAnswer) => void;
  /** A question was asked (typed or picked). */
  onAsked?: (answer: RecordedAnswer) => void;
}): RecordedClient {
  const chats = new Map<string, Chat>();
  const now = Date.now();

  const wake = (chat: Chat) => {
    const waiters = [...chat.waiters];
    chat.waiters.clear();
    for (const waiter of waiters) waiter();
  };

  const append = (
    chat: Chat,
    type: string,
    payload: unknown,
    turnId: string | null,
    extra: Partial<SessionEvent> = {},
    occurredAt = new Date().toISOString(),
  ): SessionEvent => {
    const event = {
      id: `${chat.session.id}:${chat.events.length + 1}`,
      workspaceId: DEMO_WORKSPACE_ID,
      sessionId: chat.session.id,
      sequence: chat.events.length + 1,
      type,
      payload,
      occurredAt,
      turnId,
      ...extra,
    } as SessionEvent;
    chat.events.push(event);
    wake(chat);
    return event;
  };

  const turnRecord = (chat: Chat, turnId: string, prompt: string): SessionTurn =>
    ({
      id: turnId,
      workspaceId: DEMO_WORKSPACE_ID,
      sessionId: chat.session.id,
      triggerEventId: `${turnId}:trigger`,
      temporalWorkflowId: turnId,
      status: "queued",
      source: "user",
      position: 1,
      prompt,
      resources: [],
      tools: [],
      toolsProvided: false,
      model: "acme-agent",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
      sandboxOs: null,
      metadata: {},
      version: 1,
      executionGeneration: 0,
      activeAttemptId: null,
      lineage: {},
      initiator: { kind: "subject", subjectId: "user:playground" },
      initiatorContext: {},
      startedAt: null,
      finishedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }) as unknown as SessionTurn;

  /** Records the question and plays its answer; returns the question event. */
  const play = (chat: Chat, text: string, clientEventId?: string) => {
    for (const timer of chat.timers) clearTimeout(timer);
    chat.timers = [];
    chat.turn += 1;
    const turnId = `${chat.session.id}:turn-${chat.turn}`;
    const question = matchQuestion(text);
    const answer: RecordedAnswer = { sessionId: chat.session.id, question };
    const accepted = append(
      chat,
      "user.message",
      { text, ...(clientEventId ? { clientEventId } : {}) },
      null,
      clientEventId ? ({ clientEventId } as Partial<SessionEvent>) : {},
    );
    chat.session = {
      ...chat.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: new Date().toISOString(),
    } as Session;
    onAsked?.(answer);
    for (const timed of replyTimeline(replyBeats(question), turnId)) {
      chat.timers.push(
        setTimeout(() => {
          append(chat, timed.type, timed.payload, timed.turnId);
          if (timed.type === "turn.completed") {
            chat.session = { ...chat.session, status: "idle", activeTurnId: null } as Session;
            onAnswered?.(answer);
          }
        }, timed.afterMs),
      );
    }
    return { accepted, turn: turnRecord(chat, turnId, text) };
  };

  const create = (title: string, options: { minutesAgo?: number } = {}): Chat => {
    const at = minutesAgo(now, options.minutesAgo ?? 0);
    const id = newId();
    const chat: Chat = {
      session: {
        id,
        workspaceId: DEMO_WORKSPACE_ID,
        title,
        titleSource: "agent",
        status: "idle",
        initialMessage: title,
        visibility: "private",
        archivedAt: null,
        activeTurnId: null,
        effectiveControl: control,
        createdAt: at,
        updatedAt: at,
      } as unknown as Session,
      events: [],
      waiters: new Set(),
      timers: [],
      turn: 0,
    };
    chats.set(id, chat);
    return chat;
  };

  // Two earlier chats, so the chat list looks like a customer's real one.
  for (const [title, question, answer, minutes] of [
    [
      "Delivery address",
      "Can I change the delivery address on my next order?",
      "Yes. Open **Orders**, pick the order and choose **Change address**. It works until the order ships.",
      60 * 26,
    ],
    [
      "Pro plan perks",
      "What do I get with Pro?",
      "Pro includes free returns, priority support and early access to sales.",
      60 * 24 * 6,
    ],
  ] as const) {
    const chat = create(title, { minutesAgo: minutes });
    const at = minutesAgo(now, minutes);
    append(chat, "user.message", { text: question }, null, {}, at);
    append(chat, "turn.started", {}, "seed", {}, at);
    append(chat, "agent.message.completed", { phase: "final", text: answer }, "seed", {}, at);
    append(chat, "turn.completed", {}, "seed", {}, at);
  }

  const chatFor = (sessionId: string): Chat => {
    const chat = chats.get(sessionId);
    if (!chat) throw new Error("This chat isn't part of the demo.");
    return chat;
  };

  const startChat = (text: string): string => {
    const chat = create(QUESTION_TITLES[matchQuestion(text)]);
    play(chat, text);
    return chat.session.id;
  };

  const sendFromComposer = async (sessionId: string, request: Record<string, unknown>) => {
    const chat = chatFor(sessionId);
    const text = typeof request.text === "string" ? request.text : "";
    const clientEventId =
      typeof request.clientEventId === "string" ? request.clientEventId : undefined;
    return play(chat, text, clientEventId);
  };

  const target = {
    getClientConfig: async () =>
      ({
        deploymentRevision: "playground",
        apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
        defaultModel: "acme-agent",
        allowedModels: ["acme-agent"],
        models: [],
        defaultReasoningEffort: "low",
        allowedReasoningEfforts: ["low", "high"],
        modelSelection: false,
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 0 },
        productAccessMode: "local",
        auth: { mode: "none" },
        structuredServices: { fileSystem: false, git: false, terminalEvents: false },
      }) as never,
    getWorkspace: async () =>
      ({
        id: DEMO_WORKSPACE_ID,
        name: "Acme",
        kind: "shared",
        accountId: "00000000-0000-4000-8000-0000000ac3e0",
      }) as never,
    getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
    streamWorkspaceControlEvents: async function* (
      _workspaceId: string,
      options?: { signal?: AbortSignal },
    ) {
      await waitForAbort(options?.signal);
      yield* [];
    },
    streamWorkspaceInteractionRevisions: async function* (
      _workspaceId: string,
      options?: { signal?: AbortSignal },
    ) {
      await waitForAbort(options?.signal);
      yield* [];
    },
    streamWorkspaceLiveEvents: async function* (
      _workspaceId: string,
      options?: { signal?: AbortSignal },
    ) {
      await waitForAbort(options?.signal);
      yield* [];
    },
    listSessionPage: async () => {
      const sessions = [...chats.values()]
        .map((chat) => chat.session)
        .filter((session) => !(session as { archivedAt?: string | null }).archivedAt)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { pinned: [], sessions, nextCursor: null } as never;
    },
    getSession: async (_workspaceId: string, sessionId: string) =>
      chatFor(sessionId).session as never,
    createSession: async (_workspaceId: string, request: { initialMessage?: string }) => {
      const id = startChat(request.initialMessage ?? "");
      return { ...chatFor(id).session, initialTurnId: null } as never;
    },
    updateSession: async (_workspaceId: string, sessionId: string, update: { title?: string }) => {
      const chat = chatFor(sessionId);
      if (typeof update.title === "string")
        chat.session = { ...chat.session, title: update.title, titleSource: "user" } as Session;
      return chat.session as never;
    },
    updateSessionArchive: async (
      _workspaceId: string,
      sessionId: string,
      update: { archived?: boolean },
    ) => {
      const chat = chatFor(sessionId);
      chat.session = {
        ...chat.session,
        archivedAt: update.archived === false ? null : new Date().toISOString(),
      } as Session;
      return chat.session as never;
    },
    listEvents: async (
      _workspaceId: string,
      sessionId: string,
      options: { after?: number; before?: number; limit?: number; latest?: string } = {},
    ) => {
      let events = chats.get(sessionId)?.events ?? [];
      if (options.latest) return [] as SessionEvent[];
      if (typeof options.after === "number")
        events = events.filter((event) => event.sequence > options.after!);
      if (typeof options.before === "number")
        events = events.filter((event) => event.sequence < options.before!);
      if (typeof options.limit === "number" && events.length > options.limit)
        events =
          typeof options.before === "number"
            ? events.slice(-options.limit)
            : events.slice(0, options.limit);
      return events;
    },
    streamEvents: async function* (
      _workspaceId: string,
      sessionId: string,
      options: { after?: number; signal?: AbortSignal; onOpen?: () => void } = {},
    ): AsyncGenerator<SessionEvent, void, void> {
      const chat = chats.get(sessionId);
      if (!chat) return;
      options.onOpen?.();
      let next = options.after ?? 0;
      while (!options.signal?.aborted) {
        const fresh = chat.events.filter((event) => event.sequence > next);
        for (const event of fresh) {
          next = event.sequence;
          yield event;
        }
        await new Promise<void>((resolve) => {
          chat.waiters.add(resolve);
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
    getQueue: async () =>
      ({
        version: 1,
        effectiveControl: control,
        activePersonalConnections: [],
        stoppingPreviousAttempt: false,
        items: [],
        pendingInputs: [],
        pendingInputAttachment: null,
      }) as never,
    listHumanInputRequests: async () => [] as never,
    listSiteAuthConnections: async () => ({ revision: 0, connections: [] }) as never,
    getComposerDraft: async () => blankDraft(),
    saveComposerDraft: async (
      _workspaceId: string,
      _sessionId: string,
      request: Record<string, unknown>,
    ) =>
      ({
        ...blankDraft(),
        ...request,
        revision: Number(request.expectedRevision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      }) as never,
    submitComposerDraft: async (
      _workspaceId: string,
      sessionId: string,
      request: Record<string, unknown>,
    ) => {
      const { accepted, turn } = await sendFromComposer(sessionId, request);
      return {
        accepted,
        turn,
        draft: {
          ...blankDraft(),
          revision: Number(request.expectedDraftRevision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        },
        receipt: { kind: "accepted" },
        routing: "accepted_for_execution",
        interruptionCount: 0,
        replay: false,
      } as never;
    },
    sendMessage: async (
      _workspaceId: string,
      sessionId: string,
      request: Record<string, unknown>,
    ) => (await sendFromComposer(sessionId, request)).accepted as never,
    steerMessage: async (
      _workspaceId: string,
      sessionId: string,
      request: Record<string, unknown>,
    ) => ({ accepted: (await sendFromComposer(sessionId, request)).accepted }) as never,
    pauseSession: async () => undefined as never,
    resumeSession: async () => undefined as never,
    // The recording never queues work or asks for approval, but the session
    // hooks expect the whole conversation surface.
    moveQueueItem: async () => undefined as never,
    editQueueItem: async () => undefined as never,
    steerQueueItem: async () => undefined as never,
    deleteQueueItem: async () => undefined as never,
    sendApprovalDecision: async () => undefined as never,
    submitHumanInputResponse: async () => undefined as never,
    getSessionLineage: async () =>
      ({ ancestors: [], children: [], truncated: false, sessionHasSchedules: false }) as never,
    // No goals or attachments in the demo: a goal reads as "none", uploads fail.
    getGoal: async () => {
      throw new OpenGeniApiError(404, "{}", { code: "goal_not_found" });
    },
    updateGoal: async () => {
      throw new OpenGeniApiError(404, "{}", { code: "goal_not_found" });
    },
    deleteGoal: async () => undefined as never,
    uploadFile: async () => {
      throw new Error("Attachments aren't part of the demo.");
    },
    updateSessionMcpApprovalPolicy: async () => {
      throw new Error("This isn't part of the demo.");
    },
    ask: (sessionId: string, text: string) => {
      play(chatFor(sessionId), text);
    },
    startChat,
    isPlaying: (sessionId: string) => chats.get(sessionId)?.session.status === "running",
    dispose: () => {
      for (const chat of chats.values()) {
        for (const timer of chat.timers) clearTimeout(timer);
        chat.timers = [];
        wake(chat);
      }
    },
  };

  return target as unknown as RecordedClient;
}
