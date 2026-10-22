import type { Observability } from "@opengeni/observability";
import type { Context } from "hono";

/** Fixed stage names, so the histogram label stays bounded. */
export type InteractionRouteStage =
  | "auth"
  | "record"
  | "authorize"
  | "source_session"
  | "control"
  | "placement_cache"
  | "placement_resolve"
  | "placement_cache_write"
  | "placement"
  | "fences"
  | "passkey_pre"
  | "secrets"
  | "dispatch"
  | "passkey_post"
  // Browser creation (open) stages.
  | "replay_check"
  | "prepare"
  | "restore"
  | "network_route"
  | "holder"
  | "generation"
  | "provision"
  | "display"
  | "launch"
  | "activate";

export type InteractionRouteStageOperation = "act" | "observe" | "target_state" | "create";

/**
 * Wall-clock split of one browser control request into its sequential stages.
 * `mark(stage)` closes the stage that ran since the previous mark. Stages that
 * run more than once (a recovery retry) accumulate. The split is reported as a
 * content-free `Server-Timing` header and a per-stage histogram, so harness
 * overhead around the controller's own work stays visible.
 */
export class InteractionRouteStages {
  private last: number;
  private readonly durations = new Map<InteractionRouteStage, number>();

  constructor(
    readonly operation: InteractionRouteStageOperation,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.last = now();
  }

  mark(stage: InteractionRouteStage): void {
    const at = this.now();
    this.durations.set(stage, (this.durations.get(stage) ?? 0) + Math.max(0, at - this.last));
    this.last = at;
  }

  entries(): Array<[InteractionRouteStage, number]> {
    return [...this.durations.entries()];
  }

  serverTiming(): string {
    return this.entries()
      .map(([stage, ms]) => `browser-${stage.replaceAll("_", "-")};dur=${ms.toFixed(1)}`)
      .join(", ");
  }

  observe(observability: Observability | null | undefined): void {
    if (!observability) return;
    try {
      for (const [stage, ms] of this.entries()) {
        observability.observeHistogram({
          name: "opengeni_interaction_route_stage_seconds",
          help: "Browser control request wall time by sequential stage, around the controller's own work.",
          labels: { resource: "browser", operation: this.operation, stage },
          value: ms / 1_000,
        });
      }
    } catch {
      // Timing never changes a control request's outcome.
    }
  }
}

/** Attach the stage split to the response and the stage histogram. */
export function reportInteractionRouteStages(
  context: Context,
  observability: Observability | null | undefined,
  stages: InteractionRouteStages,
): void {
  const timing = stages.serverTiming();
  if (timing) context.header("server-timing", timing, { append: true });
  stages.observe(observability);
}
