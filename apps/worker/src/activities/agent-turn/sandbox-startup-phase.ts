import type { Observability } from "@opengeni/observability";
import { measureTurnStartupPhase, recordTurnStartupPhase } from "../../observability-metrics";
import type { TurnEventPublisher } from "./model-usage";

export type SandboxStartupPhase =
  | "credential_resolution"
  | "credential_mint"
  | "credential_materialization"
  | "client_publication"
  | "client_readiness"
  | "credential_seed"
  | "credential_hooks"
  | "artifact_runtime";

/** Completion-only receipts use the existing startup timeline and histogram.
 * No pre-work event write; durations exclude telemetry delivery. Intervals may
 * overlap, so they must not be added to their enclosing startup phases. */
export function sandboxStartupPhaseObserver(input: {
  observability: Observability;
  provider: string;
  backend: string;
  publish?: TurnEventPublisher | null;
}) {
  const receipts: Parameters<TurnEventPublisher>[0] = [];
  const measure = async <T>(phase: SandboxStartupPhase, work: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    let outcome: "completed" | "failed" = "failed";
    try {
      const result = await work();
      outcome = "completed";
      return result;
    } finally {
      const durationMs = performance.now() - started;
      const occurredAt = new Date();
      try {
        recordTurnStartupPhase(input.observability, {
          phase,
          provider: input.provider,
          backend: input.backend,
          outcome,
          durationSeconds: durationMs / 1_000,
        });
      } catch {
        /* Telemetry cannot change the operation's result. */
      }
      receipts.push({
        type: `turn.startup.phase.${outcome}`,
        payload: { phase, durationMs },
        occurredAt,
      });
    }
  };
  return Object.assign(measure, {
    // Called by the owner after all observed operations settle, even on failure.
    // One append per preparation boundary, not one database round trip per hook.
    async flush(): Promise<void> {
      if (!input.publish || receipts.length === 0) return;
      const events = receipts.splice(0);
      try {
        await measureTurnStartupPhase(
          input.observability,
          {
            phase: "startup_phase_delivery",
            provider: input.provider,
            backend: input.backend,
          },
          () => input.publish!(events),
        );
      } catch {
        /* Preserve the original error, including cancellation provenance. */
      }
    },
  });
}

export async function withSandboxStartupPhases<T>(
  input: Parameters<typeof sandboxStartupPhaseObserver>[0],
  work: (measure: ReturnType<typeof sandboxStartupPhaseObserver>) => Promise<T>,
): Promise<T> {
  const measure = sandboxStartupPhaseObserver(input);
  try {
    return await work(measure);
  } finally {
    await measure.flush();
  }
}
