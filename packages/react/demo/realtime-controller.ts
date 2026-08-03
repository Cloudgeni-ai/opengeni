import type {
  SessionRealtimeController,
  SessionRealtimeControllerSnapshot,
  SessionRealtimeLifecycleProjection,
} from "@opengeni/sdk/realtime";
import type { SessionRealtimeControllerFactory } from "@opengeni/react/realtime";

const IDLE_SNAPSHOT: SessionRealtimeControllerSnapshot = {
  status: "idle",
  realtimeId: null,
  mode: null,
  bridge: null,
  microphone: "inactive",
  inputMuted: false,
  audibleOutput: "inactive",
  outputMuted: false,
  connectionGeneration: 0,
  reconnectAttempt: 0,
  diagnostic: null,
  error: null,
};

type DemoController = SessionRealtimeController & {
  reconnect(): void;
  fail(): void;
};

export type DeterministicRealtimeHarness = {
  factory: SessionRealtimeControllerFactory;
  reconnect(sessionId: string): void;
  fail(sessionId: string): void;
  snapshot(sessionId: string): SessionRealtimeControllerSnapshot | null;
};

/**
 * Deterministic transport-free controller used by the public demo and browser
 * screenshots. Production mode never passes this factory and therefore uses
 * the exact SDK WebRTC/Gateway controller selected by `@opengeni/sdk/realtime`.
 */
export function createDeterministicRealtimeHarness(): DeterministicRealtimeHarness {
  const controllers = new Map<string, DemoController>();
  return {
    factory(options) {
      const controller = createDemoController(options.sessionId, options.model);
      controllers.set(options.sessionId, controller);
      return controller;
    },
    reconnect(sessionId) {
      controllers.get(sessionId)?.reconnect();
    },
    fail(sessionId) {
      controllers.get(sessionId)?.fail();
    },
    snapshot(sessionId) {
      return controllers.get(sessionId)?.snapshot() ?? null;
    },
  };
}

function createDemoController(
  sessionId: string,
  model: NonNullable<SessionRealtimeControllerSnapshot["mode"]>["model"],
): DemoController {
  let current = IDLE_SNAPSHOT;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(snapshot: SessionRealtimeControllerSnapshot) => void>();

  const publish = (snapshot: SessionRealtimeControllerSnapshot) => {
    if (closed) return;
    current = snapshot;
    for (const listener of listeners) listener(snapshot);
  };
  const scheduleActive = (delayMs = 350) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => publish(activeSnapshot(sessionId, model, current)), delayMs);
  };
  const start = async () => {
    publish({
      ...IDLE_SNAPSHOT,
      status: "starting",
      microphone: "acquiring",
      audibleOutput: "pending",
      connectionGeneration: current.connectionGeneration + 1,
    });
    scheduleActive();
  };

  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    start,
    async observeLifecycle(_lifecycle: SessionRealtimeLifecycleProjection | null) {},
    async heartbeat() {},
    async flush() {},
    async ingestProviderEvent() {},
    async retry() {
      await start();
    },
    async retryAudibleOutput() {
      publish({ ...current, audibleOutput: "audible", diagnostic: null, error: null });
      return true;
    },
    setInputMuted(muted) {
      publish({ ...current, inputMuted: muted });
    },
    setOutputMuted(muted) {
      publish({ ...current, outputMuted: muted });
    },
    async stop() {
      publish({ ...current, status: "stopping" });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => publish(IDLE_SNAPSHOT), 70);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      listeners.clear();
    },
    reconnect() {
      if (current.mode?.state !== "active") return;
      publish({
        ...current,
        status: "recovering",
        reconnectAttempt: current.reconnectAttempt + 1,
        diagnostic: {
          kind: "reconnect",
          message: "The deterministic demo interrupted the transport.",
          recoverable: true,
          connectionGeneration: current.connectionGeneration,
          attempt: current.reconnectAttempt + 1,
        },
        error: "The deterministic demo interrupted the transport.",
      });
    },
    fail() {
      publish({
        ...IDLE_SNAPSHOT,
        status: "error",
        diagnostic: {
          kind: "negotiation_failure",
          message: "The deterministic demo rejected the connection.",
          recoverable: true,
          connectionGeneration: current.connectionGeneration,
          attempt: 1,
        },
        error: "The deterministic demo rejected the connection.",
      });
    },
  };
}

function activeSnapshot(
  sessionId: string,
  model: NonNullable<SessionRealtimeControllerSnapshot["mode"]>["model"],
  previous: SessionRealtimeControllerSnapshot,
): SessionRealtimeControllerSnapshot {
  return {
    status: "active",
    realtimeId: "33333333-3333-4333-8333-333333333333",
    mode: {
      id: "33333333-3333-4333-8333-333333333333",
      sessionId,
      operationId: "44444444-4444-4444-8444-444444444444",
      browserInstanceId: "55555555-5555-4555-8555-555555555555",
      model,
      state: "active",
      version: 1,
      connectionEpoch: 1,
      leaseExpiresAt: "2026-08-03T12:00:30.000Z",
      lastHeartbeatAt: "2026-08-03T12:00:00.000Z",
      startedAt: "2026-08-03T12:00:00.000Z",
      endedAt: null,
      endReason: null,
    },
    bridge: {
      connectionId: "66666666-6666-4666-8666-666666666666",
      connectionEpoch: 1,
      startupFenceSequence: 0,
      modeVersion: 1,
      speaking: false,
      activeDelegationId: null,
      lastError: null,
      ignoredEventCount: 0,
      lastIgnoredEventType: null,
      pendingInbound: 0,
      pendingInboundBytes: 0,
      clientAckThroughSequence: null,
      providerAckSequences: [],
      providerStarted: true,
      fatal: null,
    },
    microphone: "active",
    inputMuted: previous.inputMuted,
    audibleOutput: "audible",
    outputMuted: previous.outputMuted,
    connectionGeneration: Math.max(1, previous.connectionGeneration),
    reconnectAttempt: 0,
    diagnostic: null,
    error: null,
  };
}
