import type { Observability } from "@opengeni/observability";
import {
  telemetryInterval,
  telemetryScheduler,
  type TelemetryScheduler,
} from "./telemetry-scheduler";

export type MaintenanceStartResult = "started" | "already_running";

export type MaintenanceTickOutcome =
  /** The work check proved there is nothing to do; no workflow was touched. */
  | "idle"
  | "started"
  | "already_running"
  /** The check failed; the workflow was started anyway (fail open). */
  | "probe_failed"
  | "start_failed"
  /** This process's previous tick for the job has not finished. */
  | "busy";

const TICK_OUTCOMES: readonly MaintenanceTickOutcome[] = [
  "idle",
  "started",
  "already_running",
  "probe_failed",
  "start_failed",
  "busy",
];

/**
 * One deployment-wide maintenance job driven by a worker-process cadence
 * instead of a Temporal Schedule. A Schedule starts a workflow execution on
 * every tick, so an idle deployment pays a history and visibility write per
 * tick for no work. A cadence instead asks a cheap read-only question first and
 * starts the job's workflow only when the answer may be yes.
 */
export type MaintenanceCadence = {
  /** Stable, low-cardinality metric label. */
  job: string;
  periodMs: number;
  /**
   * A superset of the job's claim predicate: `false` must prove that a run
   * would find nothing. It may perform the job's own idempotent repair
   * registration, but never claims or delivers work.
   */
  hasWork: () => Promise<boolean>;
  /** Start or nudge the job's single dispatcher workflow. */
  start: () => Promise<MaintenanceStartResult>;
};

export type MaintenanceCadences = {
  /** Run one tick for a job now; used by tests and by the cadence itself. */
  tick: (job: string) => Promise<MaintenanceTickOutcome>;
  close: () => Promise<void>;
};

export function startMaintenanceCadences(input: {
  cadences: readonly MaintenanceCadence[];
  observability: Observability;
  scheduler?: TelemetryScheduler;
  now?: () => number;
  /** Tests drive ticks explicitly. */
  autoStart?: boolean;
}): MaintenanceCadences {
  const scheduler = input.scheduler ?? telemetryScheduler;
  const now = input.now ?? Date.now;
  const jobs = new Map<string, MaintenanceCadence>();
  for (const cadence of input.cadences) {
    if (jobs.has(cadence.job)) throw new Error(`duplicate maintenance cadence ${cadence.job}`);
    telemetryInterval(cadence.periodMs, `${cadence.job} maintenance period`);
    jobs.set(cadence.job, cadence);
    for (const outcome of TICK_OUTCOMES) {
      input.observability.incrementCounter({
        name: "opengeni_maintenance_cadence_ticks_total",
        help: "Maintenance cadence ticks by job and outcome; idle ticks start no workflow.",
        labels: { job: cadence.job, outcome },
        amount: 0,
      });
    }
  }
  const inFlight = new Map<string, Promise<MaintenanceTickOutcome>>();
  const cancels: Array<() => void> = [];
  let stopped = false;

  const record = (job: string, outcome: MaintenanceTickOutcome) => {
    input.observability.incrementCounter({
      name: "opengeni_maintenance_cadence_ticks_total",
      help: "Maintenance cadence ticks by job and outcome; idle ticks start no workflow.",
      labels: { job, outcome },
    });
    if (outcome !== "busy" && outcome !== "start_failed") {
      input.observability.setGauge({
        name: "opengeni_maintenance_cadence_last_success_timestamp_seconds",
        help: "Unix time of the latest maintenance cadence tick that checked for work and, when needed, started its workflow.",
        labels: { job },
        value: now() / 1_000,
      });
    }
    return outcome;
  };

  const run = async (cadence: MaintenanceCadence): Promise<MaintenanceTickOutcome> => {
    let probeFailed = false;
    try {
      if (!(await cadence.hasWork())) return record(cadence.job, "idle");
    } catch (error) {
      // Fail open: a broken check must never silently stop maintenance. The
      // workflow's own claim remains the authority on what work exists.
      probeFailed = true;
      input.observability.warn("maintenance cadence work check failed; starting the job anyway", {
        job: cadence.job,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const started = await cadence.start();
      return record(cadence.job, probeFailed ? "probe_failed" : started);
    } catch (error) {
      input.observability.warn("maintenance cadence could not start its workflow", {
        job: cadence.job,
        error: error instanceof Error ? error.message : String(error),
      });
      return record(cadence.job, "start_failed");
    }
  };

  const tick = async (job: string): Promise<MaintenanceTickOutcome> => {
    const cadence = jobs.get(job);
    if (!cadence) throw new Error(`unknown maintenance cadence ${job}`);
    if (stopped) return "busy";
    if (inFlight.has(job)) return record(job, "busy");
    const running = run(cadence).finally(() => inFlight.delete(job));
    inFlight.set(job, running);
    return await running;
  };

  if (input.autoStart !== false) {
    for (const cadence of jobs.values()) {
      const fire = () => {
        void tick(cadence.job);
      };
      // Start immediately so a restart never delays due work by a full period.
      scheduler.defer(fire);
      cancels.push(scheduler.interval(fire, cadence.periodMs));
    }
  }

  return {
    tick,
    close: async () => {
      stopped = true;
      for (const cancel of cancels.splice(0)) cancel();
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
