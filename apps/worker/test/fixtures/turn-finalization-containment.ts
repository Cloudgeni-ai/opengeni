import type { Settings } from "@opengeni/config";
import { finalizeTurnAttempt, type TurnFinalizationDeps } from "../../src/activities/agent-turn/finalization";
import { createTurnContext } from "../../src/activities/agent-turn/turn-context";
import { TURN_QUIESCENCE_WATCHDOG_MS } from "../../src/activities/agent-turn/quiescence";

// Accelerate only the containment timer inside this isolated process. Use the
// real production finalizer and process.exit so the test cannot pass merely
// because the standalone watchdog works while successful turns never arm it.
const schedule = globalThis.setTimeout;
globalThis.setTimeout = ((callback, ms, ...args) =>
  schedule(callback, ms === TURN_QUIESCENCE_WATCHDOG_MS ? 25 : ms, ...args)) as typeof setTimeout;
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
  observability: {
    incrementCounter() {}, incrementGauge() {}, observeHistogram() {},
    error(message: string, attributes: unknown) { console.log(message, JSON.stringify(attributes)); },
    recordWorkerActivity() {},
  },
  leases: { codex: { held: false, stopHeartbeat() {} }, xai: { held: false, stopHeartbeat() {} } },
  machineOpObserver: { drainEvents: () => [] },
  stopLeaseHeartbeat() {},
  turnCompletionMemoryCollector: { schedule() {} },
  noteCancellationRequested() {},
} as unknown as TurnFinalizationDeps;
await finalizeTurnAttempt(deps);
held = false;
console.log("finalizer_returned", held);
await Bun.sleep(75);
clearInterval(keepAlive);
