import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  FRAMEWORK_SESSION_MANIFEST_VERSION,
  FRAMEWORK_SESSION_STATE_MANIFEST,
  runFrameworkSessionScenario,
} from "./state-manifest";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { OpenGeniApiError } = await import("@opengeni/sdk");
const {
  buildTimeline,
  composeSendInput,
  groupTimeline,
  shouldSteerOnKey,
  shouldSubmitOnKey,
  useComposer,
  useTurnQueue,
} = await import("@opengeni/react/session");
const { QueueSurface } = await import("@opengeni/react/session-ui");

type AnyRecord = Record<string, any>;

const WORKSPACE_ID = "workspace-fixed";
const SESSION_ID = "session-fixed";
const FIXED_TIME = "2026-08-29T12:00:00.000Z";
const INITIAL_POLICY = {
  model: "scripted-model",
  reasoningEffort: "medium" as const,
  latencyMode: "standard" as const,
};

function completeSessionClient(overrides: AnyRecord = {}): AnyRecord {
  const emptyDraft = (): AnyRecord => ({
    revision: 0,
    text: "",
    annotations: [],
    resources: [],
    ...INITIAL_POLICY,
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: null,
  });
  const acceptedMessage = (sequence: number, input: AnyRecord | string): AnyRecord => {
    const typed = typeof input === "string" ? { text: input } : input;
    return {
      ...event(sequence, "user.message", { text: typed.text ?? "" }),
      clientEventId: typed.clientEventId ?? null,
    };
  };
  return {
    getSession: async (_workspaceId: string, sessionId: string) => ({
      id: sessionId,
      lastSequence: 0,
    }),
    listEvents: async () => [],
    streamEvents: async function* () {},
    getComposerDraft: async () => emptyDraft(),
    saveComposerDraft: async (
      _workspaceId: string,
      _sessionId: string,
      request: AnyRecord,
    ) => ({
      ...emptyDraft(),
      ...request,
      revision: Number(request.expectedRevision ?? 0) + 1,
      updatedAt: FIXED_TIME,
    }),
    submitComposerDraft: async (
      _workspaceId: string,
      _sessionId: string,
      request: AnyRecord,
    ) => {
      const accepted = acceptedMessage(90, request);
      const submittedTurn = turn("turn-default-submit", request.text ?? "");
      return {
        accepted,
        turn: submittedTurn,
        draft: {
          ...emptyDraft(),
          revision: Number(request.expectedDraftRevision ?? 0) + 1,
          updatedAt: FIXED_TIME,
        },
        receipt: receipt(
          "prompt.submit",
          request.clientEventId ?? "client-event-default",
          submittedTurn.id,
        ),
        routing:
          request.delivery === "steer" ? "accepted_for_steering" : "accepted_for_execution",
        interruptionCount: request.delivery === "steer" ? 1 : 0,
        replay: false,
      };
    },
    sendMessage: async (
      _workspaceId: string,
      _sessionId: string,
      input: AnyRecord | string,
    ) => acceptedMessage(91, input),
    steerMessage: async (
      _workspaceId: string,
      _sessionId: string,
      input: AnyRecord | string,
    ) => {
      const typed = typeof input === "string" ? { text: input } : input;
      const steeredTurn = turn("turn-default-steer", typed.text ?? "");
      return {
        accepted: acceptedMessage(92, typed),
        turn: steeredTurn,
        receipt: receipt(
          "prompt.steer",
          typed.clientEventId ?? "client-event-default",
          steeredTurn.id,
        ),
        routing: "accepted_for_steering",
        interruptionCount: 1,
        replay: false,
      };
    },
    getQueue: async () => queueSnapshot([], 0),
    moveQueueItem: async (
      _workspaceId: string,
      _sessionId: string,
      turnId: string,
      request: AnyRecord,
    ) => ({
      receipt: receipt("queue.move", request.clientEventId ?? "client-event-default", turnId),
      snapshot: queueSnapshot([], Number(request.expectedQueueVersion ?? 0) + 1),
    }),
    editQueueItem: async (
      _workspaceId: string,
      _sessionId: string,
      turnId: string,
      request: AnyRecord,
    ) => ({
      receipt: receipt("queue.edit", request.clientEventId ?? "client-event-default", turnId),
      snapshot: queueSnapshot([], 1),
      draft: emptyDraft(),
    }),
    steerQueueItem: async (
      _workspaceId: string,
      _sessionId: string,
      turnId: string,
      request: AnyRecord,
    ) => ({
      receipt: receipt("queue.steer", request.clientEventId ?? "client-event-default", turnId),
      snapshot: queueSnapshot([], 1),
    }),
    deleteQueueItem: async (
      _workspaceId: string,
      _sessionId: string,
      turnId: string,
      request: AnyRecord,
    ) => ({
      receipt: receipt("queue.delete", request.clientEventId ?? "client-event-default", turnId),
      snapshot: queueSnapshot([], 1),
    }),
    pauseSession: async () => event(93, "session.paused", {}),
    resumeSession: async () => event(94, "session.resumed", {}),
    sendApprovalDecision: async (
      _workspaceId: string,
      _sessionId: string,
      request: AnyRecord,
    ) => event(95, "approval.resolved", request),
    ...overrides,
  };
}

const normalizationHints = {
  generatedIds: [] as string[],
  timestamps: [] as string[],
  objectUrls: [] as string[],
  origins: { api: "http://127.0.0.1:43117" },
};
const finalResources = {
  readers: 0,
  streams: 0,
  listeners: 0,
  timers: 0,
  objectUrls: 0,
  owners: 0,
  controllers: 0,
};
const consoleErrors: string[] = [];
const originalConsoleError = console.error;
console.error = (...values: unknown[]) => {
  consoleErrors.push(values.map((value) => errorText(value)).join(" "));
};

try {
  const records = [
    pureHelperRecord(),
    manifestRecord(),
    timelineRecord(),
    await composerRapidRecord(),
    await composerPromotionRecord(),
    await composerSteerRecord(),
    await queueReplayRecord(),
    await domAccessibilityRecord(),
  ];
  process.stdout.write(
    `${JSON.stringify(
      jsonSafe({
        schemaVersion: 1,
        scenarioVersion: 1,
        runtime: {
          lane: process.env.OPENGENI_DIFFERENTIAL_LANE ?? "unknown",
          bun: Bun.version,
          node: process.version,
          react: React.version,
        },
        normalizationHints,
        manifestVersion: FRAMEWORK_SESSION_MANIFEST_VERSION,
        records,
        consoleErrors,
        finalResources,
      }),
      null,
      2,
    )}\n`,
  );
} finally {
  console.error = originalConsoleError;
  await GlobalRegistrator.unregister();
}

function pureHelperRecord(): AnyRecord {
  return {
    kind: "pure-helpers",
    composedInput: composeSendInput(
      "Ship the exact change",
      "client-event-fixed",
      () => ({
        resources: [{ kind: "file", fileId: "file-fixed" }],
        modelContext: "visible-context",
      }),
      {
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
    ),
    submitKeys: [
      shouldSubmitOnKey({ key: "Enter", shiftKey: false }),
      shouldSubmitOnKey({ key: "Enter", shiftKey: true }),
      shouldSubmitOnKey({
        key: "Enter",
        shiftKey: false,
        nativeEvent: { isComposing: true },
      }),
    ],
    steerKeys: [
      shouldSteerOnKey({ metaKey: true }),
      shouldSteerOnKey({ ctrlKey: true }),
      shouldSteerOnKey({}),
    ],
    cursorSeries: [1, 2, 3],
    optionalAnswerPreserved: { outcome: "answered", answers: [] },
  };
}

function manifestRecord(): AnyRecord {
  return {
    kind: "canonical-state-manifest",
    states: FRAMEWORK_SESSION_STATE_MANIFEST.map((row) => ({
      area: row.area,
      id: row.id,
      trace: runFrameworkSessionScenario(row),
    })),
  };
}

function timelineRecord(): AnyRecord {
  const events = [
    event(1, "user.message", { text: "Inspect the deployment" }, null),
    event(2, "turn.queued", { triggerEventId: "event-1", turnId: "turn-fixed" }),
    event(3, "turn.started", { triggerEventId: "event-1" }),
    event(4, "agent.message.delta", { text: "Checking " }),
    event(5, "agent.message.delta", { text: "the deployment." }),
    event(6, "agent.message.completed", { text: "Checking the deployment." }),
    event(7, "turn.completed", { outcome: "completed" }),
  ];
  const timeline = buildTimeline(events as never);
  return {
    kind: "timeline",
    inputEventTypes: events.map(({ type }) => type),
    items: timeline,
    groups: groupTimeline(timeline),
  };
}

async function composerRapidRecord(): Promise<AnyRecord> {
  sessionStorage.clear();
  const calls: AnyRecord[] = [];
  const callbacks: AnyRecord[] = [];
  const resolvers: Array<(event: AnyRecord) => void> = [];
  const client = completeSessionClient({
    sendMessage: async (_workspaceId: string, _sessionId: string, input: AnyRecord | string) => {
      const typed = typeof input === "string" ? { text: input } : input;
      rememberGeneratedId(typed.clientEventId);
      calls.push({ action: "sendMessage", input: typed });
      return await new Promise<AnyRecord>((resolve) => resolvers.push(resolve));
    },
  });
  const hook = await renderHook(() =>
    useComposer("session-composer-rapid", {
      client: client as never,
      workspaceId: WORKSPACE_ID,
      events: [],
      draftPersistence: "disabled",
      initialPolicy: INITIAL_POLICY,
      sendDestination: () => "chat",
      onSubmitted: (text: string, input: AnyRecord) => {
        callbacks.push({ phase: "submitted", text, clientEventId: input.clientEventId });
      },
      onSent: (text: string, input: AnyRecord) => {
        callbacks.push({ phase: "sent", text, clientEventId: input.clientEventId });
      },
    }),
  );

  const accepted: boolean[] = [];
  await actRun(async () => accepted.push(await hook.result.current.send("first now")));
  await actRun(async () => accepted.push(await hook.result.current.send("second later")));
  const pending = composerSnapshot(hook.result.current);
  rememberComposerTimestamps(pending);

  await actRun(() =>
    resolvers[0]?.({
      ...event(20, "user.message", { text: "first now" }),
      clientEventId: calls[0]?.input.clientEventId ?? null,
    }),
  );
  await waitFor(() => calls.length === 2, "second serialized Send");
  await actRun(() =>
    resolvers[1]?.({
      ...event(21, "user.message", { text: "second later" }),
      clientEventId: calls[1]?.input.clientEventId ?? null,
    }),
  );
  await flush();
  const settled = composerSnapshot(hook.result.current);
  rememberComposerTimestamps(settled);
  await hook.unmount();

  return {
    kind: "composer-rapid-send",
    accepted,
    pending,
    settled,
    calls,
    callbackOrder: callbacks,
  };
}

async function composerPromotionRecord(): Promise<AnyRecord> {
  sessionStorage.clear();
  const calls: AnyRecord[] = [];
  const client = completeSessionClient({
    sendMessage: async (_workspaceId: string, _sessionId: string, input: AnyRecord | string) => {
      const typed = typeof input === "string" ? { text: input } : input;
      rememberGeneratedId(typed.clientEventId);
      calls.push({ action: "sendMessage", input: typed });
      return {
        ...event(30, "user.message", {
          text: typed.text,
          delivery: "steer",
          routing: "accepted_for_steering",
        }),
        clientEventId: typed.clientEventId ?? null,
      };
    },
  });
  const hook = await renderHook(() =>
    useComposer("session-composer-promotion", {
      client: client as never,
      workspaceId: WORKSPACE_ID,
      events: [],
      draftPersistence: "disabled",
      initialPolicy: INITIAL_POLICY,
      sendDestination: () => "queue",
    }),
  );

  let accepted = false;
  await actRun(async () => {
    accepted = await hook.result.current.send("answer conversationally");
  });
  await flush();
  const snapshot = composerSnapshot(hook.result.current);
  rememberComposerTimestamps(snapshot);
  await hook.unmount();
  return { kind: "composer-routing-promotion", accepted, calls, snapshot };
}

async function composerSteerRecord(): Promise<AnyRecord> {
  sessionStorage.clear();
  const calls: AnyRecord[] = [];
  const client = completeSessionClient({
    steerMessage: async (_workspaceId: string, _sessionId: string, input: AnyRecord | string) => {
      const typed = typeof input === "string" ? { text: input } : input;
      rememberGeneratedId(typed.clientEventId);
      calls.push({ action: "steerMessage", input: typed });
      const acceptedEvent = {
        ...event(40, "user.message", {
          text: typed.text,
          delivery: "steer",
          routing: "accepted_for_steering",
        }),
        clientEventId: typed.clientEventId ?? null,
      };
      return {
        accepted: acceptedEvent,
        turn: turn("turn-steered", typed.text),
        receipt: receipt("prompt.steer", typed.clientEventId, "turn-steered"),
        routing: "accepted_for_steering",
        interruptionCount: 1,
        replay: false,
      };
    },
  });
  const hook = await renderHook(() =>
    useComposer("session-composer-steer", {
      client: client as never,
      workspaceId: WORKSPACE_ID,
      events: [],
      draftPersistence: "disabled",
      initialPolicy: INITIAL_POLICY,
    }),
  );

  let accepted = false;
  await actRun(async () => {
    accepted = await hook.result.current.steer("replace current direction");
  });
  await flush();
  const snapshot = composerSnapshot(hook.result.current);
  rememberComposerTimestamps(snapshot);
  await hook.unmount();
  return { kind: "composer-steer", accepted, calls, snapshot };
}

async function queueReplayRecord(): Promise<AnyRecord> {
  const calls: AnyRecord[] = [];
  const replayedKeys: string[] = [];
  const queuedTurn = turn("turn-queued", "remove this queued prompt");
  let current = queueSnapshot([queuedTurn], 3);
  let deleteAttempts = 0;
  const client = completeSessionClient({
    getQueue: async () => {
      calls.push({ action: "getQueue", version: current.version });
      return current;
    },
    deleteQueueItem: async (
      _workspaceId: string,
      _sessionId: string,
      turnId: string,
      request: AnyRecord,
    ) => {
      deleteAttempts += 1;
      rememberGeneratedId(request.clientEventId);
      replayedKeys.push(request.clientEventId);
      calls.push({ action: "deleteQueueItem", turnId, request });
      if (deleteAttempts === 1) {
        throw new OpenGeniApiError(504, "", {
          code: "upstream_unavailable",
          retryable: true,
          correlationId: "edge-504-safe",
          outcomeUnknown: true,
          displayMessage: "OpenGeni is temporarily unavailable — retry.",
        });
      }
      current = queueSnapshot([], 4);
      return {
        receipt: receipt("queue.delete", request.clientEventId, turnId),
        snapshot: current,
      };
    },
  });
  const hook = await renderHook(() =>
    useTurnQueue("session-queue-replay", {
      client: client as never,
      workspaceId: WORKSPACE_ID,
      events: [],
    }),
  );
  await waitFor(() => hook.result.current.loading === false, "queue initial read");
  const before = queueSnapshotRecord(hook.result.current);
  let removed = false;
  await actRun(async () => {
    removed = await hook.result.current.removeTurn(queuedTurn.id);
  });
  await flush();
  const after = queueSnapshotRecord(hook.result.current);
  await hook.unmount();

  return {
    kind: "queue-unknown-outcome-replay",
    removed,
    before,
    after,
    calls,
    replayedKeys,
  };
}

async function domAccessibilityRecord(): Promise<AnyRecord> {
  const queue = {
    snapshot: null,
    queue: [],
    pendingInputs: [],
    pendingInputAttachment: null,
    activePersonalConnections: [],
    effectiveControl: { ...activeControl(), state: "paused", directState: "paused" },
    stoppingPreviousAttempt: true,
    loading: false,
    error: new TypeError("Queue handoff unavailable"),
    refresh: async () => {},
    moveTurn: async () => false,
    editTurn: async () => null,
    steerTurn: async () => false,
    removeTurn: async () => false,
    pendingByTurn: {},
    mutationFor: () => null,
    mutating: false,
    mutationError: null,
    clearMutationError: () => {},
    acceptedSteers: [],
  };
  const rendered = await renderNode(
    React.createElement(QueueSurface, { queue: queue as never, readOnly: true }),
  );
  const retry = rendered.container.querySelector<HTMLButtonElement>("button");
  retry?.focus();
  const result = {
    kind: "react-dom-accessibility",
    html: rendered.container.innerHTML,
    roles: [...rendered.container.querySelectorAll<HTMLElement>("[role]")].map((node) => ({
      role: node.getAttribute("role"),
      ariaLive: node.getAttribute("aria-live"),
      ariaLabel: node.getAttribute("aria-label"),
      text: node.textContent?.replace(/\s+/gu, " ").trim() ?? "",
    })),
    focus: {
      tag: document.activeElement?.tagName.toLowerCase() ?? null,
      ariaLabel: document.activeElement?.getAttribute("aria-label") ?? null,
    },
    geometry: {
      width: rendered.container.getBoundingClientRect().width,
      height: rendered.container.getBoundingClientRect().height,
      overflowWidth: rendered.container.scrollWidth - rendered.container.clientWidth,
    },
  };
  await rendered.unmount();
  return result;
}

function composerSnapshot(composer: AnyRecord): AnyRecord {
  return jsonSafe({
    value: composer.value,
    annotations: composer.annotations ?? null,
    optimisticMessages: (composer.optimisticMessages ?? []).map((message: AnyRecord) => ({
      clientEventId: message.clientEventId,
      delivery: message.delivery,
      destination: message.destination,
      text: message.text,
      annotations: message.annotations,
      resources: message.resources,
      occurredAt: message.occurredAt,
      state: message.state,
      turnId: message.turnId ?? null,
      triggerEventId: message.triggerEventId ?? null,
      appliedQueueVersion: message.appliedQueueVersion ?? null,
      error: message.error ?? null,
      outcomeUnknown: message.outcomeUnknown ?? false,
    })),
    steering: composer.steering ?? null,
    stoppingAttempt: composer.stoppingAttempt ?? null,
    sending: composer.sending,
    canSend: composer.canSend,
    pausing: composer.pausing,
    resuming: composer.resuming,
    effectiveControl: composer.effectiveControl ?? null,
    draftRevision: composer.draftRevision,
    draftLoading: composer.draftLoading,
    draftSaving: composer.draftSaving,
    draftConflict: semanticError(composer.draftConflict),
    policy: composer.policy ?? null,
    draftPersistence: composer.draftPersistence ?? null,
    restoredResources: composer.restoredResources,
    error: semanticError(composer.error),
  });
}

function queueSnapshotRecord(queue: AnyRecord): AnyRecord {
  return jsonSafe({
    version: queue.snapshot?.version ?? null,
    queue: queue.queue.map((item: AnyRecord) => ({
      id: item.id,
      prompt: item.prompt,
      position: item.position,
      version: item.version,
    })),
    pendingInputs: queue.pendingInputs,
    pendingInputAttachment: queue.pendingInputAttachment,
    effectiveControl: queue.effectiveControl,
    stoppingPreviousAttempt: queue.stoppingPreviousAttempt,
    loading: queue.loading,
    error: semanticError(queue.error),
    pendingByTurn: queue.pendingByTurn,
    mutating: queue.mutating,
    mutationError: semanticError(queue.mutationError),
    acceptedSteers: queue.acceptedSteers ?? [],
  });
}

function rememberComposerTimestamps(snapshot: AnyRecord): void {
  for (const message of snapshot.optimisticMessages ?? []) {
    rememberTimestamp(message.occurredAt);
  }
}

function rememberGeneratedId(value: unknown): void {
  if (typeof value === "string" && !normalizationHints.generatedIds.includes(value)) {
    normalizationHints.generatedIds.push(value);
  }
}

function rememberTimestamp(value: unknown): void {
  if (typeof value === "string" && !normalizationHints.timestamps.includes(value)) {
    normalizationHints.timestamps.push(value);
  }
}

function event(
  sequence: number,
  type: string,
  payload: AnyRecord = {},
  turnId: string | null = "turn-fixed",
): AnyRecord {
  return {
    id: `event-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date(Date.parse(FIXED_TIME) + sequence * 1_000).toISOString(),
    turnId,
  };
}

function turn(id: string, prompt: string): AnyRecord {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    triggerEventId: `trigger-${id}`,
    temporalWorkflowId: `workflow-${id}`,
    status: "queued",
    source: "user",
    position: 1,
    prompt,
    annotations: [],
    resources: [],
    tools: [],
    toolsProvided: false,
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    sandboxOs: null,
    metadata: {},
    version: 2,
    executionGeneration: 1,
    activeAttemptId: null,
    lineage: {},
    initiator: { kind: "user", subjectId: "subject-fixed" },
    initiatorContext: {},
    personalConnections: [],
    personalResources: null,
    cancelledBy: null,
    cancelReason: null,
    startedAt: null,
    finishedAt: null,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

function activeControl(): AnyRecord {
  return {
    state: "active",
    controlVersion: 3,
    controlEtag: "control-3",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
    blockers: [],
    resumeOptions: [],
    override: null,
    settlement: null,
  };
}

function queueSnapshot(items: AnyRecord[], version: number): AnyRecord {
  return {
    version,
    effectiveControl: activeControl(),
    activePersonalConnections: [],
    stoppingPreviousAttempt: false,
    items,
    pendingInputs: [],
    pendingInputAttachment: null,
  };
}

function receipt(action: string, operationKey: string, turnId: string | null): AnyRecord {
  return {
    id: `receipt-${action}`,
    action,
    operationKey,
    targetSessionId: SESSION_ID,
    targetTurnId: turnId,
    appliedControlRevision: null,
    appliedQueueVersion: 4,
    appliedTurnVersion: 2,
    appliedDraftRevision: null,
    createdAt: FIXED_TIME,
  };
}

async function renderHook(useHook: () => any): Promise<{
  result: { current: any };
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const result = { current: undefined as any };
  function Harness() {
    result.current = useHook();
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return {
    result,
    unmount: async () => {
      await React.act(async () => root.unmount());
      await Promise.resolve();
      container.remove();
    },
  };
}

async function renderNode(node: any): Promise<{
  container: HTMLDivElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => root.render(node));
  return {
    container,
    unmount: async () => {
      await React.act(async () => root.unmount());
      container.remove();
    },
  };
}

async function actRun<T>(run: () => T | Promise<T>): Promise<T> {
  let result!: T;
  await React.act(async () => {
    result = await run();
  });
  return result;
}

async function flush(): Promise<void> {
  await React.act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, candidate) => {
      if (candidate instanceof Error) return semanticError(candidate);
      if (typeof candidate === "bigint") return candidate.toString();
      return candidate;
    }),
  ) as T;
}

function semanticError(value: unknown): AnyRecord | null {
  if (!(value instanceof Error)) return value ? { name: "Error", message: String(value) } : null;
  const error = value as Error & AnyRecord;
  return {
    name: error.name,
    message: error.message,
    status: error.status ?? null,
    code: error.code ?? null,
    retryable: error.retryable ?? null,
    outcomeUnknown: error.outcomeUnknown ?? null,
  };
}

function errorText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

declare global {
  // React uses this explicit opt-in for act() diagnostics outside a test runner.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}