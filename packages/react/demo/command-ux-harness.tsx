import {
  OpenGeniApiError,
  type ComposerDraft,
  type EffectiveSessionControl,
  type SaveComposerDraftRequest,
  type SessionCommandReceipt,
  type SessionControlResponse,
  type SessionEvent,
  type SessionTurn,
  type SubmitComposerDraftRequest,
  type SubmitComposerDraftResponse,
} from "@opengeni/sdk";
import {
  ChatComposer,
  SessionChrome,
  buildTimeline,
  useComposer,
  type ComposerState,
  type SessionClientLike,
  type UserMessageItem,
  type UseTurnQueueResult,
} from "@opengeni/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
let nextHarnessSession = 0;

type WorkMode = "idle" | "busy" | "paused";
type TransportMode =
  | "success"
  | "hold"
  | "unknown_once"
  | "unknown_always"
  | "admit_then_timeout"
  | "reject";
type ServerRouting = "accepted_for_execution" | "queued_for_execution";
type ProjectionMode = "immediate" | "deferred";
type ControlTransport = "success" | "hold" | "unknown_always";
type ComposerOptimisticMessage = NonNullable<ComposerState["optimisticMessages"]>[number];

type CallRecord = {
  kind: "send" | "steer" | "pause" | "resume" | "reconcile";
  key: string;
  expectedControlEtag: string | null;
  attempt: number;
};

type DeferredProjection = {
  events: SessionEvent[];
  turn: SessionTurn;
  queued: boolean;
};

type HarnessRuntime = {
  sessionId: string;
  transport: TransportMode;
  routing: ServerRouting;
  projection: ProjectionMode;
  controlTransport: ControlTransport;
  interruptionCount: number;
  sequence: number;
  queueVersion: number;
  control: EffectiveSessionControl;
  events: SessionEvent[];
  draft: ComposerDraft;
  attempts: Map<string, number>;
  admitted: Map<string, SubmitComposerDraftResponse>;
  latestTurn: SessionTurn | null;
  calls: CallRecord[];
  deferredProjection: DeferredProjection | null;
  pendingSubmit: {
    request: SubmitComposerDraftRequest;
    resolve: (response: SubmitComposerDraftResponse) => void;
    reject: (cause: unknown) => void;
  } | null;
  pendingControl: {
    action: "pause" | "resume";
    resolve: (response: SessionControlResponse) => void;
    reject: (cause: unknown) => void;
  } | null;
};

type HarnessApi = {
  snapshot: () => Record<string, unknown>;
  setMode: (mode: WorkMode) => void;
  setTransport: (mode: TransportMode) => void;
  setRouting: (routing: ServerRouting) => void;
  setProjection: (mode: ProjectionMode) => void;
  setControlTransport: (mode: ControlTransport) => void;
  release: () => void;
  publishProjection: () => void;
  startLatest: () => void;
  supersedeLatest: () => void;
  reset: () => void;
};

declare global {
  interface Window {
    __commandUx?: HarnessApi;
    __commandUxConsoleErrors?: string[];
  }
}

window.__commandUxConsoleErrors = [];
window.addEventListener("error", (event) => {
  window.__commandUxConsoleErrors?.push(event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  window.__commandUxConsoleErrors?.push(String(event.reason));
});

function initialDraft(): ComposerDraft {
  return {
    revision: 1,
    text: "",
    annotations: [],
    resources: [],
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    latencyMode: "standard",
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: new Date().toISOString(),
  };
}

function control(
  state: "active" | "paused",
  version: number,
  sessionId: string,
): EffectiveSessionControl {
  const blocker =
    state === "paused"
      ? {
          kind: "session" as const,
          sessionId,
          displayName: "This workstream",
          actor: "Operator",
          reason: "Paused by the operator",
          changedAt: new Date().toISOString(),
          revision: version,
        }
      : null;
  return {
    state,
    controlVersion: version,
    controlEtag: `control-${version}`,
    directState: state,
    primaryBlocker: blocker,
    additionalBlockerCount: 0,
    blockers: blocker ? [blocker] : [],
    resumeOptions:
      state === "paused"
        ? [
            {
              scope: "selected",
              targetId: sessionId,
              selectedStateAfter: "active",
              impactCopy: "Resume this workstream.",
            },
          ]
        : [],
    override: null,
    settlement: null,
  };
}

function runtime(): HarnessRuntime {
  nextHarnessSession += 1;
  const sessionId = `22222222-2222-4222-8222-${String(nextHarnessSession).padStart(12, "0")}`;
  return {
    sessionId,
    transport: "success",
    routing: "accepted_for_execution",
    projection: "immediate",
    controlTransport: "success",
    interruptionCount: 0,
    sequence: 0,
    queueVersion: 0,
    control: control("active", 1, sessionId),
    events: [],
    draft: initialDraft(),
    attempts: new Map(),
    admitted: new Map(),
    latestTurn: null,
    calls: [],
    deferredProjection: null,
    pendingSubmit: null,
    pendingControl: null,
  };
}

function mutationError(outcomeUnknown: boolean): OpenGeniApiError {
  return new OpenGeniApiError(outcomeUnknown ? 504 : 422, "", {
    code: outcomeUnknown ? "upstream_unavailable" : "invalid_request",
    retryable: outcomeUnknown,
    outcomeUnknown,
    displayMessage: outcomeUnknown
      ? "OpenGeni is temporarily unavailable — retry."
      : "The command was rejected.",
  });
}

function makeEvent(
  state: HarnessRuntime,
  type: string,
  payload: Record<string, unknown>,
  extras: Partial<SessionEvent> = {},
): SessionEvent {
  state.sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(state.sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sessionId: state.sessionId,
    sequence: state.sequence,
    type,
    payload,
    occurredAt: new Date().toISOString(),
    ...extras,
  };
}

function makeTurn(
  state: HarnessRuntime,
  request: SubmitComposerDraftRequest,
  accepted: SessionEvent,
): SessionTurn {
  const suffix = String(state.sequence).padStart(12, "0");
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
    workspaceId: WORKSPACE_ID,
    sessionId: state.sessionId,
    triggerEventId: accepted.id,
    temporalWorkflowId: `command-ux-${suffix}`,
    status: "queued",
    source: "user",
    position: 1,
    prompt: request.text,
    annotations: [],
    resources: request.resources,
    tools: [],
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    latencyMode: request.latencyMode,
    sandboxBackend: "modal",
    sandboxOs: null,
    metadata: { delivery: request.delivery },
    version: 1,
    executionGeneration: 0,
    activeAttemptId: null,
    lineage: {},
    initiator: { kind: "subject", subjectId: "user:harness" },
    initiatorContext: {},
    startedAt: null,
    finishedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function receipt(
  state: HarnessRuntime,
  turn: SessionTurn | null,
  action: string,
): SessionCommandReceipt {
  return {
    id: crypto.randomUUID(),
    action,
    operationKey: crypto.randomUUID(),
    targetSessionId: state.sessionId,
    targetTurnId: turn?.id ?? null,
    appliedControlRevision: state.control.controlVersion,
    appliedQueueVersion: state.queueVersion,
    appliedTurnVersion: turn?.version ?? null,
    appliedDraftRevision: state.draft.revision,
    createdAt: new Date().toISOString(),
  };
}

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return { ...draft, annotations: [...(draft.annotations ?? [])], resources: [...draft.resources] };
}

function Timeline({
  events,
  turns,
  optimistic,
  onRetry,
  onRemove,
}: {
  events: SessionEvent[];
  turns: SessionTurn[];
  optimistic: ComposerOptimisticMessage[];
  onRetry: (clientEventId: string) => void;
  onRemove: (clientEventId: string) => void;
}) {
  const queuedTriggers = new Set(turns.map((turn) => turn.triggerEventId));
  const optimisticQueuedIds = new Set(
    optimistic
      .filter((message) => message.destination === "queue")
      .map((message) => message.clientEventId),
  );
  const durable = buildTimeline(events).filter((item): item is UserMessageItem => {
    if (item.kind !== "user-message" || queuedTriggers.has(item.id)) return false;
    const clientEventId = item.reconciliationKey?.startsWith("user-message:")
      ? item.reconciliationKey.slice("user-message:".length)
      : null;
    return !clientEventId || !optimisticQueuedIds.has(clientEventId);
  });
  const durableClientIds = new Set(
    durable.flatMap((item) => {
      const key = item.reconciliationKey;
      return key?.startsWith("user-message:") ? [key.slice("user-message:".length)] : [];
    }),
  );
  const optimisticChat = optimistic.filter(
    (message) => message.destination === "chat" && !durableClientIds.has(message.clientEventId),
  );
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 sm:p-6"
      role="log"
      aria-label="Session timeline"
      data-command-timeline
    >
      {durable.length === 0 && optimisticChat.length === 0 ? (
        <p className="m-auto text-sm text-og-fg-subtle">
          Send a prompt to exercise the command path.
        </p>
      ) : null}
      {durable.map((item) => (
        <div
          key={item.id}
          className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-og-surface-2 px-3 py-2 text-sm text-og-fg"
          data-command-message="durable"
          data-client-event-id={item.reconciliationKey?.slice("user-message:".length)}
        >
          {item.text}
        </div>
      ))}
      {optimisticChat.map((message) => (
        <div
          key={message.clientEventId}
          className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-og-surface-2 px-3 py-2 text-sm text-og-fg"
          data-command-message="optimistic"
          data-delivery={message.delivery}
          data-delivery-state={message.state}
          data-client-event-id={message.clientEventId}
        >
          <p>{message.text}</p>
          <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-og-fg-muted">
            <span>
              {message.state === "failed"
                ? "Not confirmed"
                : message.state === "sending"
                  ? "Sending…"
                  : "Sent"}
            </span>
            {message.state === "failed" ? (
              <>
                <button
                  className="font-medium underline"
                  onClick={() => onRetry(message.clientEventId)}
                >
                  Retry
                </button>
                <button
                  className="font-medium underline"
                  onClick={() => onRemove(message.clientEventId)}
                >
                  Remove
                </button>
              </>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function CommandUxHarness() {
  const [initialRuntime] = useState(runtime);
  const runtimeRef = useRef<HarnessRuntime>(initialRuntime);
  const publishRef = useRef<(projection: DeferredProjection) => void>(() => {});
  const [sessionId, setSessionId] = useState(initialRuntime.sessionId);
  const [mode, setModeState] = useState<WorkMode>("idle");
  const [transport, setTransportState] = useState<TransportMode>("success");
  const [routing, setRoutingState] = useState<ServerRouting>("accepted_for_execution");
  const [projection, setProjectionState] = useState<ProjectionMode>("immediate");
  const [controlTransport, setControlTransportState] = useState<ControlTransport>("success");
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [baseControl, setBaseControl] = useState<EffectiveSessionControl>(initialRuntime.control);
  const [queueError, setQueueError] = useState<Error | null>(null);
  const [queueMutationError, setQueueMutationError] = useState<Error | null>(null);
  const [callsRevision, setCallsRevision] = useState(0);
  const [mountKey, setMountKey] = useState(0);

  const publishProjection = useCallback((next: DeferredProjection) => {
    const state = runtimeRef.current;
    state.events = [...state.events, ...next.events];
    state.deferredProjection = null;
    setEvents([...state.events]);
    if (next.queued) {
      setTurns((current) =>
        current.some((turn) => turn.id === next.turn.id) ? current : [...current, next.turn],
      );
    }
  }, []);
  publishRef.current = publishProjection;

  const recordCall = useCallback((call: CallRecord) => {
    runtimeRef.current.calls.push(call);
    setCallsRevision((value) => value + 1);
  }, []);

  const acceptSubmit = useCallback(
    (request: SubmitComposerDraftRequest, replay = false): SubmitComposerDraftResponse => {
      const state = runtimeRef.current;
      const accepted = makeEvent(
        state,
        "user.message",
        { text: request.text, delivery: request.delivery },
        { clientEventId: request.clientEventId },
      );
      const turn = makeTurn(state, request, accepted);
      const queued = makeEvent(
        state,
        "turn.queued",
        { triggerEventId: accepted.id, turnId: turn.id },
        { turnId: turn.id },
      );
      state.queueVersion += 1;
      state.latestTurn = turn;
      state.draft = {
        ...state.draft,
        revision: state.draft.revision + 1,
        text: "",
        annotations: [],
        resources: [],
        updatedAt: new Date().toISOString(),
      };
      const response: SubmitComposerDraftResponse = {
        accepted,
        turn,
        draft: cloneDraft(state.draft),
        receipt: receipt(state, turn, "prompt.submit"),
        routing: request.delivery === "steer" ? "accepted_for_steering" : state.routing,
        interruptionCount: request.delivery === "steer" ? state.interruptionCount : 0,
        replay,
      };
      state.admitted.set(request.clientEventId, response);
      const next: DeferredProjection = {
        events: [accepted, queued],
        turn,
        queued: request.delivery === "send" && state.routing === "queued_for_execution",
      };
      if (state.projection === "deferred") state.deferredProjection = next;
      else publishRef.current(next);
      return response;
    },
    [],
  );

  const runSubmit = useCallback(
    async (request: SubmitComposerDraftRequest): Promise<SubmitComposerDraftResponse> => {
      const state = runtimeRef.current;
      const previous = state.admitted.get(request.clientEventId);
      const attempt = (state.attempts.get(request.clientEventId) ?? 0) + 1;
      state.attempts.set(request.clientEventId, attempt);
      recordCall({
        kind: request.delivery,
        key: request.clientEventId,
        expectedControlEtag: request.controlEtag ?? null,
        attempt,
      });
      if (previous) return { ...previous, replay: true };
      if (state.transport === "hold") {
        return await new Promise<SubmitComposerDraftResponse>((resolve, reject) => {
          state.pendingSubmit = { request, resolve, reject };
        });
      }
      if (state.transport === "reject") throw mutationError(false);
      if (state.transport === "unknown_always") throw mutationError(true);
      if (state.transport === "unknown_once" && attempt === 1) throw mutationError(true);
      if (state.transport === "admit_then_timeout") {
        acceptSubmit(request);
        throw mutationError(true);
      }
      return acceptSubmit(request, attempt > 1);
    },
    [acceptSubmit, recordCall],
  );

  const runControl = useCallback(
    async (
      action: "pause" | "resume",
      options: { clientEventId?: string; expectedControlEtag?: string },
    ): Promise<SessionControlResponse> => {
      const state = runtimeRef.current;
      const key = options.clientEventId ?? crypto.randomUUID();
      const attempt = (state.attempts.get(key) ?? 0) + 1;
      state.attempts.set(key, attempt);
      recordCall({
        kind: action,
        key,
        expectedControlEtag: options.expectedControlEtag ?? null,
        attempt,
      });
      if (state.controlTransport === "unknown_always") throw mutationError(true);
      const settle = (): SessionControlResponse => {
        state.control = control(
          action === "pause" ? "paused" : "active",
          state.control.controlVersion + 1,
          state.sessionId,
        );
        return {
          receipt: receipt(state, null, `session.${action}d`),
          effectiveControl: state.control,
          interruptionCount: action === "pause" && mode === "busy" ? 1 : 0,
          wakeCount: action === "resume" ? 1 : 0,
          cancelledSessionCount: 0,
          cancelledTurnCount: 0,
        };
      };
      if (state.controlTransport === "hold") {
        return await new Promise<SessionControlResponse>((resolve, reject) => {
          state.pendingControl = { action, resolve, reject };
        });
      }
      return settle();
    },
    [mode, recordCall],
  );

  const client = useMemo(
    () =>
      ({
        getSession: async () => ({ id: runtimeRef.current.sessionId }),
        streamEvents: async function* () {},
        getComposerDraft: async () => cloneDraft(runtimeRef.current.draft),
        saveComposerDraft: async (
          _workspaceId: string,
          _sessionId: string,
          request: SaveComposerDraftRequest,
        ) => {
          const state = runtimeRef.current;
          state.draft = {
            ...state.draft,
            ...request,
            revision: state.draft.revision + 1,
            sourceTurnId: null,
            sourceTurnVersion: null,
            updatedAt: new Date().toISOString(),
          };
          return cloneDraft(state.draft);
        },
        submitComposerDraft: async (
          _workspaceId: string,
          _sessionId: string,
          request: SubmitComposerDraftRequest,
        ) => await runSubmit(request),
        listEvents: async () => {
          recordCall({
            kind: "reconcile",
            key: "event-ledger",
            expectedControlEtag: null,
            attempt: 1,
          });
          return [...runtimeRef.current.events];
        },
        sendMessage: async () => {
          throw new Error("The command harness exercises durable composer submission.");
        },
        steerMessage: async () => {
          throw new Error("The command harness exercises durable composer submission.");
        },
        getQueue: async () => ({
          version: runtimeRef.current.queueVersion,
          effectiveControl: runtimeRef.current.control,
          activePersonalConnections: [],
          stoppingPreviousAttempt: false,
          items: [],
          pendingInputs: [],
          pendingInputAttachment: null,
        }),
        moveQueueItem: async () => {
          throw new Error("Not used by this harness.");
        },
        editQueueItem: async () => {
          throw new Error("Not used by this harness.");
        },
        steerQueueItem: async () => {
          throw new Error("Not used by this harness.");
        },
        deleteQueueItem: async () => {
          throw new Error("Not used by this harness.");
        },
        sendApprovalDecision: async () => {
          throw new Error("Not used by this harness.");
        },
        pauseSession: async (
          _workspaceId: string,
          _sessionId: string,
          options: { clientEventId?: string; expectedControlEtag?: string } = {},
        ) => await runControl("pause", options),
        resumeSession: async (
          _workspaceId: string,
          _sessionId: string,
          options: { clientEventId?: string; expectedControlEtag?: string } = {},
        ) => await runControl("resume", options),
      }) as unknown as SessionClientLike,
    [recordCall, runControl, runSubmit],
  );

  const reset = useCallback(() => {
    const next = runtime();
    runtimeRef.current = next;
    sessionStorage.clear();
    setSessionId(next.sessionId);
    setModeState("idle");
    setTransportState("success");
    setRoutingState("accepted_for_execution");
    setProjectionState("immediate");
    setControlTransportState("success");
    setEvents([]);
    setTurns([]);
    setBaseControl(next.control);
    setQueueError(null);
    setQueueMutationError(null);
    setCallsRevision((value) => value + 1);
    setMountKey((value) => value + 1);
  }, []);

  const setMode = useCallback((next: WorkMode) => {
    const state = runtimeRef.current;
    const nextControl = control(
      next === "paused" ? "paused" : "active",
      state.control.controlVersion + 1,
      state.sessionId,
    );
    state.control = nextControl;
    state.interruptionCount = next === "busy" ? 1 : 0;
    setModeState(next);
    setBaseControl(nextControl);
  }, []);

  const setTransport = useCallback((next: TransportMode) => {
    runtimeRef.current.transport = next;
    setTransportState(next);
  }, []);
  const setRouting = useCallback((next: ServerRouting) => {
    runtimeRef.current.routing = next;
    setRoutingState(next);
  }, []);
  const setProjection = useCallback((next: ProjectionMode) => {
    runtimeRef.current.projection = next;
    setProjectionState(next);
  }, []);
  const setControlTransport = useCallback((next: ControlTransport) => {
    runtimeRef.current.controlTransport = next;
    setControlTransportState(next);
  }, []);

  const release = useCallback(() => {
    const state = runtimeRef.current;
    if (state.pendingSubmit) {
      const pending = state.pendingSubmit;
      state.pendingSubmit = null;
      pending.resolve(acceptSubmit(pending.request));
    }
    if (state.pendingControl) {
      const pending = state.pendingControl;
      state.pendingControl = null;
      state.control = control(
        pending.action === "pause" ? "paused" : "active",
        state.control.controlVersion + 1,
        state.sessionId,
      );
      pending.resolve({
        receipt: receipt(state, null, `session.${pending.action}d`),
        effectiveControl: state.control,
        interruptionCount: pending.action === "pause" && mode === "busy" ? 1 : 0,
        wakeCount: pending.action === "resume" ? 1 : 0,
        cancelledSessionCount: 0,
        cancelledTurnCount: 0,
      });
    }
  }, [acceptSubmit, mode]);

  const startLatest = useCallback(() => {
    const state = runtimeRef.current;
    const turn = state.latestTurn;
    if (!turn) return;
    const started = makeEvent(
      state,
      "turn.started",
      { triggerEventId: turn.triggerEventId },
      { turnId: turn.id },
    );
    state.events = [...state.events, started];
    setEvents([...state.events]);
    setTurns((current) => current.filter((item) => item.id !== turn.id));
    setModeState("busy");
  }, []);

  const supersedeLatest = useCallback(() => {
    const state = runtimeRef.current;
    const turn = state.latestTurn;
    if (!turn) return;
    const superseded = makeEvent(state, "turn.superseded", {}, { turnId: turn.id });
    state.events = [...state.events, superseded];
    setEvents([...state.events]);
    setTurns((current) => current.filter((item) => item.id !== turn.id));
  }, []);

  const publishDeferred = useCallback(() => {
    const deferred = runtimeRef.current.deferredProjection;
    if (deferred) publishProjection(deferred);
  }, [publishProjection]);

  const queueBase = useMemo<UseTurnQueueResult>(
    () => ({
      snapshot: {
        version: runtimeRef.current.queueVersion,
        effectiveControl: baseControl,
        activePersonalConnections: [],
        stoppingPreviousAttempt: false,
        items: turns,
        pendingInputs: [],
        pendingInputAttachment: null,
      },
      queue: turns,
      pendingInputs: [],
      pendingInputAttachment: null,
      activePersonalConnections: [],
      effectiveControl: baseControl,
      stoppingPreviousAttempt: false,
      loading: false,
      error: queueError,
      refresh: async () => setQueueError(null),
      moveTurn: async () => true,
      editTurn: async () => null,
      steerTurn: async (turnId: string) => {
        setTurns((current) => current.filter((turn) => turn.id !== turnId));
        return true;
      },
      removeTurn: async (turnId: string) => {
        if (queueMutationError) return false;
        setTurns((current) => current.filter((turn) => turn.id !== turnId));
        return true;
      },
      pendingByTurn: {},
      mutationFor: () => null,
      mutating: false,
      mutationError: queueMutationError,
      clearMutationError: () => setQueueMutationError(null),
    }),
    [baseControl, queueError, queueMutationError, turns],
  );

  const apiSnapshot = useCallback(
    () => ({
      mode,
      transport,
      routing,
      projection,
      controlTransport,
      calls: runtimeRef.current.calls,
      events: runtimeRef.current.events.map((event) => event.type),
      queueCount: turns.length,
      pendingSubmit: Boolean(runtimeRef.current.pendingSubmit),
      pendingControl: Boolean(runtimeRef.current.pendingControl),
      deferredProjection: Boolean(runtimeRef.current.deferredProjection),
      consoleErrors: window.__commandUxConsoleErrors ?? [],
    }),
    [controlTransport, mode, projection, routing, transport, turns.length],
  );

  window.__commandUx = {
    snapshot: apiSnapshot,
    setMode,
    setTransport,
    setRouting,
    setProjection,
    setControlTransport,
    release,
    publishProjection: publishDeferred,
    startLatest,
    supersedeLatest,
    reset,
  };

  return (
    <main
      className="og-root flex min-h-dvh bg-og-bg text-og-fg"
      data-command-ux-harness
      data-mode={mode}
      data-transport={transport}
      data-routing={routing}
      data-projection={projection}
      data-call-revision={callsRevision}
    >
      <aside className="hidden w-72 shrink-0 overflow-y-auto border-r border-og-border bg-og-surface-1 p-4 lg:block">
        <h1 className="text-sm font-semibold">Command UX verification</h1>
        <p className="mt-1 text-xs text-og-fg-muted">
          Deterministic production-component state machine.
        </p>
        <HarnessControls
          mode={mode}
          transport={transport}
          routing={routing}
          projection={projection}
          controlTransport={controlTransport}
          onMode={setMode}
          onTransport={setTransport}
          onRouting={setRouting}
          onProjection={setProjection}
          onControlTransport={setControlTransport}
          onRelease={release}
          onPublish={publishDeferred}
          onStart={startLatest}
          onSupersede={supersedeLatest}
          onQueueError={() => setQueueError(new Error("Queue could not be loaded."))}
          onMutationError={() => setQueueMutationError(new Error("Queue action not confirmed."))}
          onSyncControl={() => setBaseControl(runtimeRef.current.control)}
          onRemount={() => setMountKey((value) => value + 1)}
          onReset={reset}
        />
      </aside>
      <section className="mx-auto flex h-dvh min-w-0 w-full max-w-4xl flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-og-border px-4">
          <div>
            <h2 className="text-sm font-semibold">Implement Pelle Kai Profiles</h2>
            <p className="text-[11px] text-og-fg-muted">
              {mode} · {transport.replaceAll("_", " ")}
            </p>
          </div>
          <span className="rounded-full border border-og-border px-2 py-1 text-[11px] text-og-fg-muted">
            {mode === "busy" ? "Running" : mode === "paused" ? "Paused" : "Idle"}
          </span>
        </header>
        <CommandSession
          key={mountKey}
          client={client}
          sessionId={sessionId}
          mode={mode}
          events={events}
          queue={queueBase}
          baseControl={baseControl}
        />
      </section>
    </main>
  );
}

function CommandSession({
  client,
  sessionId,
  mode,
  events,
  queue,
  baseControl,
}: {
  client: SessionClientLike;
  sessionId: string;
  mode: WorkMode;
  events: SessionEvent[];
  queue: UseTurnQueueResult;
  baseControl: EffectiveSessionControl;
}) {
  const composer = useComposer(sessionId, {
    client,
    workspaceId: WORKSPACE_ID,
    events,
    effectiveControl: baseControl,
    sendDestination: () => (mode === "idle" ? "chat" : "queue"),
  });
  const effectiveControl = composer.effectiveControl ?? baseControl;
  const effectiveQueue = useMemo(
    () => ({
      ...queue,
      effectiveControl,
      snapshot: queue.snapshot ? { ...queue.snapshot, effectiveControl } : null,
    }),
    [effectiveControl, queue],
  );
  const optimistic = composer.optimisticMessages ?? [];
  return (
    <>
      <Timeline
        events={events}
        turns={queue.queue}
        optimistic={optimistic}
        onRetry={(id) => composer.retryOptimisticMessage?.(id)}
        onRemove={(id) => composer.removeOptimisticMessage?.(id)}
      />
      <div
        className="shrink-0 space-y-2 border-t border-og-border bg-og-bg px-3 pb-3 pt-2 sm:px-5 sm:pb-5"
        data-sending={composer.sending}
        data-pausing={composer.pausing}
        data-resuming={composer.resuming}
        data-optimistic-count={optimistic.length}
        data-queue-count={queue.queue.length}
        data-control-state={effectiveControl.state}
        data-control-etag={effectiveControl.controlEtag}
      >
        <SessionChrome queue={effectiveQueue} composer={composer} />
        <ChatComposer
          composer={composer}
          effectiveControl={effectiveControl}
          queuedAheadCount={queue.queue.length}
          autoFocus
        />
      </div>
    </>
  );
}

function HarnessControls({
  mode,
  transport,
  routing,
  projection,
  controlTransport,
  onMode,
  onTransport,
  onRouting,
  onProjection,
  onControlTransport,
  onRelease,
  onPublish,
  onStart,
  onSupersede,
  onQueueError,
  onMutationError,
  onSyncControl,
  onRemount,
  onReset,
}: {
  mode: WorkMode;
  transport: TransportMode;
  routing: ServerRouting;
  projection: ProjectionMode;
  controlTransport: ControlTransport;
  onMode: (value: WorkMode) => void;
  onTransport: (value: TransportMode) => void;
  onRouting: (value: ServerRouting) => void;
  onProjection: (value: ProjectionMode) => void;
  onControlTransport: (value: ControlTransport) => void;
  onRelease: () => void;
  onPublish: () => void;
  onStart: () => void;
  onSupersede: () => void;
  onQueueError: () => void;
  onMutationError: () => void;
  onSyncControl: () => void;
  onRemount: () => void;
  onReset: () => void;
}) {
  const selectClass = "mt-1 w-full rounded-md border border-og-border bg-og-bg px-2 py-1.5 text-xs";
  const buttonClass =
    "rounded-md border border-og-border bg-og-bg px-2 py-1.5 text-xs hover:bg-og-surface-2";
  return (
    <div className="mt-5 grid gap-4" data-harness-controls>
      <label className="text-xs text-og-fg-muted">
        User-visible state
        <select
          aria-label="User-visible state"
          className={selectClass}
          value={mode}
          onChange={(event) => onMode(event.target.value as WorkMode)}
        >
          <option value="idle">Idle</option>
          <option value="busy">Busy</option>
          <option value="paused">Paused</option>
        </select>
      </label>
      <label className="text-xs text-og-fg-muted">
        Transport
        <select
          aria-label="Transport"
          className={selectClass}
          value={transport}
          onChange={(event) => onTransport(event.target.value as TransportMode)}
        >
          <option value="success">Success</option>
          <option value="hold">Hold response</option>
          <option value="unknown_once">Timeout once</option>
          <option value="unknown_always">Timeout always</option>
          <option value="admit_then_timeout">Admit then timeout</option>
          <option value="reject">Definitive rejection</option>
        </select>
      </label>
      <label className="text-xs text-og-fg-muted">
        Server destination
        <select
          aria-label="Server destination"
          className={selectClass}
          value={routing}
          onChange={(event) => onRouting(event.target.value as ServerRouting)}
        >
          <option value="accepted_for_execution">Run now</option>
          <option value="queued_for_execution">Queue</option>
        </select>
      </label>
      <label className="text-xs text-og-fg-muted">
        Authoritative projection
        <select
          aria-label="Authoritative projection"
          className={selectClass}
          value={projection}
          onChange={(event) => onProjection(event.target.value as ProjectionMode)}
        >
          <option value="immediate">Immediate</option>
          <option value="deferred">Deferred</option>
        </select>
      </label>
      <label className="text-xs text-og-fg-muted">
        Pause/resume transport
        <select
          aria-label="Pause/resume transport"
          className={selectClass}
          value={controlTransport}
          onChange={(event) => onControlTransport(event.target.value as ControlTransport)}
        >
          <option value="success">Success</option>
          <option value="hold">Hold response</option>
          <option value="unknown_always">Timeout always</option>
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <button className={buttonClass} onClick={onRelease}>
          Release response
        </button>
        <button className={buttonClass} onClick={onPublish}>
          Publish projection
        </button>
        <button className={buttonClass} onClick={onStart}>
          Start latest
        </button>
        <button className={buttonClass} onClick={onSupersede}>
          Supersede latest
        </button>
        <button className={buttonClass} onClick={onQueueError}>
          Queue load error
        </button>
        <button className={buttonClass} onClick={onMutationError}>
          Queue action error
        </button>
        <button className={buttonClass} onClick={onSyncControl}>
          Sync control stream
        </button>
        <button className={buttonClass} onClick={onRemount}>
          Remount session
        </button>
      </div>
      <button className={buttonClass} onClick={onReset}>
        Reset harness
      </button>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
const hotData = import.meta.hot?.data as
  | { commandUxRoot?: ReturnType<typeof createRoot> }
  | undefined;
const reactRoot = hotData?.commandUxRoot ?? createRoot(root);
if (hotData) hotData.commandUxRoot = reactRoot;
reactRoot.render(<CommandUxHarness />);
