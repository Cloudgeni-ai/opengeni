import type { Observability } from "@opengeni/observability";
import type { TurnHeartbeatDetails } from "../../op-journal";
import { armTurnQuiescenceWatchdog } from "./quiescence";

export const TURN_FINALIZATION_STAGES = [
  "tool_writers",
  "credential_renewals",
  "credential_cleanup",
  "quiescence_receipt",
  "event_flush",
  "provider_leases",
  "workspace_capture",
  "tool_close",
  "sandbox_provisioning",
  "sandbox_rotation",
  "workspace_snapshot",
  "sandbox_release",
] as const;
export type TurnFinalizationStage = (typeof TURN_FINALIZATION_STAGES)[number];

const INFLIGHT = {
  name: "opengeni_turn_finalization_inflight",
  help: "Physical turn finalizers currently waiting in each cleanup stage.",
};
const SLOW_STAGES = {
  name: "opengeni_turn_finalization_slow_total",
  help: "Turn cleanup stages observed to exceed thirty seconds.",
};
const initialized = new WeakSet<Observability>();
function diagnose(operation: () => void): void {
  try {
    operation();
  } catch {
    // Diagnostics cannot own physical cleanup or containment.
  }
}

/** Starts only after agent execution ends. A cleanup-stage deadline never caps
 * agent work and never detaches a physical writer to manufacture quiescence. */
export function startTurnFinalizationMonitor(input: {
  observability: Observability;
  details: TurnHeartbeatDetails;
  heartbeat: (details: TurnHeartbeatDetails) => void;
  terminateWorker: () => void;
  timeoutMs?: number;
  slowAfterMs?: number;
}) {
  const { observability, details } = input;
  if (!initialized.has(observability)) {
    for (const stage of TURN_FINALIZATION_STAGES) {
      diagnose(() => observability.incrementGauge({ ...INFLIGHT, labels: { stage }, amount: 0 }));
      diagnose(() =>
        observability.incrementCounter({ ...SLOW_STAGES, labels: { stage }, amount: 0 }),
      );
    }
    initialized.add(observability);
  }
  let stage: TurnFinalizationStage | null = null;
  let disarm = () => {};
  let stopped = false;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  const leave = () => {
    disarm();
    clearTimeout(slowTimer);
    if (stage) {
      const previous = stage;
      diagnose(() =>
        observability.incrementGauge({ ...INFLIGHT, labels: { stage: previous }, amount: -1 }),
      );
    }
    stage = null;
  };
  return {
    enter(next: TurnFinalizationStage) {
      if (stopped || stage === next) return;
      leave();
      stage = next;
      details.phase = "finalizing";
      details.finalizationStage = next;
      details.finalizationStageStartedAt = new Date().toISOString();
      diagnose(() => observability.incrementGauge({ ...INFLIGHT, labels: { stage: next } }));
      disarm = armTurnQuiescenceWatchdog({
        enabled: true,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        onTimeout: () => {
          try {
            observability.error("turn finalization stalled; containing worker", {
              surface: "turn_finalization",
              outcome: "containment",
              reason: next,
            });
          } catch {
            // Diagnostic failure must never disable physical containment.
          }
        },
        terminateWorker: input.terminateWorker,
      });
      // Record the precursor while the process remains scrapeable. A counter
      // increment immediately before process.exit can never reach Prometheus.
      slowTimer = setTimeout(
        () =>
          diagnose(() => {
            observability.incrementCounter({ ...SLOW_STAGES, labels: { stage: next } });
            observability.warn("turn finalization is taking longer than expected", {
              surface: "turn_finalization",
              outcome: "slow",
              reason: next,
            });
          }),
        input.slowAfterMs ?? 30_000,
      );
      slowTimer.unref?.();
      diagnose(() => input.heartbeat(details));
    },
    stop() {
      if (stopped) return;
      stopped = true;
      leave();
    },
  };
}
