import type { Settings } from "@opengeni/config";
import type { Observability } from "@opengeni/observability";
import { finalizeTurnAttempt, type TurnFinalizationDeps } from "../../src/activities/agent-turn/finalization";
import { createTurnContext } from "../../src/activities/agent-turn/turn-context";
import { createWorkerCleanupContainment } from "../../src/worker-service-lifecycle";

// Exercise the production finalizer and host containment edge in an isolated
// process. A stalled finalizer requests drain before the host exit backstop;
// successful cleanup disarms containment without either request.
const settings = { workspaceCaptureEnabled: false } as Settings;
const context = createTurnContext({ settings, cancellationRequestedAt: null });
context.control.activityStatus = "idle";
context.control.turnMetricOutcome = "completed";
context.eventing.heartbeatDetails = { phase: "running", opAcks: { settled_op: "42" } };
const mode = process.argv[2];
const pending = new Promise<never>(() => {});
if (mode === "writers") {
  context.eventing.toolCancellationFenceRef.current = {
    cancel() {},
    waitForQuiescence: () => pending,
  };
}
if (mode === "snapshot") context.sandboxState.snapshotInFlight = pending;
let held = true;
const keepAlive = setInterval(() => {}, 1_000);
const observability = {
  incrementCounter() {}, incrementGauge() {}, observeHistogram() {},
  error(message: string, attributes: unknown) { console.log(message, JSON.stringify(attributes)); },
  recordWorkerActivity() {},
} as unknown as Observability;
const containment = createWorkerCleanupContainment({
  drain() {
    console.log("graceful_drain_requested");
    return true;
  },
  terminate() {
    console.log("host_exit_backstop");
    process.exit(1);
  },
  observability,
  timeoutMs: 50,
});
const deps = {
  ...context,
  input: { sessionId: "session-1", attemptId: "attempt-1" },
  settings,
  activityStarted: performance.now(),
  activitySpan: { end() {} },
  sandboxResumeController: new AbortController(),
  activityContext: {
    heartbeat(details: unknown) { console.log(JSON.stringify(details)); },
  },
  observability,
  requestWorkerDrain: () => containment.request(),
  turnFinalizationTimeoutMs: 25,
  leases: { codex: { held: false, stopHeartbeat() {} }, xai: { held: false, stopHeartbeat() {} } },
  machineOpObserver: { drainEvents: () => [] },
  stopLeaseHeartbeat() {},
  turnCompletionMemoryCollector: { schedule() {} },
  noteCancellationRequested() {},
} as unknown as TurnFinalizationDeps;
await finalizeTurnAttempt(deps);
containment.finished();
held = false;
console.log("finalizer_returned", held);
await Bun.sleep(75);
clearInterval(keepAlive);
