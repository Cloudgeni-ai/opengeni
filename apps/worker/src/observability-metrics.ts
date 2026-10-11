import { createHash } from "node:crypto";
import { errorCodeToJSON } from "@opengeni/agent-proto";
import {
  BundledSkillId,
  CREDIT_GRANT_CLASSES,
  SandboxBackend,
  type SessionEventType,
  type SkillReadKind,
  type SkillUseSource,
} from "@opengeni/contracts";
import {
  ACTIVE_USER_WINDOWS,
  type ActiveUserWindow,
  type CreditGrantTotals,
  type IdleInteractionInspection,
  type SessionEventAppendPhaseObservation,
} from "@opengeni/db";
import {
  natsSubscriptionTerminationCounter,
  type EventBusOptions,
  type EventLogger,
} from "@opengeni/events";
import type { Attributes, AttributeValue, Observability } from "@opengeni/observability";
import type { CompanyBrainContributionReceipt } from "./model-context-contributions";
import {
  createTelemetryClock,
  telemetryInterval,
  telemetryScheduler,
  type TelemetryScheduler,
} from "./telemetry-scheduler";
import {
  OPENSANDBOX_BATCHSANDBOX_PHASES,
  OPENSANDBOX_WORKLOAD_POD_CONDITIONS,
  type OpenSandboxKubernetesInventory,
} from "./opensandbox-kubernetes-inventory";
import {
  MCP_TOOL_METRIC_EXTERNAL_LABEL,
  SELFHOSTED_INFRASTRUCTURE_FAULT_CLASSES,
  WORKSPACE_CAPTURE_SKIP_REASONS,
  isMcpToolMetricLabel,
  modelUsageTokenCountOrNull,
  type RuntimeMetricsHooks,
  type SelfhostedOpObservation,
  type SelfhostedOpObserver,
  type ToolPreparationPhaseMeasurement,
} from "@opengeni/runtime";

export type TurnOutcome = "completed" | "failed" | "cancelled" | "recovering";
export type WorkerDeathRecoveryOutcome = "recovering" | "exhausted";
export type CreditMicrosKind = "usage" | "grant" | "topup" | "refund";
export type SandboxLeaseLiveness = "cold" | "warming" | "warm" | "draining";
export type CreditBalanceGauge = { accountId: string; balanceMicros: number };
export type TurnTaskQueueStats = {
  /** Temporal activity tasks ready for a turn worker to accept. */
  eligibleBacklog: number;
  oldestBacklogAgeSeconds: number;
  tasksAddRate: number;
  tasksDispatchRate: number;
};
export type TurnTaskQueueIdentity = { temporalNamespace: string; taskQueue: string };
export type TurnTaskQueueReadOptions = { signal: AbortSignal; deadline: number };

export function turnTaskQueueMetricLabels(identity: TurnTaskQueueIdentity) {
  return { temporal_namespace: identity.temporalNamespace, task_queue: identity.taskQueue };
}
export type SessionRecoveryBacklogStateSummary = {
  /** Every durable recovering session in this state with no active attempt. */
  count: number;
  /** Of those, sessions still inside the backoff their recovery request recorded. */
  scheduled: number;
  /** Seconds the single oldest candidate has been past its recovery due time; 0 when none is. */
  oldestOverdueSeconds: number;
};
export type SessionRecoveryBacklog = {
  quiescence_missing: SessionRecoveryBacklogStateSummary;
  projection_stale: SessionRecoveryBacklogStateSummary;
};
export type ContextCompactionPendingSummary = {
  pendingCount: number;
  oldestStartedAt: Date | null;
};

export type TemporalTurnTaskQueueStats = {
  approximateBacklogCount?: unknown;
  approximateBacklogAge?: {
    seconds?: unknown;
    nanos?: unknown;
  } | null;
  tasksAddRate?: unknown;
  tasksDispatchRate?: unknown;
} | null;

const turnTrackers = new WeakMap<Observability, TurnLifecycleMetrics>();
const modelRequestTrackers = new WeakMap<Observability, ModelRequestLifecycleMetrics>();
const creditBalanceGaugeAccounts = new WeakMap<Observability, Set<string>>();
const modelCacheCounterTotals = new WeakMap<Observability, Map<string, number>>();
const initializedContextCompactionMetrics = new WeakSet<Observability>();

// A worker process reaching one trillion tokens in one provider/cache counter is
// already far outside an ordinary scrape lifetime. Refuse further increments
// before floating-point precision can degrade; a restart resets both the
// process-local Prometheus registry and this guard together.
const MAX_MODEL_CACHE_COUNTER_TOTAL = 1_000_000_000_000;
const TURN_OUTCOMES: readonly TurnOutcome[] = ["completed", "failed", "cancelled", "recovering"];
const WORKER_DEATH_RECOVERY_OUTCOMES: readonly WorkerDeathRecoveryOutcome[] = [
  "recovering",
  "exhausted",
];
const WORKER_DEATH_TIMEOUT_TYPES = ["heartbeat", "schedule_to_start"] as const;
const CONTEXT_COMPACTION_TRIGGERS = ["auto", "operator", "proactive", "overflow"] as const;

export type ContextCompactionTrigger = (typeof CONTEXT_COMPACTION_TRIGGERS)[number];

const CONTEXT_COMPACTION_STARTS_METRIC = {
  name: "opengeni_context_compaction_starts_total",
  help: "Total durable context compaction starts, by trigger.",
} as const;
const CONTEXT_COMPACTIONS_METRIC = {
  name: "opengeni_context_compactions_total",
  help: "Total completed context compactions, by trigger.",
} as const;

/** Logger plus the closed-label subscription-termination counter for NATS connections. */
export function observabilityEventBusOptions(
  observability: Observability,
): Pick<EventBusOptions, "logger" | "onSubscriptionTerminated"> {
  return {
    logger: observabilityEventLogger(observability),
    onSubscriptionTerminated: natsSubscriptionTerminationCounter(observability),
  };
}

export function observabilityEventLogger(observability: Observability): EventLogger {
  return {
    debug: (message, attributes) => observability.debug(message, eventAttributes(attributes)),
    warn: (message, attributes) => observability.warn(message, eventAttributes(attributes)),
  };
}

function eventAttributes(attributes: Record<string, unknown> | undefined): Attributes | undefined {
  if (!attributes) {
    return undefined;
  }
  const projected: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    projected[key] = eventAttributeValue(value);
  }
  return projected;
}

function eventAttributeValue(value: unknown): AttributeValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function runtimeMetricsHooksForObservability(
  observability: Observability,
): RuntimeMetricsHooks {
  return {
    onModelCall: ({ provider, outcome, durationSeconds }) => {
      completedOperationSpan(observability, "worker.model.call", durationSeconds, {
        provider,
        outcome,
      });
      observability.incrementCounter({
        name: "opengeni_model_calls_total",
        help: "Total model calls by provider and outcome.",
        labels: { provider, outcome },
      });
      observability.observeHistogram({
        name: "opengeni_model_call_duration_seconds",
        help: "Model call duration in seconds by provider.",
        labels: { provider },
        value: durationSeconds,
      });
    },
    onSandboxCreate: ({ backend, imageSource, outcome, durationSeconds }) => {
      observability.incrementCounter({
        name: "opengeni_sandbox_creates_total",
        help: "Total sandbox create attempts by backend and outcome.",
        labels: { backend, image_source: imageSource, outcome },
      });
      observability.observeHistogram({
        name: "opengeni_sandbox_create_duration_seconds",
        help: "Sandbox create duration in seconds by backend.",
        labels: { backend, image_source: imageSource },
        value: durationSeconds,
      });
    },
    onSandboxWarmingTimeout: ({ backend, stage }) => {
      observability.incrementCounter({
        name: "opengeni_sandbox_warming_timeouts_total",
        help: "Total sandbox warming timeouts.",
        labels: { backend, stage },
      });
    },
    onSandboxReadinessReplacement: ({ backend, outcome }) => {
      observability.incrementCounter({
        name: "opengeni_sandbox_readiness_replacements_total",
        help: "Fresh sandbox command-readiness replacement decisions by backend and outcome.",
        labels: { backend, outcome },
      });
    },
    onSandboxProviderApiThrottle: ({ backend, operation }) => {
      observability.incrementCounter({
        name: "opengeni_sandbox_provider_api_throttles_total",
        help: "Total sandbox provider API throttle responses.",
        labels: { backend, operation },
      });
    },
    onSandboxTtlRenewal: ({ backend, outcome }) => {
      observability.incrementCounter({
        name: "opengeni_sandbox_ttl_renewals_total",
        help: "Total renewable sandbox provider TTL refresh attempts.",
        labels: { backend, outcome },
      });
    },
    onOpenSandboxSignedEndpoint: ({ outcome, port }) => {
      observability.incrementCounter({
        name: "opengeni_opensandbox_signed_endpoint_total",
        help: "OpenSandbox signed Channel B mint and host-fetch outcomes.",
        labels: { outcome, port: String(port) },
      });
    },
    onWorkspaceCapture: ({ backend, outcome, durationSeconds }) => {
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return;
      const safeBackend = SandboxBackend.safeParse(backend).success ? backend : "unknown";
      completedOperationSpan(observability, "worker.workspace_capture", durationSeconds, {
        backend: safeBackend,
        outcome,
      });
      observability.observeHistogram({
        name: "opengeni_workspace_capture_duration_seconds",
        help: "Physical warm workspace capture and publication duration, including late settlement after caller timeout.",
        labels: { backend: safeBackend, outcome },
        value: durationSeconds,
      });
    },
    onWorkspaceCaptureSkipped: ({ backend, reason }) => {
      const safeBackend = SandboxBackend.safeParse(backend).success ? backend : "unknown";
      const safeReason = (WORKSPACE_CAPTURE_SKIP_REASONS as readonly string[]).includes(reason)
        ? reason
        : "unknown";
      observability.incrementCounter({
        name: "opengeni_workspace_capture_skipped_total",
        help: "Due warm workspace checkpoints that could not start, by backend and fixed reason. Not-yet-due (throttled) and already-complete checkpoints are excluded.",
        labels: { backend: safeBackend, reason: safeReason },
      });
    },
    onWorkspaceArchiveObject: ({ outcome, backend }) => {
      observability.incrementCounter({
        name: "opengeni_workspace_archive_object_total",
        help: "Workspace archive object-storage put/delete outcomes.",
        labels: { outcome, backend },
      });
    },
    onMcpToolCall: ({ outcome, tool, durationSeconds }) => {
      // Re-check the closed label set at the export boundary so a caller can
      // never turn a raw user-defined tool name into a metric series.
      const safeTool = isMcpToolMetricLabel(tool) ? tool : MCP_TOOL_METRIC_EXTERNAL_LABEL;
      completedOperationSpan(observability, "worker.mcp.tool_call", durationSeconds, {
        outcome,
        tool: safeTool,
      });
      observability.incrementCounter({
        name: "opengeni_mcp_tool_calls_total",
        help: "Total physical MCP tool calls by bounded structural outcome and first-party tool (other tools are 'external').",
        labels: { outcome, tool: safeTool },
      });
      observability.observeHistogram({
        name: "opengeni_mcp_tool_call_duration_seconds",
        help: "MCP tool-call duration in seconds by bounded structural outcome and first-party tool (other tools are 'external').",
        labels: { outcome, tool: safeTool },
        value: durationSeconds,
      });
    },
    onMcpLifecycle: ({ phase, policy, outcome, durationSeconds }) => {
      observability.incrementCounter({
        name: "opengeni_mcp_lifecycle_operations_total",
        help: "Total physical MCP lifecycle operations by bounded phase, policy, and outcome.",
        labels: { phase, policy, outcome },
      });
      observability.observeHistogram({
        name: "opengeni_mcp_lifecycle_operation_duration_seconds",
        help: "MCP lifecycle operation duration in seconds by bounded phase, policy, and outcome.",
        labels: { phase, policy, outcome },
        value: durationSeconds,
      });
    },
    onSandboxOp: ({ backend, op, outcome, code, healed, durationSeconds, replyBytes }) => {
      observability.incrementCounter({
        name: "opengeni_machine_op_total",
        help: "Total Connected Machine control ops by op, outcome, and typed fault code.",
        labels: { backend, op, outcome, code: code ?? "" },
      });
      observability.observeHistogram({
        name: "opengeni_machine_op_duration_seconds",
        help: "Connected Machine control-op duration in seconds by op.",
        labels: { backend, op },
        value: durationSeconds,
      });
      // The healed-fault leading indicator: an op that only succeeded after a retry
      // (a blip/backpressure the transport absorbed). The doctrine: healed faults are
      // the leading indicator of the next unhealed one, so they are always recorded.
      if (healed) {
        observability.incrementCounter({
          name: "opengeni_machine_op_healed_total",
          help: "Connected Machine ops that succeeded only after ≥1 in-call retry.",
          labels: { backend, op },
        });
      }
      // The payload-wall indicator (bytes known only on a PAYLOAD_TOO_LARGE fault today).
      if (replyBytes !== undefined) {
        observability.observeHistogram({
          name: "opengeni_machine_op_reply_bytes",
          help: "Connected Machine control-op reply size in bytes (payload-wall indicator).",
          labels: { backend, op },
          value: replyBytes,
        });
      }
    },
  };
}

/**
 * Adapt the runtime's transport-agnostic `SelfhostedOpObserver` to the metrics
 * hooks: map a completed-op observation onto `onSandboxOp`, converting the wire
 * `ErrorCode` to its stable enum-name string (a bounded metric label) and the
 * duration to seconds. Wired into the selfhosted session build so every Connected
 * Machine control op meters.
 */
export function selfhostedOpObserverForMetrics(hooks: RuntimeMetricsHooks): SelfhostedOpObserver {
  return (o) => {
    hooks.onSandboxOp?.({
      backend: "selfhosted",
      op: o.op,
      outcome: o.outcome,
      healed: o.healed,
      retries: o.retries,
      durationSeconds: o.durationMs / 1000,
      ...(o.code !== undefined ? { code: errorCodeToJSON(o.code) } : {}),
      ...(o.replyBytes !== undefined ? { replyBytes: o.replyBytes } : {}),
    });
  };
}

/** A session-scoped `machine.op.*` event mapped from a completed-op observation. */
export type MachineOpSessionEvent = {
  type: "machine.op.failed" | "machine.op.recovered";
  payload: {
    op: string;
    faultClass: string;
    attempts: number;
    machineId?: string;
  };
};

/** Map an observation to a `machine.op.*` session event, or null if it is not
 *  eventable. `machine.op.failed` fires ONLY for infrastructure fault classes (a
 *  semantic miss the model asked about is an outcome, not an infra fault);
 *  `machine.op.recovered` fires for a healed op (success after ≥1 retry). */
export function machineOpSessionEventFor(o: SelfhostedOpObservation): MachineOpSessionEvent | null {
  if (
    o.outcome === "failed" &&
    o.faultClass &&
    SELFHOSTED_INFRASTRUCTURE_FAULT_CLASSES.has(o.faultClass)
  ) {
    return {
      type: "machine.op.failed",
      payload: {
        op: o.op,
        faultClass: o.faultClass,
        attempts: o.retries,
        ...(o.machineId ? { machineId: o.machineId } : {}),
      },
    };
  }
  if (o.outcome === "ok" && o.healed) {
    return {
      type: "machine.op.recovered",
      payload: {
        op: o.op,
        faultClass: o.faultClass ?? "unknown",
        attempts: o.retries,
        ...(o.machineId ? { machineId: o.machineId } : {}),
      },
    };
  }
  return null;
}

/**
 * The Connected Machine op observer wired into a turn: it meters EVERY op (the
 * metrics sink) and BUFFERS the eventable ops (infra failures + healed recoveries)
 * as `machine.op.*` session events. The observer is SYNC (fire-and-forget), so the
 * turn drains the buffer to durable session events at a known checkpoint (turn end),
 * awaited — never an unawaited DB write inside the Temporal activity.
 */
export function makeMachineOpObserver(hooks: RuntimeMetricsHooks): {
  observer: SelfhostedOpObserver;
  drainEvents(): MachineOpSessionEvent[];
} {
  const meter = selfhostedOpObserverForMetrics(hooks);
  const buffered: MachineOpSessionEvent[] = [];
  return {
    observer: (o) => {
      meter(o);
      const event = machineOpSessionEventFor(o);
      if (event) {
        buffered.push(event);
      }
    },
    drainEvents: () => buffered.splice(0, buffered.length),
  };
}

export function turnLifecycleMetricsFor(observability: Observability): TurnLifecycleMetrics {
  const existing = turnTrackers.get(observability);
  if (existing) {
    return existing;
  }
  const tracker = new TurnLifecycleMetrics(observability);
  turnTrackers.set(observability, tracker);
  return tracker;
}

export function initializeWorkerOutcomeMetrics(observability: Observability): void {
  for (const outcome of TURN_OUTCOMES) {
    observability.incrementCounter({
      name: "opengeni_turns_total",
      help: "Total agent turns by terminal outcome.",
      labels: { outcome },
      amount: 0,
    });
  }
  for (const outcome of WORKER_DEATH_RECOVERY_OUTCOMES) {
    for (const timeoutType of WORKER_DEATH_TIMEOUT_TYPES) {
      observability.incrementCounter({
        name: "opengeni_turn_worker_death_recoveries_total",
        help: "Total durable same-turn worker-death recovery outcomes.",
        labels: { outcome, timeout_type: timeoutType },
        amount: 0,
      });
    }
  }
}

/**
 * Publish every bounded compaction lifecycle series before the first event.
 * The zero counters make the closed trigger catalog explicit before a scrape.
 * Alerting uses the separate durable control-worker projection below; these
 * process-local counters are lifecycle-rate diagnostics only.
 */
export function initializeContextCompactionMetrics(observability: Observability): void {
  if (initializedContextCompactionMetrics.has(observability)) return;
  for (const trigger of CONTEXT_COMPACTION_TRIGGERS) {
    observability.incrementCounter({
      ...CONTEXT_COMPACTION_STARTS_METRIC,
      labels: { trigger },
      amount: 0,
    });
    observability.incrementCounter({
      ...CONTEXT_COMPACTIONS_METRIC,
      labels: { trigger },
      amount: 0,
    });
  }
  initializedContextCompactionMetrics.add(observability);
}

export function recordWorkerDeathRecoveryMetrics(
  observability: Observability,
  input: {
    outcome: WorkerDeathRecoveryOutcome;
    timeoutType: "HEARTBEAT" | "SCHEDULE_TO_START";
  },
): void {
  const turnOutcome: TurnOutcome = input.outcome === "exhausted" ? "failed" : "recovering";
  observability.incrementCounter({
    name: "opengeni_turn_worker_death_recoveries_total",
    help: "Total durable same-turn worker-death recovery outcomes.",
    labels: {
      outcome: input.outcome,
      timeout_type: input.timeoutType.toLowerCase(),
    },
  });
  // The turn process that owned this attempt is gone, so its process-local
  // lifecycle tracker cannot publish the outcome. Record it from the fenced
  // control activity only after the durable recovery transaction wins.
  observability.incrementCounter({
    name: "opengeni_turns_total",
    help: "Total agent turns by terminal outcome.",
    labels: { outcome: turnOutcome },
  });
}

export class TurnLifecycleMetrics {
  private readonly attempts = new Map<string, { startedAt: number; lastProgressAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly observability: Observability,
    private readonly options: {
      now?: () => number;
      refreshIntervalMs?: number;
    } = {},
  ) {}

  start(input: { attemptId: string }): void {
    const now = this.now();
    this.attempts.set(input.attemptId, { startedAt: now, lastProgressAt: now });
    this.ensureTimer();
    this.refreshGauges();
  }

  progress(input: { attemptId: string }): void {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) return;
    attempt.lastProgressAt = this.now();
  }

  finish(input: {
    attemptId: string;
    outcome: TurnOutcome | null;
    durationSeconds?: number;
  }): void {
    const startedAt = this.attempts.get(input.attemptId)?.startedAt;
    if (startedAt !== undefined) {
      this.attempts.delete(input.attemptId);
    }
    if (input.outcome) {
      const observedDuration =
        input.durationSeconds ??
        (startedAt === undefined ? 0 : Math.max(0, (this.now() - startedAt) / 1000));
      this.observability.incrementCounter({
        name: "opengeni_turns_total",
        help: "Total agent turns by terminal outcome.",
        labels: { outcome: input.outcome },
      });
      this.observability.observeHistogram({
        name: "opengeni_turn_duration_seconds",
        help: "Agent turn duration in seconds by terminal outcome.",
        labels: { outcome: input.outcome },
        value: observedDuration,
      });
    }
    this.refreshGauges();
    if (this.attempts.size === 0) {
      this.stopTimer();
    }
  }

  refreshGauges(): void {
    this.observability.setGauge({
      name: "opengeni_turns_inflight",
      help: "Current number of in-flight physical agent-turn attempts in this worker process.",
      value: this.attempts.size,
    });
    this.observability.setGauge({
      name: "opengeni_turn_oldest_inflight_age_seconds",
      help: "Age in seconds of the oldest in-flight physical agent-turn attempt in this worker process.",
      value: this.oldestInflightAgeSeconds(),
    });
    this.observability.setGauge({
      name: "opengeni_turn_oldest_no_progress_age_seconds",
      help: "Seconds since durable progress for the least recently progressing in-flight physical agent-turn attempt.",
      value: this.oldestNoProgressAgeSeconds(),
    });
  }

  stop(): void {
    this.attempts.clear();
    this.refreshGauges();
    this.stopTimer();
  }

  private oldestInflightAgeSeconds(): number {
    if (this.attempts.size === 0) {
      return 0;
    }
    let oldest = Number.POSITIVE_INFINITY;
    for (const { startedAt } of this.attempts.values()) {
      oldest = Math.min(oldest, startedAt);
    }
    return Math.max(0, (this.now() - oldest) / 1000);
  }

  private oldestNoProgressAgeSeconds(): number {
    if (this.attempts.size === 0) return 0;
    let leastRecentProgress = Number.POSITIVE_INFINITY;
    for (const { lastProgressAt } of this.attempts.values()) {
      leastRecentProgress = Math.min(leastRecentProgress, lastProgressAt);
    }
    return Math.max(0, (this.now() - leastRecentProgress) / 1000);
  }

  private ensureTimer(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.refreshGauges(), this.options.refreshIntervalMs ?? 15_000);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function modelRequestLifecycleMetricsFor(
  observability: Observability,
): ModelRequestLifecycleMetrics {
  const existing = modelRequestTrackers.get(observability);
  if (existing) return existing;
  const tracker = new ModelRequestLifecycleMetrics(observability);
  modelRequestTrackers.set(observability, tracker);
  return tracker;
}

export class ModelRequestLifecycleMetrics {
  private readonly requests = new Map<
    string,
    { provider: string; startedAt: number; lastEventAt: number }
  >();
  private readonly providers = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly observability: Observability,
    private readonly options: {
      now?: () => number;
      refreshIntervalMs?: number;
    } = {},
  ) {}

  start(key: string, provider: string): void {
    const now = this.now();
    this.providers.add(provider);
    this.requests.set(key, { provider, startedAt: now, lastEventAt: now });
    this.ensureTimer();
    this.refreshGauges();
  }

  event(key: string, interEventGapMs?: number): void {
    const request = this.requests.get(key);
    if (!request) return;
    request.lastEventAt = this.now();
    this.observability.incrementCounter({
      name: "opengeni_model_request_stream_events_total",
      help: "Complete, valid provider SSE data events by provider.",
      labels: { provider: request.provider },
    });
    if (interEventGapMs !== undefined) {
      this.observability.observeHistogram({
        name: "opengeni_model_request_stream_event_gap_seconds",
        help: "Seconds between complete, valid provider SSE data events.",
        buckets: MODEL_REQUEST_PHASE_BUCKETS,
        labels: { provider: request.provider },
        value: Math.max(0, interEventGapMs / 1000),
      });
    }
  }

  finish(key: string): void {
    this.requests.delete(key);
    this.refreshGauges();
    if (this.requests.size === 0) this.stopTimer();
  }

  refreshGauges(): void {
    const now = this.now();
    for (const provider of this.providers) {
      const active = [...this.requests.values()].filter((request) => request.provider === provider);
      this.observability.setGauge({
        name: "opengeni_model_requests_inflight",
        help: "Current in-flight provider model requests in this worker process.",
        labels: { provider },
        value: active.length,
      });
      this.observability.setGauge({
        name: "opengeni_model_request_oldest_no_event_age_seconds",
        help: "Seconds since the least recently progressing in-flight provider request received a valid SSE event.",
        labels: { provider },
        value:
          active.length === 0
            ? 0
            : Math.max(0, (now - Math.min(...active.map((request) => request.lastEventAt))) / 1000),
      });
    }
  }

  stop(): void {
    this.requests.clear();
    this.refreshGauges();
    this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.refreshGauges(), this.options.refreshIntervalMs ?? 15_000);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function recordTurnsQueuedGauge(observability: Observability, value: number): void {
  observability.setGauge({
    name: "opengeni_turns_queued",
    help: "Current number of queued session turns.",
    value,
  });
}

/**
 * Record the approximate shared turn-worker activity queue rather than Postgres
 * prompts. A paused human prompt is durable queue truth but is not runnable and
 * never reaches this Temporal task queue. DescribeTaskQueue's approximate
 * backlog count and age are explicitly documented by Temporal as autoscaling
 * signals.
 */
export function recordTurnTaskQueueStats(
  observability: Observability,
  stats: TurnTaskQueueStats,
  identity: TurnTaskQueueIdentity,
): void {
  const labels = turnTaskQueueMetricLabels(identity);
  // Invalid observations are failures, not a fabricated fresh zero. Validate
  // every field before publishing any portion of a new observation.
  const values = {
    backlog: requiredTemporalNumber(stats.eligibleBacklog, "eligibleBacklog", { integer: true }),
    age: requiredTemporalNumber(stats.oldestBacklogAgeSeconds, "oldestBacklogAgeSeconds"),
    add: requiredTemporalNumber(stats.tasksAddRate, "tasksAddRate"),
    dispatch: requiredTemporalNumber(stats.tasksDispatchRate, "tasksDispatchRate"),
  };
  observability.setGauge({
    name: "opengeni_turn_eligible_backlog",
    help: "Approximate Temporal activity backlog on the shared turn-worker queue, including video and retries.",
    labels,
    value: values.backlog,
  });
  observability.setGauge({
    name: "opengeni_turn_eligible_backlog_oldest_age_seconds",
    help: "Approximate age of the oldest eligible activity task on the shared turn-worker queue.",
    labels,
    value: values.age,
  });
  observability.setGauge({
    name: "opengeni_turn_eligible_tasks_add_rate",
    help: "Temporal activities added per second to the shared turn-worker queue over its rolling window.",
    labels,
    value: values.add,
  });
  observability.setGauge({
    name: "opengeni_turn_eligible_tasks_dispatch_rate",
    help: "Temporal activities dispatched per second from the shared turn-worker queue over its rolling window.",
    labels,
    value: values.dispatch,
  });
}

export function normalizeTurnTaskQueueStats(
  stats: TemporalTurnTaskQueueStats | undefined,
): TurnTaskQueueStats {
  if (!stats) {
    throw new Error("Temporal DescribeTaskQueue response omitted required stats");
  }
  if (typeof stats !== "object" || Array.isArray(stats)) {
    throw new Error("Temporal DescribeTaskQueue returned malformed stats");
  }
  const eligibleBacklog = requiredTemporalNumber(
    stats.approximateBacklogCount,
    "approximateBacklogCount",
    { integer: true },
  );
  let oldestBacklogAgeSeconds = 0;
  if (stats.approximateBacklogAge !== null && stats.approximateBacklogAge !== undefined) {
    if (
      typeof stats.approximateBacklogAge !== "object" ||
      Array.isArray(stats.approximateBacklogAge)
    ) {
      throw new Error("Temporal stats returned invalid approximateBacklogAge");
    }
    const seconds = optionalTemporalNumber(
      stats.approximateBacklogAge.seconds,
      "approximateBacklogAge.seconds",
      { integer: true },
    );
    const nanos = optionalTemporalNumber(
      stats.approximateBacklogAge.nanos,
      "approximateBacklogAge.nanos",
      { integer: true },
    );
    if (nanos >= 1_000_000_000) {
      throw new Error("Temporal approximateBacklogAge.nanos must be less than one second");
    }
    oldestBacklogAgeSeconds = seconds + nanos / 1_000_000_000;
  } else if (eligibleBacklog > 0) {
    throw new Error("Temporal stats omitted approximateBacklogAge for a nonzero backlog");
  }
  return {
    eligibleBacklog,
    oldestBacklogAgeSeconds,
    tasksAddRate: optionalTemporalNumber(stats.tasksAddRate, "tasksAddRate"),
    tasksDispatchRate: optionalTemporalNumber(stats.tasksDispatchRate, "tasksDispatchRate"),
  };
}

/** Requires a fresh metric registry/schema; pre-registered legacy unlabelled
 * queue gauges are not migrated in place. Each collector owns its native read. */
export function startTurnCapacityMonitor(input: {
  observability: Observability;
  identity: TurnTaskQueueIdentity;
  read: (options: TurnTaskQueueReadOptions) => Promise<TurnTaskQueueStats>;
  intervalMs?: number;
  readTimeoutMs?: number;
  closeTimeoutMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
  scheduler?: TelemetryScheduler;
}): { close: () => Promise<void> } {
  const intervalMs = telemetryInterval(input.intervalMs ?? 15_000, "queue monitor intervalMs");
  const readTimeoutMs = telemetryInterval(
    input.readTimeoutMs ?? 5_000,
    "queue monitor readTimeoutMs",
  );
  const closeTimeoutMs = telemetryInterval(
    input.closeTimeoutMs ?? 1_000,
    "queue monitor closeTimeoutMs",
  );
  const scheduler = input.scheduler ?? telemetryScheduler;
  const labels = turnTaskQueueMetricLabels(input.identity);
  const wallClock = createTelemetryClock(input.now ?? Date.now);
  const monotonicClock = createTelemetryClock(input.monotonicNow ?? (() => performance.now()));
  let startedAt = wallClock.read();
  const readClock = () => {
    const wall = wallClock.read();
    const monotonic = monotonicClock.read();
    return wall === null || monotonic === null ? null : { wall, monotonic };
  };
  let lastSuccessAt: number | null = null;
  let lastReadSucceeded = false;
  let stopped = false;
  let running: {
    controller: AbortController;
    done: Promise<void>;
    cancelTimeout: () => void;
  } | null = null;
  let closePromise: Promise<void> | undefined;
  const safely = (action: () => void) => {
    try {
      action();
    } catch {
      /* Telemetry must not break the worker. */
    }
  };
  const recordStatus = (observation = readClock()) => {
    if (observation === null) lastReadSucceeded = false;
    const observedAt = wallClock.latest();
    startedAt ??= observedAt;
    const successAgeMs =
      observedAt === null ? 0 : observedAt - (lastSuccessAt ?? startedAt ?? observedAt);
    const set = (name: string, help: string, value: number) =>
      safely(() => input.observability.setGauge({ name, help, labels, value }));
    set(
      "opengeni_turn_capacity_monitor_last_read_success",
      "Whether the latest Temporal turn-queue capacity read completed successfully.",
      lastReadSucceeded ? 1 : 0,
    );
    set(
      "opengeni_turn_capacity_monitor_last_success_timestamp_seconds",
      "Unix timestamp of the latest successful Temporal turn-queue capacity read, or zero before one succeeds.",
      lastSuccessAt === null ? 0 : lastSuccessAt / 1_000,
    );
    set(
      "opengeni_turn_capacity_monitor_last_success_age_seconds",
      "Age of the latest successful Temporal turn-queue capacity read, or monitor age before one succeeds.",
      Math.max(0, successAgeMs / 1_000),
    );
    set(
      "opengeni_turn_capacity_monitor_fresh",
      "Whether the latest read succeeded and the shared activity-queue gauges are within three monitor intervals.",
      lastReadSucceeded && lastSuccessAt !== null && successAgeMs <= intervalMs * 3 ? 1 : 0,
    );
  };
  const refresh = () => {
    // Advance freshness age even while a Temporal read is hung. Old backlog
    // values remain observable for diagnosis but cease to be authoritative.
    if (stopped) return;
    const observation = readClock();
    recordStatus(observation);
    if (running || observation === null) return;
    const deadline = observation.wall + readTimeoutMs;
    if (!Number.isFinite(deadline) || deadline > Number.MAX_SAFE_INTEGER) {
      recordStatus(null);
      return;
    }
    const controller = new AbortController();
    const attempt = { controller, done: Promise.resolve(), cancelTimeout: () => {} };
    running = attempt;
    attempt.cancelTimeout = scheduler.timeout(() => {
      if (stopped || running !== attempt) return;
      lastReadSucceeded = false;
      recordStatus();
      controller.abort();
      // Keep the attempt owned until its native call settles. A misbehaving
      // reader ignoring cancellation must not cause overlapping RPCs.
    }, readTimeoutMs);
    let read: Promise<TurnTaskQueueStats>;
    try {
      read = input.read({ signal: controller.signal, deadline });
    } catch (error) {
      read = Promise.reject(error);
    }
    attempt.done = read
      .then((stats) => {
        if (stopped || controller.signal.aborted || running !== attempt) return;
        const completedAt = readClock();
        // A native RPC may settle before its deadline but its Promise callback
        // can run after it, ahead of a delayed JS timeout. Never restamp that old
        // response as fresh. Monotonic age also fences wall-clock adjustments.
        if (
          completedAt === null ||
          completedAt.wall >= deadline ||
          completedAt.monotonic - observation.monotonic >= readTimeoutMs
        ) {
          lastReadSucceeded = false;
          recordStatus(completedAt);
          controller.abort();
          return;
        }
        recordTurnTaskQueueStats(input.observability, stats, input.identity);
        lastSuccessAt = completedAt.wall;
        lastReadSucceeded = true;
        recordStatus(completedAt);
      })
      .catch(() => {
        if (stopped || controller.signal.aborted || running !== attempt) return;
        lastReadSucceeded = false;
        recordStatus();
        safely(() =>
          input.observability.warn("turn capacity monitor: Temporal task-queue stats failed", {
            // Do not export arbitrary server errors or credentials.
            errorClass: "WorkerTelemetryReadError",
            origin: "turn-capacity-monitor",
          }),
        );
      })
      .finally(() => {
        attempt.cancelTimeout();
        if (running === attempt) running = null;
      });
  };
  refresh();
  const stopTimer = scheduler.interval(refresh, intervalMs);
  return {
    close: () => {
      if (closePromise) return closePromise;
      stopped = true;
      stopTimer();
      lastReadSucceeded = false;
      recordStatus();
      const attempt = running;
      attempt?.cancelTimeout();
      attempt?.controller.abort();
      closePromise = attempt
        ? new Promise<void>((resolve) => {
            const cancel = scheduler.timeout(resolve, closeTimeoutMs);
            void attempt.done.then(() => {
              cancel();
              resolve();
            });
          })
        : Promise.resolve();
      return closePromise;
    },
  };
}

export function recordSessionRecoveryBacklogGauges(
  observability: Observability,
  backlog: SessionRecoveryBacklog,
): void {
  for (const state of ["quiescence_missing", "projection_stale"] as const) {
    const summary = backlog[state];
    observability.setGauge({
      name: "opengeni_session_recovery_backlog",
      help: "Current durable recovering-session obligations with no active attempt, by bounded reconciliation state. Includes sessions legitimately sleeping in their recorded recovery backoff.",
      labels: { state },
      value: nonnegativeFinite(summary.count),
    });
    observability.setGauge({
      name: "opengeni_session_recovery_scheduled",
      help: "Durable recovering sessions still inside the recovery backoff (provider Retry-After or connectivity pacing) their recovery request recorded, by bounded reconciliation state.",
      labels: { state },
      value: nonnegativeFinite(summary.scheduled),
    });
    observability.setGauge({
      name: "opengeni_session_recovery_oldest_overdue_seconds",
      help: "Seconds the single oldest durable recovering session with no active attempt has been past its recovery due time, by bounded reconciliation state; 0 when none is overdue.",
      labels: { state },
      value: nonnegativeFinite(summary.oldestOverdueSeconds),
    });
  }
}

export function startSessionRecoveryMonitor(input: {
  observability: Observability;
  read: () => Promise<SessionRecoveryBacklog>;
  intervalMs?: number;
  now?: () => number;
}): { close: () => Promise<void> } {
  const intervalMs = input.intervalMs ?? 60_000;
  const now = input.now ?? Date.now;
  const startedAt = now();
  let lastSuccessAt: number | null = null;
  let lastReadSucceeded = false;
  let stopped = false;
  let running: Promise<void> | null = null;
  const recordStatus = () => {
    const observedAt = now();
    const successAgeMs = observedAt - (lastSuccessAt ?? startedAt);
    const set = (name: string, help: string, value: number) =>
      input.observability.setGauge({ name, help, value });
    set(
      "opengeni_session_recovery_monitor_last_read_success",
      "Whether the latest durable session-recovery aggregate read completed successfully.",
      lastReadSucceeded ? 1 : 0,
    );
    set(
      "opengeni_session_recovery_monitor_last_success_timestamp_seconds",
      "Unix timestamp of the latest successful durable session-recovery aggregate read, or zero before one succeeds.",
      lastSuccessAt === null ? 0 : lastSuccessAt / 1_000,
    );
    set(
      "opengeni_session_recovery_monitor_fresh",
      "Whether durable session-recovery backlog gauges have a successful read within three monitor intervals.",
      lastReadSucceeded && lastSuccessAt !== null && successAgeMs <= intervalMs * 3 ? 1 : 0,
    );
  };
  const refresh = () => {
    recordStatus();
    if (stopped || running) return;
    running = input
      .read()
      .then((backlog) => {
        recordSessionRecoveryBacklogGauges(input.observability, backlog);
        lastSuccessAt = now();
        lastReadSucceeded = true;
        recordStatus();
      })
      .catch((error) => {
        lastReadSucceeded = false;
        recordStatus();
        input.observability.warn("session recovery monitor: durable aggregate read failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = null;
      });
  };
  refresh();
  const timer = setInterval(refresh, intervalMs);
  timer.unref?.();
  return {
    close: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

export function recordContextCompactionPendingGauges(
  observability: Observability,
  summary: ContextCompactionPendingSummary,
  nowMs = Date.now(),
): void {
  const oldestStartedAtMs = summary.oldestStartedAt?.getTime();
  const oldestPendingAgeSeconds =
    oldestStartedAtMs === undefined || !Number.isFinite(oldestStartedAtMs)
      ? 0
      : Math.max(0, (nowMs - oldestStartedAtMs) / 1_000);
  observability.setGauge({
    name: "opengeni_context_compaction_pending",
    help: "Current exact active attempts whose latest automatic compaction landmark is still started.",
    value: nonnegativeFinite(summary.pendingCount),
  });
  observability.setGauge({
    name: "opengeni_context_compaction_oldest_pending_age_seconds",
    help: "Age in seconds of the oldest durably pending automatic compaction, or zero when none are pending.",
    value: oldestPendingAgeSeconds,
  });
}

export function startContextCompactionPendingMonitor(input: {
  observability: Observability;
  read: () => Promise<ContextCompactionPendingSummary>;
  intervalMs?: number;
  now?: () => number;
}): { close: () => Promise<void> } {
  const intervalMs = input.intervalMs ?? 60_000;
  const now = input.now ?? Date.now;
  const startedAt = now();
  let lastSuccessAt: number | null = null;
  let lastReadSucceeded = false;
  let stopped = false;
  let running: Promise<void> | null = null;
  const recordStatus = () => {
    const observedAt = now();
    const successAgeMs = observedAt - (lastSuccessAt ?? startedAt);
    const set = (name: string, help: string, value: number) =>
      input.observability.setGauge({ name, help, value });
    set(
      "opengeni_context_compaction_monitor_last_read_success",
      "Whether the latest durable context-compaction aggregate read completed successfully.",
      lastReadSucceeded ? 1 : 0,
    );
    set(
      "opengeni_context_compaction_monitor_last_success_timestamp_seconds",
      "Unix timestamp of the latest successful durable context-compaction aggregate read, or zero before one succeeds.",
      lastSuccessAt === null ? 0 : lastSuccessAt / 1_000,
    );
    set(
      "opengeni_context_compaction_monitor_fresh",
      "Whether durable context-compaction pending gauges have a successful read within three monitor intervals.",
      lastReadSucceeded && lastSuccessAt !== null && successAgeMs <= intervalMs * 3 ? 1 : 0,
    );
  };
  const refresh = () => {
    recordStatus();
    if (stopped || running) return;
    running = input
      .read()
      .then((summary) => {
        recordContextCompactionPendingGauges(input.observability, summary, now());
        lastSuccessAt = now();
        lastReadSucceeded = true;
        recordStatus();
      })
      .catch((error) => {
        lastReadSucceeded = false;
        recordStatus();
        input.observability.warn("context compaction monitor: durable aggregate read failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = null;
      });
  };
  refresh();
  const timer = setInterval(refresh, intervalMs);
  timer.unref?.();
  return {
    close: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

export function recordSandboxLeaseGauges(
  observability: Observability,
  counts: Partial<Record<SandboxLeaseLiveness, number>>,
): void {
  for (const liveness of ["cold", "warming", "warm", "draining"] as const) {
    observability.setGauge({
      name: "opengeni_sandbox_leases",
      help: "Current sandbox leases by liveness state.",
      labels: { liveness },
      value: counts[liveness] ?? 0,
    });
  }
}

export function recordOpenSandboxKubernetesInventoryGauges(
  observability: Observability,
  inventory: OpenSandboxKubernetesInventory,
): void {
  for (const phase of OPENSANDBOX_BATCHSANDBOX_PHASES) {
    observability.setGauge({
      name: "opengeni_opensandbox_batchsandboxes",
      help: "Current OpenSandbox BatchSandboxes by bounded lifecycle phase.",
      labels: { phase },
      value: inventory.batchSandboxPhases[phase],
    });
  }
  for (const condition of OPENSANDBOX_WORKLOAD_POD_CONDITIONS) {
    observability.setGauge({
      name: "opengeni_opensandbox_workload_pods",
      help: "Current OpenSandbox workload Pods by bounded operational condition.",
      labels: { condition },
      value: inventory.workloadPodConditions[condition],
    });
  }
  observability.setGauge({
    name: "opengeni_opensandbox_cleanup_stuck",
    help: "Current OpenSandbox BatchSandboxes deleting past the cleanup threshold with finalizers.",
    value: inventory.cleanupStuck,
  });
  observability.setGauge({
    name: "opengeni_opensandbox_expiration_overdue",
    help: "Current OpenSandbox BatchSandboxes still present past the provider-expiry threshold.",
    value: inventory.expirationOverdue,
  });
}

export const SANDBOX_INVENTORY_PROJECTION_DOMAINS = [
  "leases",
  "checkpoint_artifacts",
  "recovery_observations",
  "rotation_backlog",
  "retained_processes",
  "expired_drains",
  "opensandbox_kubernetes",
  "modal_provider",
  "interaction_idle",
  "checkpoint_staleness",
] as const;

export type SandboxInventoryProjectionDomain =
  (typeof SANDBOX_INVENTORY_PROJECTION_DOMAINS)[number];

export function recordSandboxInventoryProjectionSuccess(
  observability: Observability,
  domain: SandboxInventoryProjectionDomain,
  timestampSeconds = Date.now() / 1_000,
): void {
  observability.setGauge({
    name: "opengeni_sandbox_inventory_refresh_timestamp_seconds",
    help: "Unix timestamp of the last complete successful sandbox inventory projection by domain.",
    labels: { domain },
    value: timestampSeconds,
  });
}

export function recordSandboxInventoryProjectionFailure(
  observability: Observability,
  domain: SandboxInventoryProjectionDomain,
): void {
  observability.incrementCounter({
    name: "opengeni_sandbox_inventory_refresh_failures_total",
    help: "Failed sandbox inventory projection refreshes by domain.",
    labels: { domain },
  });
}

export function recordCreditBalanceGauges(
  observability: Observability,
  balances: CreditBalanceGauge[],
): void {
  const previous = creditBalanceGaugeAccounts.get(observability) ?? new Set<string>();
  const current = new Set<string>();
  for (const balance of balances) {
    current.add(balance.accountId);
    observability.setGauge({
      name: "opengeni_credit_balance_micros",
      help: "Current credit balance in micros by account.",
      labels: { account_id: balance.accountId },
      value: balance.balanceMicros,
    });
  }
  for (const accountId of previous) {
    if (!current.has(accountId)) {
      observability.setGauge({
        name: "opengeni_credit_balance_micros",
        help: "Current credit balance in micros by account.",
        labels: { account_id: accountId },
        value: 0,
      });
    }
  }
  creditBalanceGaugeAccounts.set(observability, current);
}

/**
 * Distinct managed people with authenticated browser activity in each fixed
 * window (migration 0565 presence). Every control worker publishes the same
 * global value, so dashboards must aggregate with `max()` across pods, never
 * `sum()`. API keys, services and embedded hosts are never counted.
 */
export function recordActiveUserGauges(
  observability: Observability,
  counts: Record<ActiveUserWindow, number>,
): void {
  for (const window of ACTIVE_USER_WINDOWS) {
    observability.setGauge({
      name: "opengeni_active_users",
      help: "Distinct managed users with authenticated activity within the window (global; use max across pods).",
      labels: { window },
      value: counts[window],
    });
  }
}

/**
 * Positive credit grants observed by the ledger trigger since migration 0565,
 * by closed class. These are cumulative database totals published as gauges by
 * every control worker: aggregate with `max()` across pods, then subtract the
 * same expression `offset` by the window. A per-pod `increase()` sees only one
 * pod's lifetime and undercounts across control-worker restarts.
 * Counting in the database covers the grants no application process writes:
 * the verified-signup trial grant (a setup trigger) and operator grants.
 */
export function recordCreditGrantGauges(
  observability: Observability,
  totals: CreditGrantTotals,
): void {
  for (const grantClass of CREDIT_GRANT_CLASSES) {
    const total = totals[grantClass];
    observability.setGauge({
      name: "opengeni_credit_grants_total",
      help: "Positive credit grants observed in the ledger since migration 0565, by grant class (global cumulative; use max across pods).",
      labels: { grant_class: grantClass },
      value: total.count,
    });
    observability.setGauge({
      name: "opengeni_credit_granted_micros_total",
      help: "Credit micros granted in the ledger since migration 0565, by grant class (global cumulative; use max across pods).",
      labels: { grant_class: grantClass },
      value: total.micros,
    });
  }
}

/**
 * The deployment-level runtime switch for the one-time verified signup trial
 * credit (migration 0521): 1 while it allows grants, 0 when an operator has
 * disabled it or no revision exists. A grant also needs the API's
 * OPENGENI_VERIFIED_SIGNUP_TRIAL_CREDITS_ENABLED master opt-in, which
 * {@link recordVerifiedSignupTrialDeploymentFlagGauge} reports separately.
 */
export function recordVerifiedSignupTrialSwitchGauge(
  observability: Observability,
  grantsEnabled: boolean,
): void {
  observability.setGauge({
    name: "opengeni_verified_signup_trial_credits_runtime_enabled",
    help: "Whether the runtime switch allows new verified signup trial credit grants (1) or blocks them (0).",
    value: grantsEnabled ? 1 : 0,
  });
}

/**
 * The deployment-level runtime switch for new managed account sign-ups
 * (migration 0585): 1 while it allows new accounts (also when no revision
 * exists), 0 when an operator has paused them. The API additionally honours
 * its OPENGENI_MANAGED_AUTH_NEW_SIGNUPS_ENABLED ceiling, which this gauge does
 * not see; `GET /v1/config/client` reports the combined decision.
 */
export function recordManagedAuthNewSignupsSwitchGauge(
  observability: Observability,
  signupsEnabled: boolean,
): void {
  observability.setGauge({
    name: "opengeni_managed_auth_new_signups_runtime_enabled",
    help: "Whether the runtime switch allows new managed account sign-ups (1) or has paused them (0).",
    value: signupsEnabled ? 1 : 0,
  });
}

/**
 * The OPENGENI_VERIFIED_SIGNUP_TRIAL_CREDITS_ENABLED master opt-in as this
 * worker's configuration sees it. The API reads the same shared setting; new
 * grants happen only while this gauge and the runtime switch gauge are both 1.
 */
export function recordVerifiedSignupTrialDeploymentFlagGauge(
  observability: Observability,
  enabled: boolean,
): void {
  observability.setGauge({
    name: "opengeni_verified_signup_trial_credits_deployment_enabled",
    help: "Whether the OPENGENI_VERIFIED_SIGNUP_TRIAL_CREDITS_ENABLED master opt-in is on (1) or off (0) in this deployment's configuration.",
    value: enabled ? 1 : 0,
  });
}

/**
 * Provider-side Modal inventory reconciled against live leases by the orphan
 * sweep: `running` = every running box in the app, `unleased` = running boxes
 * no live lease protects (orphans, counted before termination), and
 * `lease_missing_instance` = warm leases whose exact provider instance is no
 * longer running (zombies).
 */
export function recordModalSandboxInventoryGauges(
  observability: Observability,
  inventory: { running: number; unleased: number; liveLeaseInstancesMissing: number },
): void {
  const states = {
    running: inventory.running,
    unleased: inventory.unleased,
    lease_missing_instance: inventory.liveLeaseInstancesMissing,
  };
  for (const [state, value] of Object.entries(states)) {
    observability.setGauge({
      name: "opengeni_modal_sandbox_inventory",
      help: "Running Modal sandboxes reconciled against live sandbox leases by the orphan sweep.",
      labels: { state },
      value: Math.max(0, value),
    });
  }
}

/** Warm leases held only by Browser/Computer interaction holders, by time since
 * the newest interaction activity. Such boxes never drain on their own until the
 * interaction session ends or the provider deadline. */
export function recordInteractionOnlyLeaseGauges(
  observability: Observability,
  counts: Record<string, number>,
): void {
  for (const [idleBucket, value] of Object.entries(counts)) {
    observability.setGauge({
      name: "opengeni_sandbox_leases_interaction_only",
      help: "Warm sandbox leases held only by Browser/Computer sessions, by time since last interaction activity.",
      labels: { idle_bucket: idleBucket },
      value: Math.max(0, value),
    });
  }
}

export function recordSandboxOrphansTerminated(observability: Observability, count: number): void {
  if (count <= 0) {
    return;
  }
  observability.incrementCounter({
    name: "opengeni_sandbox_orphans_terminated_total",
    help: "Total provider-side orphan sandboxes terminated by defensive sweeps.",
    amount: count,
  });
}

export type SandboxCheckpointArtifactMetricState =
  | "candidate"
  | "current"
  | "previous"
  | "delete_pending"
  | "deleting"
  | "delete_failed"
  | "deleted";

export function recordSandboxCheckpointArtifactGauges(
  observability: Observability,
  counts: Record<SandboxCheckpointArtifactMetricState, number>,
): void {
  for (const state of [
    "candidate",
    "current",
    "previous",
    "delete_pending",
    "deleting",
    "delete_failed",
    "deleted",
  ] as const) {
    observability.setGauge({
      name: "opengeni_sandbox_checkpoint_artifacts",
      help: "Current durable provider checkpoint artifacts by lifecycle state.",
      labels: { state },
      value: counts[state],
    });
  }
}

export type SandboxCheckpointArtifactOutcome =
  | "legacy_adopted"
  | "claimed"
  | "deleted"
  | "delete_failed"
  | "tombstone_pruned";

export function recordSandboxCheckpointArtifactOutcome(
  observability: Observability,
  outcome: SandboxCheckpointArtifactOutcome,
  count = 1,
): void {
  if (count <= 0) return;
  observability.incrementCounter({
    name: "opengeni_sandbox_checkpoint_artifact_operations_total",
    help: "Durable provider checkpoint artifact operations by fixed outcome.",
    labels: { outcome },
    amount: count,
  });
}

export function recordSandboxDeadlineRotationsRequested(
  observability: Observability,
  count: number,
): void {
  if (count <= 0) return;
  observability.incrementCounter({
    name: "opengeni_sandbox_deadline_rotations_requested_total",
    help: "Total finite-lifetime sandbox rotations requested before provider deadline.",
    amount: count,
  });
}

/** Fixed outcomes of legacy retained-command containment: per-candidate
 * enrollment inspection, then the enrolled drain's exact cold commit. */
export const SANDBOX_COMMAND_CONTAINMENT_OUTCOMES = [
  "idle_enrolled",
  "deadline_enrolled",
  "forced_deadline_enrolled",
  "quiescence_enrolled",
  "resumed_enrolled",
  "not_eligible",
  "inspection_failed",
  "contained",
  "provider_missing",
] as const;

export type SandboxCommandContainmentOutcome =
  (typeof SANDBOX_COMMAND_CONTAINMENT_OUTCOMES)[number];

/**
 * Shared subscription core shadow (docs/subscription-accounts.md, SUB-COMPAT-03).
 * Every label is a closed set: provider, security parity, placement agreement,
 * contract requirement, skip reason and the legacy decision inputs present.
 */
export const SUBSCRIPTION_CORE_SHADOW_PROVIDERS = ["codex", "xai", "claude"] as const;
/** Is the account the legacy selector chose inside the core's eligible set? */
export const SUBSCRIPTION_CORE_SHADOW_PARITY = [
  "eligible",
  "not_authorized",
  "not_servable",
  "unknown_connection",
  "no_selection",
] as const;
/** How the core's decision compares with the legacy decision (would-switch). */
export const SUBSCRIPTION_CORE_SHADOW_PLACEMENTS = [
  "same_account",
  "different_account",
  "core_waits",
  "core_runs_legacy_waits",
  "both_wait",
] as const;
/** Requirements the reference checker can report, plus checker failure. */
export const SUBSCRIPTION_CORE_SHADOW_REQUIREMENTS = [
  "SUB-ACCESS-06",
  "SUB-CREDITS-01",
  "SUB-ELIG-01",
  "SUB-ELIG-02",
  "SUB-ELIG-03",
  "SUB-ELIG-04",
  "SUB-ELIG-05",
  "SUB-FAIL-02",
  "SUB-FAIL-03",
  "SUB-FAIL-04",
  "SUB-OWN-05",
  "SUB-SEL-02",
  "SUB-SEL-04",
  "SUB-SET-06",
  "SUB-STICK-02",
  "SUB-WAIT-01",
  "SUB-WAIT-02",
  "other",
  "checker_error",
] as const;
export const SUBSCRIPTION_CORE_SHADOW_SKIPS = [
  "busy",
  "no_session_actor",
  "session_not_visible",
  "timeout",
  "cancelled",
  "error",
] as const;
/**
 * Legacy decision inputs the Codex fleet shadow does not record (inventory
 * Part 3, answer (c)), counted when present in a compared decision.
 */
export const SUBSCRIPTION_CORE_SHADOW_INPUTS = [
  "manual_pin",
  "policy_pin",
  "last_account",
  "rotation_off",
  "rotation_on",
  "organization_pool",
  "personal_pool",
  "codex_mode_override",
  "model_policy",
  "model_filtered",
  "plan_excluded",
  "model_cooldown",
  "exhausted",
  "unknown_quota",
  "compaction_lock",
  "lease_reused",
  "truncated",
] as const;

export type SubscriptionCoreShadowProvider = (typeof SUBSCRIPTION_CORE_SHADOW_PROVIDERS)[number];
export type SubscriptionCoreShadowParity = (typeof SUBSCRIPTION_CORE_SHADOW_PARITY)[number];
export type SubscriptionCoreShadowPlacement = (typeof SUBSCRIPTION_CORE_SHADOW_PLACEMENTS)[number];
export type SubscriptionCoreShadowSkip = (typeof SUBSCRIPTION_CORE_SHADOW_SKIPS)[number];
export type SubscriptionCoreShadowInput = (typeof SUBSCRIPTION_CORE_SHADOW_INPUTS)[number];

export type SubscriptionCoreShadowObservation =
  | { outcome: "skipped"; reason: SubscriptionCoreShadowSkip }
  | {
      outcome: "compared";
      parity: SubscriptionCoreShadowParity;
      /** The first reason the legacy account is outside the eligible set. */
      parityReason: string | null;
      placement: SubscriptionCoreShadowPlacement;
      violations: readonly string[];
      inputs: readonly SubscriptionCoreShadowInput[];
    };

const SUBSCRIPTION_CORE_SHADOW_REQUIREMENT_SET = new Set<string>(
  SUBSCRIPTION_CORE_SHADOW_REQUIREMENTS,
);
/** First reasons a legacy account is outside the eligible set (policy ineligibility). */
export const SUBSCRIPTION_CORE_SHADOW_PARITY_REASONS = [
  "provider_disabled",
  "organization_accounts_off",
  "out_of_scope",
  "personal_connections_disabled",
  "personal_owner_inactive",
  "personal_not_owners_work",
  "personal_authority_missing",
  "unhealthy",
  "allocator_disabled",
  "wrong_provider",
  "model_unknown",
  "model_not_allowed_by_workspace",
  "model_not_entitled",
  "model_not_allowed_by_connection",
  "model_cooling_down",
  "exhausted",
] as const;
const SUBSCRIPTION_CORE_SHADOW_PARITY_REASON_SET = new Set<string>(
  SUBSCRIPTION_CORE_SHADOW_PARITY_REASONS,
);

const SUBSCRIPTION_CORE_SHADOW_DURATION_BUCKETS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
];

export function recordSubscriptionCoreShadow(
  observability: Pick<Observability, "incrementCounter" | "observeHistogram">,
  provider: SubscriptionCoreShadowProvider,
  observation: SubscriptionCoreShadowObservation,
  durationSeconds: number,
): void {
  observability.observeHistogram({
    name: "opengeni_subscription_core_shadow_duration_seconds",
    help: "Shared subscription core shadow comparison duration by provider, including skips.",
    labels: { provider },
    value: durationSeconds,
    buckets: SUBSCRIPTION_CORE_SHADOW_DURATION_BUCKETS,
  });
  if (observation.outcome === "skipped") {
    observability.incrementCounter({
      name: "opengeni_subscription_core_shadow_skips_total",
      help: "Shadow comparisons not made, by fixed reason; placement is unaffected.",
      labels: { provider, reason: observation.reason },
    });
    return;
  }
  observability.incrementCounter({
    name: "opengeni_subscription_core_shadow_comparisons_total",
    help: "Shadow comparisons by security parity of the legacy account and core placement agreement.",
    labels: { provider, parity: observation.parity, placement: observation.placement },
  });
  if (observation.parityReason !== null) {
    observability.incrementCounter({
      name: "opengeni_subscription_core_shadow_parity_failures_total",
      help: "Legacy-selected accounts outside the core's eligible set, by first fixed reason.",
      labels: {
        provider,
        reason: SUBSCRIPTION_CORE_SHADOW_PARITY_REASON_SET.has(observation.parityReason)
          ? observation.parityReason
          : "other",
      },
    });
  }
  for (const requirement of new Set(observation.violations)) {
    observability.incrementCounter({
      name: "opengeni_subscription_core_shadow_violations_total",
      help: "Contract invariant violations of the core's own shadow decision, by requirement.",
      labels: {
        provider,
        requirement: SUBSCRIPTION_CORE_SHADOW_REQUIREMENT_SET.has(requirement)
          ? requirement
          : "other",
      },
    });
  }
  for (const input of observation.inputs) {
    observability.incrementCounter({
      name: "opengeni_subscription_core_shadow_inputs_total",
      help: "Legacy decision inputs present in compared shadow decisions, by fixed input.",
      labels: { provider, input },
    });
  }
}

/** A shadow load that outlived its slot ceiling; its slot was given back. */
export function recordSubscriptionCoreShadowStuckLoad(
  observability: Pick<Observability, "incrementCounter">,
  provider: SubscriptionCoreShadowProvider,
): void {
  observability.incrementCounter({
    name: "opengeni_subscription_core_shadow_stuck_loads_total",
    help: "Shadow world loads still unsettled at the slot ceiling; the slot was released.",
    labels: { provider },
  });
}

/** Idle browser/desktop release inspections by fixed outcome: `checkpointing`
 * (idle browser saves prepared), `released` (holders released without a save). */
export function recordSandboxIdleInteractionRelease(
  observability: Observability,
  outcome: IdleInteractionInspection,
): void {
  observability.incrementCounter({
    name: "opengeni_sandbox_idle_interaction_release_total",
    help: "Idle browser and desktop release inspections on warm boxes, by fixed outcome.",
    labels: { outcome },
  });
}

export function recordSandboxCommandContainment(
  observability: Observability,
  outcome: SandboxCommandContainmentOutcome,
): void {
  observability.incrementCounter({
    name: "opengeni_sandbox_command_containment_total",
    help: "Legacy retained-command containment inspections and enrolled drain commits by fixed outcome.",
    labels: { outcome },
  });
}

/** Only call after the exact draining->cold commit reports wentCold. The
 * backend is validated against the closed contract so provider IDs and other
 * per-sandbox values can never become metric labels. */
export function recordSandboxProviderMissingBeforeCapture(
  observability: Observability,
  backend: string,
): void {
  const safeBackend = SandboxBackend.safeParse(backend).success ? backend : "unknown";
  observability.incrementCounter({
    name: "opengeni_sandbox_provider_missing_before_capture_total",
    help: "Exact sandbox cold commits after definitive provider disappearance before workspace capture.",
    labels: { backend: safeBackend },
  });
}

/** Host workspace directory outcome after a Docker drain's exact-container
 * teardown (`retained` means the directory stays on disk). */
export function recordSandboxDockerWorkspaceRelease(
  observability: Observability,
  status: "released" | "already_released" | "retained",
): void {
  observability.incrementCounter({
    name: "opengeni_sandbox_docker_workspace_release_total",
    help: "Docker drain host workspace directories released or retained after exact-container teardown.",
    labels: { status },
  });
}

export function recordSandboxRecoveryObservationGauges(
  observability: Observability,
  observations: {
    providerLosses: number;
    fallbackSelections: number;
    freshWorkspaceSelections?: number;
  },
): void {
  for (const [kind, value] of [
    ["provider_missing_before_capture", observations.providerLosses],
    ["checkpoint_fallback_selected", observations.fallbackSelections],
    ["fresh_workspace_selected", observations.freshWorkspaceSelections ?? 0],
  ] as const) {
    observability.setGauge({
      name: "opengeni_sandbox_recovery_observations_recent",
      help: "Committed sandbox recovery observations in the last 30 minutes by fixed kind.",
      labels: { kind },
      value,
    });
  }
}

/** Fixed outcomes for a committed automatic continuity decision after
 * definitive managed-provider loss: a singleton checkpoint (`selected`), a
 * shared-group checkpoint (`selected_shared`), or a new empty workspace
 * (`fresh_workspace`). Call only after the durable authorization committed. */
export const SANDBOX_AUTOMATIC_RECOVERY_OUTCOMES = [
  "selected",
  "selected_shared",
  "fresh_workspace",
] as const;
export type SandboxAutomaticRecoveryOutcome = (typeof SANDBOX_AUTOMATIC_RECOVERY_OUTCOMES)[number];

export function sandboxAutomaticRecoveryOutcome(input: {
  lane: "checkpoint" | "fresh_workspace";
  groupSessionCount: number;
}): SandboxAutomaticRecoveryOutcome {
  if (input.lane === "fresh_workspace") return "fresh_workspace";
  return input.groupSessionCount > 1 ? "selected_shared" : "selected";
}

export function recordSandboxAutomaticRecoverySelected(
  observability: Observability,
  backend: string,
  outcome: SandboxAutomaticRecoveryOutcome,
): void {
  const safeBackend = SandboxBackend.safeParse(backend).success ? backend : "unknown";
  observability.incrementCounter({
    name: "opengeni_sandbox_checkpoint_fallback_total",
    help: "System-selected continuity after managed provider loss: verified checkpoint or empty workspace.",
    labels: { backend: safeBackend, outcome },
  });
}

/** How long live boxes have held changes no checkpoint covers yet. */
export function recordSandboxCheckpointStalenessGauges(
  observability: Observability,
  staleness: { dirty: number; stale4h: number; stale12h: number; maxAgeSeconds: number },
): void {
  const values = {
    dirty: staleness.dirty,
    stale_4h: staleness.stale4h,
    stale_12h: staleness.stale12h,
  } as const;
  for (const [kind, value] of Object.entries(values)) {
    observability.setGauge({
      name: "opengeni_sandbox_checkpoint_staleness",
      help: "Live Modal sandboxes holding a write their last checkpoint did not capture, by age of the first such write.",
      labels: { kind },
      value,
    });
  }
  observability.setGauge({
    name: "opengeni_sandbox_checkpoint_age_max_seconds",
    help: "Age in seconds of the oldest write a live Modal sandbox's last checkpoint did not capture.",
    value: Number.isFinite(staleness.maxAgeSeconds) ? Math.max(0, staleness.maxAgeSeconds) : 0,
  });
}

export function recordSandboxRotationBacklogGauges(
  observability: Observability,
  backlog: {
    requested: number;
    overdue: number;
    turnBlocked: number;
    directBlocked: number;
    processBlocked: number;
    interactionBlocked: number;
  },
): void {
  const values = {
    requested: backlog.requested,
    overdue: backlog.overdue,
    turn_blocked: backlog.turnBlocked,
    direct_blocked: backlog.directBlocked,
    process_blocked: backlog.processBlocked,
    interaction_blocked: backlog.interactionBlocked,
  } as const;
  for (const [kind, value] of Object.entries(values)) {
    observability.setGauge({
      name: "opengeni_sandbox_rotation_backlog",
      help: "Current finite-lifetime sandbox rotation backlog by fixed condition.",
      labels: { kind },
      value,
    });
  }
}

const RETAINED_PROCESS_OWNER_STATES = [
  // Session-owned background commands (migration 0637). Running is live
  // session work after its launch turn ended; stopping already has a stop
  // request, so it still counts as terminal-owner backlog.
  "background_running",
  "background_stopping",
  "direct",
  "queued",
  "running",
  "requires_action",
  "recovering",
  "waiting_capacity",
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "withdrawn_for_edit",
  "missing",
  "unknown",
] as const;

const RETAINED_PROCESS_OWNER_STATE_SET = new Set<string>(RETAINED_PROCESS_OWNER_STATES);

export function recordRetainedProcessInventoryGauges(
  observability: Observability,
  counts: Array<{
    ownerState: string;
    activeCount: number;
    terminalOwnerCount: number;
  }>,
): void {
  const normalized = new Map<string, { active: number; terminal: number }>();
  for (const ownerState of RETAINED_PROCESS_OWNER_STATES) {
    normalized.set(ownerState, { active: 0, terminal: 0 });
  }
  for (const count of counts) {
    const ownerState = RETAINED_PROCESS_OWNER_STATE_SET.has(count.ownerState)
      ? count.ownerState
      : "unknown";
    const current = normalized.get(ownerState)!;
    current.active += Math.max(0, count.activeCount);
    current.terminal += Math.max(0, count.terminalOwnerCount);
  }

  for (const [ownerState, count] of normalized) {
    observability.setGauge({
      name: "opengeni_retained_processes_active",
      help: "Current active retained provider processes by durable owner state.",
      labels: { owner_state: ownerState },
      value: count.active,
    });
    observability.setGauge({
      name: "opengeni_retained_processes_terminal_owner_backlog",
      help: "Current active retained processes whose owner is gone: a closed launch attempt or released direct request, or a background command already asked to stop. A running session background command is never counted.",
      labels: { owner_state: ownerState },
      value: count.terminal,
    });
  }
}

export const EXPIRED_DRAINING_BACKENDS = [...SandboxBackend.options, "unknown"] as const;
const EXPIRED_DRAINING_BACKEND_SET = new Set<string>(EXPIRED_DRAINING_BACKENDS);
export const EXPIRED_DRAINING_AGE_BUCKETS = ["lt_5m", "5m_1h", "1h_1d", "gte_1d"] as const;

export function recordExpiredDrainingSandboxLeaseGauges(
  observability: Observability,
  counts: Array<{ backend: string; ageBucket: string; count: number }>,
): void {
  const normalized = new Map<string, number>();
  for (const backend of EXPIRED_DRAINING_BACKENDS) {
    for (const ageBucket of EXPIRED_DRAINING_AGE_BUCKETS) {
      normalized.set(`${backend}:${ageBucket}`, 0);
    }
  }
  for (const count of counts) {
    const backend = EXPIRED_DRAINING_BACKEND_SET.has(count.backend) ? count.backend : "unknown";
    if (!EXPIRED_DRAINING_AGE_BUCKETS.includes(count.ageBucket as never)) continue;
    const key = `${backend}:${count.ageBucket}`;
    normalized.set(key, (normalized.get(key) ?? 0) + Math.max(0, count.count));
  }
  for (const [key, value] of normalized) {
    const [backend, ageBucket] = key.split(":") as [string, string];
    observability.setGauge({
      name: "opengeni_sandbox_leases_expired_draining",
      help: "Current expired draining sandbox leases by backend and fixed age bucket.",
      labels: { backend, age_bucket: ageBucket },
      value,
    });
  }
}

export const RETAINED_PROCESS_RECONCILIATION_OUTCOMES = [
  "claim_failed",
  "background_recovered",
  "proof_exited",
  "proof_lost",
  "proof_checkpoint_failed",
  "settled_exited",
  "settled_lost",
  "provider_lost_whole_box",
  "settlement_failed",
  "identity_mismatch",
  "resume_state_missing",
  "backend_unsupported",
  "provider_running",
  "provider_unknown",
  "provider_timeout",
  "provider_error",
  "provider_binding_missing",
  "provider_binding_mismatch",
  "provider_binding_adopted",
  "process_observation_unavailable",
  "quarantined_process_observation_unavailable",
  "quarantined_binding_missing",
  "quarantined_binding_mismatch",
  "defer_failed",
] as const;

export type RetainedProcessReconciliationOutcome =
  (typeof RETAINED_PROCESS_RECONCILIATION_OUTCOMES)[number];

export function recordRetainedProcessReconciliation(
  observability: Observability,
  outcome: RetainedProcessReconciliationOutcome,
): void {
  observability.incrementCounter({
    name: "opengeni_retained_process_reconciliation_total",
    help: "Bounded retained-process reconciliation observations by fixed app outcome.",
    labels: { outcome },
  });
}

export function recordCreditMicros(
  observability: Observability | undefined,
  kind: CreditMicrosKind,
  amountMicros: number,
): void {
  if (!observability || amountMicros <= 0) {
    return;
  }
  observability.incrementCounter({
    name: "opengeni_credit_micros_total",
    help: "Total credit micros recorded by kind.",
    labels: { kind },
    amount: amountMicros,
  });
}

// ── Per-model usage and money ───────────────────────────────────────────────
// `model` is the deployment catalog product id (resolved by the caller), or
// `custom` for a workspace-owned model. The recorder bounds it again: a value
// outside a conservative id shape becomes `custom`, and after
// MAX_MODEL_METRIC_LABELS distinct values per process every new value becomes
// `other`, so a catalog change or a bug can never grow the series count without
// bound. Account, workspace, user and session ids are never labels here.

/** Who pays the upstream provider for the call. */
export type ModelUsagePayer = "deployment" | "external";

const MODEL_METRIC_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const MAX_MODEL_METRIC_LABELS = 64;
const modelMetricLabels = new WeakMap<Observability, Set<string>>();

export function boundedModelMetricLabel(observability: Observability, model: string): string {
  if (model === "custom" || model === "other") return model;
  if (!MODEL_METRIC_LABEL_PATTERN.test(model)) return "custom";
  let seen = modelMetricLabels.get(observability);
  if (!seen) {
    seen = new Set<string>();
    modelMetricLabels.set(observability, seen);
  }
  if (seen.has(model)) return model;
  if (seen.size >= MAX_MODEL_METRIC_LABELS) return "other";
  seen.add(model);
  return model;
}

function nonnegativeSafeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * One authoritative model response, by provider and catalog model. Recorded
 * behind the same durable usage-event fence as the provider-only cache metrics,
 * so a duplicate or late response is not counted twice.
 *   - `opengeni_model_responses_total{provider,model,priced}` — responses with
 *     reported usage; `priced="false"` means no provider cost estimate exists.
 *   - `opengeni_model_tokens_total{provider,model,type}` — `input` (all prompt
 *     tokens, including cached and cache-write), `cached_input` and
 *     `cache_write` (subsets of `input`), `output`, and `reasoning` (a subset
 *     of `output`).
 *   - `opengeni_model_provider_cost_micros_total{provider,model,payer,pricing_source}`
 *     — estimated upstream cost in USD micros: configured list price, or the
 *     gateway-reported cost. `payer="external"` is a customer-paid subscription
 *     or key, so that cost is a list-price equivalent Opengeni does not pay.
 */
export function recordModelResponseUsage(
  observability: Observability,
  input: {
    provider: string;
    model: string;
    payer: ModelUsagePayer;
    tokens: {
      inputTokens: number | null;
      cachedTokens: number | null;
      cacheWriteTokens: number | null;
      outputTokens: number | null;
      reasoningTokens: number | null;
    };
    estimatedProviderCostMicros: number | null;
    pricingSource: "configured_list_price" | "gateway_reported" | null;
    webSearchRequests?: number;
  },
): void {
  const model = boundedModelMetricLabel(observability, input.model);
  const base = { provider: input.provider, model };
  const priced = input.pricingSource !== null && input.estimatedProviderCostMicros !== null;
  observability.incrementCounter({
    name: "opengeni_model_responses_total",
    help: "Authoritative model responses with reported usage, by provider, catalog model and whether a cost estimate exists.",
    labels: { ...base, priced: priced ? "true" : "false" },
  });
  const tokenTypes = [
    ["input", input.tokens.inputTokens],
    ["cached_input", input.tokens.cachedTokens],
    ["cache_write", input.tokens.cacheWriteTokens],
    ["output", input.tokens.outputTokens],
    ["reasoning", input.tokens.reasoningTokens],
  ] as const;
  for (const [type, value] of tokenTypes) {
    const amount = modelUsageTokenCountOrNull(value);
    if (amount === null || amount === 0) continue;
    incrementBoundedModelCacheCounter(observability, {
      name: "opengeni_model_tokens_total",
      help: "Tokens of authoritative model responses by provider, catalog model and token type (cached_input and cache_write are subsets of input; reasoning is a subset of output).",
      provider: input.provider,
      labels: { ...base, type },
      amount,
    });
  }
  const searches = nonnegativeSafeInteger(input.webSearchRequests ?? 0);
  if (searches > 0)
    observability.incrementCounter({
      name: "opengeni_model_web_search_requests_total",
      help: "Provider-run web searches billed with authoritative model responses, by provider, catalog model and payer.",
      labels: { ...base, payer: input.payer },
      amount: searches,
    });
  const cost = nonnegativeSafeInteger(input.estimatedProviderCostMicros);
  if (priced && input.pricingSource !== null && cost > 0) {
    observability.incrementCounter({
      name: "opengeni_model_provider_cost_micros_total",
      help: "Estimated upstream provider cost in USD micros by provider, catalog model, payer and pricing source.",
      labels: { ...base, payer: input.payer, pricing_source: input.pricingSource },
      amount: cost,
    });
  }
}

/**
 * Credits actually debited for one model response, recorded once when the
 * ledger row is inserted (an idempotent replay debits 0 and records nothing).
 * `funding="promotional"` is the part paid by scoped promotional grants
 * (verified-signup trial, scoped coupon offers); `funding="general"` is the
 * rest, paid from general credit: purchased credits plus any unscoped grant.
 */
export function recordModelCreditsCharged(
  observability: Observability | undefined,
  input: { provider: string; model: string; debitedMicros: number; grantDebitedMicros: number },
): void {
  if (!observability) return;
  const debited = nonnegativeSafeInteger(input.debitedMicros);
  if (debited === 0) return;
  const promotional = Math.min(debited, nonnegativeSafeInteger(input.grantDebitedMicros));
  const model = boundedModelMetricLabel(observability, input.model);
  for (const [funding, amount] of [
    ["promotional", promotional],
    ["general", debited - promotional],
  ] as const) {
    if (amount === 0) continue;
    observability.incrementCounter({
      name: "opengeni_model_credits_charged_micros_total",
      help: "Credit micros debited for model usage by provider, catalog model and funding (promotional grant or general credit).",
      labels: { provider: input.provider, model, funding },
      amount,
    });
  }
}

const MODEL_REQUEST_PHASE_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 1, 2, 5, 10, 30, 60, 300,
];

/**
 * Record provider lifecycle diagnostics from the synchronous transport observer.
 * Provider ids come from the resolved provider registry; phase/outcome are closed
 * enums. This function never performs I/O outside the in-memory metrics registry.
 */
export function recordModelRequestPhase(
  observability: Observability,
  input: {
    provider: string;
    phase: "headers" | "first_byte" | "terminal";
    outcome?: "completed" | "failed" | "timed_out";
    durationSeconds: number;
  },
): void {
  const outcome = input.outcome ?? "";
  observability.incrementCounter({
    name: "opengeni_model_request_phases_total",
    help: "Provider model-request lifecycle phases by bounded phase and outcome.",
    labels: { provider: input.provider, phase: input.phase, outcome },
  });
  observability.observeHistogram({
    name: "opengeni_model_request_phase_duration_seconds",
    help: "Monotonic seconds from provider dispatch to a model-request lifecycle phase.",
    buckets: MODEL_REQUEST_PHASE_BUCKETS,
    labels: { provider: input.provider, phase: input.phase },
    value: Math.max(0, input.durationSeconds),
  });
}

export type TurnStartupPhase =
  | "services_initialization"
  | "claim_catalog_read"
  | "claim_atomic"
  | "claim_session_read"
  | "claim_capability_settings"
  | "learning_policy_freeze"
  | "attachment_authority_projection"
  | "claim_and_policy"
  | "turn_start_settlement"
  | "credential_selection"
  | "runtime_preparation"
  | "session_mcp_settings"
  | "sandbox_establish"
  | "file_resolution"
  | "tool_context_preparation"
  | "tool_preparation"
  | "tool_server_construction"
  | "tool_required_connect"
  | "tool_optional_connect"
  | "tool_attempt_catalog_build"
  | "tool_attempt_catalog_persist"
  | "tool_workspace_gateway_catalog_build"
  | "post_tool_preparation"
  | "agent_construction"
  | "post_agent_preparation"
  | "file_materialization"
  | "history_preparation"
  | "history_system_update_load"
  | "history_current_attachment_resolution"
  | "history_durable_history_load"
  | "history_sandbox_envelope_load"
  | "history_canonical_projection"
  | "history_provider_projection"
  | "history_attachment_ref_projection"
  | "history_screenshot_materialization"
  | "history_model_attachment_projection"
  | "history_runtime_input_assembly"
  | "history_artifact_candidate_scan"
  | "history_generated_image_materialization"
  | "history_position_load"
  | "owned_sandbox_setup"
  | "runtime_stream_initialization"
  | "model_request_preparation"
  | "model_sdk_serialization"
  | "model_prepare_sandbox_agent_preparation"
  | "model_prepare_sandbox_agent_manifest_inventory"
  | "model_prepare_sandbox_session_manifest_inventory"
  | "model_prepare_sandbox_manifest_apply"
  | "model_prepare_sandbox_entry_materialization"
  | "model_prepare_sandbox_running_check"
  | "model_prepare_sandbox_start"
  | "model_prepare_sandbox_client_create"
  | "model_prepare_sandbox_client_resume"
  | "model_prepare_sandbox_client_delete"
  | "model_prepare_sandbox_client_state_serialize"
  | "model_prepare_sandbox_client_reuse_check"
  | "model_prepare_sandbox_workspace_mutation_admission"
  | "model_prepare_sandbox_workspace_mutation_provider"
  | "model_prepare_sandbox_workspace_mutation_settlement"
  | "model_prepare_sandbox_first_routed_resolution_other"
  | "model_prepare_sandbox_first_routed_mutation_admission"
  | "model_prepare_sandbox_first_routed_provider_operation"
  | "model_prepare_sandbox_first_routed_mutation_settlement"
  | "model_prepare_sandbox_first_routed_other"
  | "model_prepare_sandbox_snapshot_wait"
  | "model_prepare_runner_before_first_sandbox_operation"
  | "model_prepare_sdk_after_first_sandbox_operation"
  | "model_prepare_runner_before_mcp_tools"
  | "model_prepare_mcp_tools_snapshot"
  | "model_prepare_mcp_tools_before_input_filter"
  | "model_prepare_mcp_tools_before_repository_skill_discovery"
  | "model_prepare_repository_skill_discovery"
  | "model_prepare_repository_skill_discovery_before_input_filter"
  | "model_prepare_input_filter_base"
  | "model_prepare_input_filter_genesis"
  | "model_prepare_input_filter_host"
  | "model_prepare_input_filter_tool_output"
  | "model_prepare_input_filter_modality"
  | "model_prepare_input_filter_context"
  | "model_prepare_responses_input_conversion"
  | "model_prepare_responses_request_build"
  | "model_credential_resolution"
  | "model_wire_normalization"
  | "model_request_audit"
  | "stream_bootstrap";

export type TurnStartupOutcome = "completed" | "failed";
export type TurnStartupMilestone = "queue" | "provider_dispatch" | "first_byte";
export type TurnStartupCache = "hit" | "miss" | "disabled" | "none";
export type TurnStartupCountBucket = "0" | "1" | "2-5" | "6-20" | "21+" | "unknown";
export type TurnSandboxEstablishPolicy = "eager" | "on-demand";
export type TurnSandboxEstablishReason =
  | "eligible"
  | "lazy_disabled"
  | "machine_primary"
  | "backend_none"
  | "initial_run_credentials"
  | "initial_run_credentials_deferred"
  | "generated_video_files"
  | "signed_file_resources";
export type SandboxLogicalProvisionCategory =
  | "create"
  | "resume"
  | "exec_readiness"
  | "sibling_warming"
  | "lease_superseded"
  | "drain_capture_wait"
  | "archive_recovery"
  | "provider_transport"
  | "configuration"
  | "unknown";
export type SandboxLogicalProvisionStage =
  | "create"
  | "resume"
  | "exec_readiness"
  | "sibling_warming"
  | "lease_admission"
  | "lifecycle_wait"
  | "archive_recovery"
  | "configuration"
  | "provider_transport"
  | "unknown";
export type SandboxLogicalProvisionOutcome = "completed" | "expected_transition" | "failed";
export type SandboxProvisionAttemptOutcome = "completed" | "retrying" | "failed";

const TURN_STARTUP_PHASE_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120,
];
const TURN_STARTUP_MILESTONE_BUCKETS = [
  ...TURN_STARTUP_PHASE_BUCKETS,
  300,
  600,
  1_800,
  3_600,
  7_200,
];

export function turnStartupCountBucket(count: number | null): TurnStartupCountBucket {
  if (count === null || !Number.isFinite(count) || count < 0) return "unknown";
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  if (count <= 20) return "6-20";
  return "21+";
}

/**
 * Measure startup operations, including nested and parallel work. These are
 * not additive critical-path intervals; use milestones for elapsed latency.
 * Every label is a closed or configuration-derived enum; high-cardinality turn,
 * session, credential, connection, file, and model identifiers are forbidden.
 */
export function recordTurnStartupPhase(
  observability: Observability,
  input: {
    phase: TurnStartupPhase;
    provider: string;
    backend: string;
    outcome: TurnStartupOutcome;
    durationSeconds: number;
    count?: number | null;
    cache?: TurnStartupCache;
    /** Trace-only lookup for the completed claim while its execution root is still open. */
    executionCorrelationId?: string;
  },
): void {
  completedOperationSpan(observability, `worker.prepare.${input.phase}`, input.durationSeconds, {
    provider: input.provider,
    backend: input.backend,
    outcome: input.outcome,
    ...(input.phase === "claim_and_policy" &&
    /^turn_[0-9a-f]{32}$/.test(input.executionCorrelationId ?? "")
      ? { correlationId: input.executionCorrelationId }
      : {}),
  });
  observability.observeHistogram({
    name: "opengeni_turn_startup_phase_duration_seconds",
    help: "Turn startup phase duration before the model response stream begins.",
    buckets: TURN_STARTUP_PHASE_BUCKETS,
    labels: {
      phase: input.phase,
      provider: input.provider,
      backend: input.backend,
      outcome: input.outcome,
      count_bucket: turnStartupCountBucket(input.count ?? null),
      cache: input.cache ?? "none",
    },
    value: Math.max(0, input.durationSeconds),
  });
}

/** Observe an existing dependency only. Child intervals can overlap and are
 * not additive; observer failure must never change authority or error identity. */
export async function measureTurnStartupPhase<T>(
  observability: Observability,
  input: Omit<Parameters<typeof recordTurnStartupPhase>[1], "durationSeconds" | "outcome">,
  work: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let outcome: TurnStartupOutcome = "failed";
  try {
    const result = await work();
    outcome = "completed";
    return result;
  } finally {
    try {
      recordTurnStartupPhase(observability, {
        ...input,
        outcome,
        durationSeconds: (performance.now() - started) / 1_000,
      });
    } catch {
      // Telemetry is not an execution gate.
    }
  }
}

/** Background MCP preparation must not inflate startup phase distributions. */
export function recordToolPreparationPhase(
  observability: Observability,
  input: ToolPreparationPhaseMeasurement & { provider: string; backend: string },
): void {
  if (input.execution === "blocking") {
    recordTurnStartupPhase(observability, {
      ...input,
      phase: `tool_${input.phase}`,
    });
    return;
  }
  completedOperationSpan(
    observability,
    `worker.tool_prepare.${input.phase}`,
    input.durationSeconds,
    {
      provider: input.provider,
      backend: input.backend,
      outcome: input.outcome,
    },
  );
  observability.observeHistogram({
    name: "opengeni_tool_background_preparation_duration_seconds",
    help: "Nonblocking MCP preparation operations; may overlap startup and later execution.",
    buckets: TURN_STARTUP_PHASE_BUCKETS,
    labels: {
      phase: input.phase,
      provider: input.provider,
      backend: input.backend,
      outcome: input.outcome,
    },
    value: Math.max(0, input.durationSeconds),
  });
}

/** Completed measurements become siblings under the scoped physical attempt.
 * They never establish ambient ancestry for work which has already finished. */
function completedOperationSpan(
  observability: Observability,
  name: string,
  durationSeconds: number,
  attributes: {
    outcome: string;
    provider?: string;
    backend?: string;
    tool?: string;
    correlationId?: string | undefined;
  },
): void {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return;
  try {
    const failed = [
      "failed",
      "error",
      "provider_declared_error",
      "auth_needed",
      "outcome_uncertain",
      "timeout",
      "thrown_transport_error",
      "thrown_protocol_error",
    ].includes(attributes.outcome);
    observability
      .startSpan(name, attributes, { startTimeMs: Date.now() - durationSeconds * 1_000 })
      .end({
        ...(failed ? { error: true } : {}),
      });
  } catch {
    // Observers cannot change the completed model/tool/phase outcome.
  }
}

/**
 * Explain why a turn did or did not keep provider sandbox work off the
 * pre-model critical path. The reason is a closed enum: never attach session,
 * sandbox, credential, or file identifiers here.
 */
export function recordTurnSandboxEstablishPolicy(
  observability: Observability,
  input: {
    policy: TurnSandboxEstablishPolicy;
    reason: TurnSandboxEstablishReason;
    backend: string;
  },
): void {
  observability.incrementCounter({
    name: "opengeni_turn_sandbox_establish_policy_total",
    help: "Turn sandbox establish policy decisions by bounded reason.",
    labels: {
      policy: input.policy,
      reason: input.reason,
      backend: input.backend,
    },
  });
}

/** Physical establish/resume attempts inside one logical provision. Safe
 * lifecycle retries are counted here, never as another user-visible failure. */
export function recordSandboxProvisionAttempt(
  observability: Observability,
  input: {
    backend: string;
    stage: SandboxLogicalProvisionStage;
    category: SandboxLogicalProvisionCategory;
    outcome: SandboxProvisionAttemptOutcome;
    durationSeconds: number;
  },
): void {
  const labels = {
    backend: input.backend,
    stage: input.stage,
    category: input.category,
    outcome: input.outcome,
  };
  try {
    observability.incrementCounter({
      name: "opengeni_sandbox_provision_attempts_total",
      help: "Internal physical attempts within logical sandbox provisions.",
      labels,
    });
    observability.observeHistogram({
      name: "opengeni_sandbox_provision_attempt_duration_seconds",
      help: "Internal sandbox provision attempt duration by bounded structural outcome.",
      buckets: TURN_STARTUP_PHASE_BUCKETS,
      labels,
      value: Math.max(0, input.durationSeconds),
    });
  } catch {
    try {
      observability.incrementCounter({
        name: "opengeni_observability_observer_errors_total",
        help: "Observability observer failures isolated from product execution.",
        labels: { observer: "sandbox_provision" },
      });
    } catch {
      // The registry itself is unhealthy; provisioning remains authoritative.
    }
  }
}

/** One terminal observation for one correlation-qualified logical provision. */
export function recordSandboxLogicalProvision(
  observability: Observability,
  input: {
    backend: string;
    stage: SandboxLogicalProvisionStage;
    category: SandboxLogicalProvisionCategory | "none";
    outcome: SandboxLogicalProvisionOutcome;
    expected: boolean;
    internalAttempts: number;
    durationSeconds: number;
  },
): void {
  const labels = {
    backend: input.backend,
    stage: input.stage,
    category: input.category,
    outcome: input.outcome,
    expected: input.expected ? "true" : "false",
  };
  try {
    observability.incrementCounter({
      name: "opengeni_sandbox_provisions_total",
      help: "Logical sandbox provisions by terminal outcome and bounded failure taxonomy.",
      labels,
    });
    observability.observeHistogram({
      name: "opengeni_sandbox_provision_duration_seconds",
      help: "Logical sandbox provision duration including internal safe retries.",
      buckets: TURN_STARTUP_PHASE_BUCKETS,
      labels,
      value: Math.max(0, input.durationSeconds),
    });
    observability.observeHistogram({
      name: "opengeni_sandbox_provision_internal_attempts",
      help: "Internal physical attempts per terminal logical sandbox provision.",
      buckets: [1, 2, 3, 4, 5, 8],
      labels,
      value: Math.max(1, input.internalAttempts),
    });
  } catch {
    try {
      observability.incrementCounter({
        name: "opengeni_observability_observer_errors_total",
        help: "Observability observer failures isolated from product execution.",
        labels: { observer: "sandbox_provision" },
      });
    } catch {
      // The registry itself is unhealthy; provisioning remains authoritative.
    }
  }
}

export function recordSandboxSharedPreparation(
  observability: Observability,
  measurement: {
    path: "owner" | "joined" | "reused";
    outcome: "completed" | "failed";
    durationSeconds: number;
  },
): void {
  observability.observeHistogram({
    name: "opengeni_sandbox_shared_preparation_duration_seconds",
    help: "Duration of exact-lease immutable sandbox preparation by durable coordination path and outcome.",
    labels: { path: measurement.path, outcome: measurement.outcome },
    value: Math.max(0, measurement.durationSeconds),
  });
}

export function recordTurnWorkerPreparationTotal(
  observability: Observability,
  input: {
    provider: string;
    backend: string;
    outcome: TurnStartupOutcome;
    durationSeconds: number;
  },
): void {
  observability.observeHistogram({
    name: "opengeni_turn_worker_preparation_duration_seconds",
    help: "Worker preparation from the durable turn-start boundary until entering the runtime; lazy SDK request preparation and model-request audit are separate phases.",
    buckets: TURN_STARTUP_PHASE_BUCKETS,
    labels: {
      provider: input.provider,
      backend: input.backend,
      outcome: input.outcome,
    },
    value: Math.max(0, input.durationSeconds),
  });
}

/**
 * Measure cumulative user-visible startup latency from the durable turn queue
 * timestamp to a bounded milestone. Unlike the per-phase histogram above,
 * these samples are end-to-end and can therefore back real queue/dispatch/TTFB
 * SLOs without adding turn or session identifiers to Prometheus.
 */
export function recordTurnStartupMilestone(
  observability: Observability,
  input: {
    milestone: TurnStartupMilestone;
    provider: string;
    backend: string;
    outcome: TurnStartupOutcome;
    durationSeconds: number;
  },
): void {
  observability.observeHistogram({
    name: "opengeni_turn_startup_milestone_duration_seconds",
    help: "Cumulative seconds from durable turn queueing to a bounded startup milestone.",
    buckets: TURN_STARTUP_MILESTONE_BUCKETS,
    labels: {
      milestone: input.milestone,
      provider: input.provider,
      backend: input.backend,
      outcome: input.outcome,
    },
    value: Math.max(0, input.durationSeconds),
  });
}

// ── Streaming SLIs ────────────────────────────────────────────────────────────
// Instruments the token-streaming pipeline so "streaming is sluggish" is a number,
// not a vibe. Split across the three attributable stages so an operator can tell
// WHERE the latency lives: the model (TTFT + inter-delta gaps), our durable write
// path (append latency), or delivery (publish latency + batcher flush shape). All
// labels are bounded (provider from the model registry, a two-value delta class) —
// never a session id or a raw user-supplied model string.

export type StreamDeltaClass = "message" | "reasoning";

/** Content-delta classes only. A `null` return means "not a content delta" — the
 *  event that re-arms the TTFT anchor and closes an inter-delta run. */
function contentDeltaClass(type: SessionEventType): StreamDeltaClass | null {
  if (type === "agent.message.delta") {
    return "message";
  }
  if (type === "agent.reasoning.delta") {
    return "reasoning";
  }
  return null;
}

// TTFT lives on a human-perceptible scale, but reasoning models legitimately
// think for tens of seconds before their first streamed token. The finite
// buckets therefore run well past 10s: a top bucket at 10s made every slower
// first token land in +Inf, so p50/p99 saturated at exactly "10" and hid how
// slow the tail really was.
const STREAM_TTFT_BUCKETS = [
  0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300,
];
const STREAM_INTER_DELTA_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 1, 2, 5];
// Opengeni's own per-request work before the provider sees bytes: admission,
// durable history/audit checkpoints, request build. Normally milliseconds to a
// second; tens of seconds means our database or consumer is the bottleneck.
const MODEL_REQUEST_PRE_DISPATCH_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120,
];

/** First streamed content of a provider response. `any` is the first reasoning
 *  or answer delta; `text` is the first answer-text delta. They overlap — never
 *  sum across `content`. */
export type ProviderFirstContent = "any" | "text";

/**
 * Per-stream timing tracker fed every normalized runtime event in push order,
 * plus two producer-side hooks. It separates OUR latency from the PROVIDER's:
 *
 *   - `opengeni_stream_ttft_seconds{provider}` — user-perceived (re)start latency:
 *     time from a stream start / structural boundary (tool call, tool result,
 *     completed message, usage frame) to the first streamed content delta. It
 *     mixes our between-call work with provider time; keep it for the absolute
 *     dashboard view, not for provider alerting.
 *   - `opengeni_model_request_pre_dispatch_seconds{provider}` — OUR per-request
 *     latency: SDK model entry (the first admission check) to the literal
 *     provider dispatch. Covers admission, the durable history checkpoint,
 *     credit revalidation, the durable request audit and request build.
 *   - `opengeni_model_provider_ttft_seconds{provider,content}` — the PROVIDER's
 *     latency: literal dispatch to the first streamed `any` (reasoning or text)
 *     delta and to the first answer `text` delta. Includes network, provider
 *     queueing, prompt prefill and reasoning before the first streamed token.
 *   - `opengeni_stream_inter_delta_gap_seconds{provider,class}` — gap between
 *     consecutive content deltas of the SAME class, reset at every structural
 *     event so a gap never spans a tool call or a model boundary.
 *
 * Dispatch timing deliberately survives structural events: the consumer may
 * still be persisting the previous response's tool results when the producer
 * dispatches the next request, but the next request's first delta always
 * follows its own dispatch. Purely observational and clock-injectable.
 */
export class StreamTimingMetrics {
  private readonly now: () => number;
  private ttftAnchor: number;
  private ttftArmed = true;
  private readonly lastDeltaAt = new Map<StreamDeltaClass, number>();
  private modelEntryAt: number | null = null;
  private dispatchedAt: number | null = null;
  private readonly providerFirstRecorded = new Set<ProviderFirstContent>();

  constructor(
    private readonly observability: Observability,
    private readonly options: { provider: string; now?: () => number },
  ) {
    this.now = options.now ?? (() => performance.now());
    this.ttftAnchor = this.now();
  }

  /** Producer side: the SDK entered a model request (first admission check).
   *  Admission can be re-entered for the same request; keep the earliest. */
  onModelRequestEntry(): void {
    if (this.modelEntryAt === null) this.modelEntryAt = this.now();
  }

  /** Producer side: request bytes are about to leave this process. */
  onProviderDispatch(): void {
    const at = this.now();
    if (this.modelEntryAt !== null) {
      this.observability.observeHistogram({
        name: "opengeni_model_request_pre_dispatch_seconds",
        help: "Seconds of Opengeni work from SDK model-request entry to literal provider dispatch.",
        buckets: MODEL_REQUEST_PRE_DISPATCH_BUCKETS,
        labels: { provider: this.options.provider },
        value: Math.max(0, (at - this.modelEntryAt) / 1000),
      });
      this.modelEntryAt = null;
    }
    // A transport retry re-dispatches the same request; the first delta then
    // belongs to the latest dispatch.
    this.dispatchedAt = at;
    this.providerFirstRecorded.clear();
  }

  onEvent(type: SessionEventType): void {
    const deltaClass = contentDeltaClass(type);
    if (deltaClass === null) {
      // A non-content event: the model paused emitting. Re-arm TTFT so the next
      // content delta measures (re)start latency, and close every inter-delta run
      // so no gap spans a tool call / model boundary.
      this.ttftAnchor = this.now();
      this.ttftArmed = true;
      this.lastDeltaAt.clear();
      return;
    }
    const at = this.now();
    if (this.ttftArmed) {
      this.observability.observeHistogram({
        name: "opengeni_stream_ttft_seconds",
        help: "Seconds from a stream start or structural boundary to the next streamed content delta (user-perceived; includes Opengeni between-call work).",
        buckets: STREAM_TTFT_BUCKETS,
        labels: { provider: this.options.provider },
        value: Math.max(0, (at - this.ttftAnchor) / 1000),
      });
      this.ttftArmed = false;
    }
    if (this.dispatchedAt !== null) {
      this.observeProviderFirst("any", at);
      if (deltaClass === "message") this.observeProviderFirst("text", at);
    }
    const last = this.lastDeltaAt.get(deltaClass);
    if (last !== undefined) {
      this.observability.observeHistogram({
        name: "opengeni_stream_inter_delta_gap_seconds",
        help: "Seconds between consecutive streamed content deltas of the same class.",
        buckets: STREAM_INTER_DELTA_BUCKETS,
        labels: { provider: this.options.provider, class: deltaClass },
        value: Math.max(0, (at - last) / 1000),
      });
    }
    this.lastDeltaAt.set(deltaClass, at);
  }

  private observeProviderFirst(content: ProviderFirstContent, at: number): void {
    if (this.dispatchedAt === null || this.providerFirstRecorded.has(content)) return;
    this.providerFirstRecorded.add(content);
    this.observability.observeHistogram({
      name: "opengeni_model_provider_ttft_seconds",
      help: "Seconds from literal provider dispatch to the first streamed content delta (any = reasoning or text, text = answer text).",
      buckets: STREAM_TTFT_BUCKETS,
      labels: { provider: this.options.provider, content },
      value: Math.max(0, (at - this.dispatchedAt) / 1000),
    });
  }
}

// Batch shapes: sizes are small integers; durations are the append+publish round
// trip the flush performs (sub-ms to a couple seconds under contention).
const STREAM_BATCH_SIZE_BUCKETS = [1, 2, 5, 10, 20, 50, 100, 200, 500];
const STREAM_IO_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/** Flush shape of the streaming batcher: how many events coalesced into one flush
 *  (the coalescing win) and how long that flush took (append + publish). */
export function recordBatchFlush(
  observability: Observability,
  input: { events: number; durationSeconds: number },
): void {
  observability.observeHistogram({
    name: "opengeni_stream_batch_flush_events",
    help: "Session events coalesced into one streaming batcher flush.",
    buckets: STREAM_BATCH_SIZE_BUCKETS,
    value: input.events,
  });
  observability.observeHistogram({
    name: "opengeni_stream_batch_flush_duration_seconds",
    help: "Duration in seconds of one streaming batcher flush (append + publish).",
    buckets: STREAM_IO_BUCKETS,
    value: input.durationSeconds,
  });
}

/** Latency of the durable `appendSessionEvents` DB write — the write path. A p99
 *  climb here is our Postgres, not the model or NATS. */
export function recordSessionEventAppendLatency(
  observability: Observability,
  input: { durationSeconds: number },
): void {
  observability.observeHistogram({
    name: "opengeni_session_event_append_seconds",
    help: "Duration in seconds of an appendSessionEvents DB write (the durable write path).",
    buckets: STREAM_IO_BUCKETS,
    value: input.durationSeconds,
  });
}

export function sessionEventBatchSizeClass(eventCount: number): string {
  if (!Number.isFinite(eventCount) || eventCount <= 0) return "unknown";
  if (eventCount === 1) return "1";
  if (eventCount <= 5) return "2-5";
  if (eventCount <= 10) return "6-10";
  if (eventCount <= 25) return "11-25";
  if (eventCount <= 50) return "26-50";
  return "51+";
}

/** Bounded database-phase attribution for exact-attempt event appends. */
export function recordSessionEventAppendPhase(
  observability: Observability,
  observation: SessionEventAppendPhaseObservation,
): void {
  observability.observeHistogram({
    name: "opengeni_session_event_append_phase_seconds",
    help: "Duration of one bounded database phase in an exact-attempt session event append.",
    buckets: STREAM_IO_BUCKETS,
    labels: {
      path: "turn_attempt",
      event_class: observation.eventClass,
      batch_size_class: sessionEventBatchSizeClass(observation.eventCount),
      phase: observation.phase,
      outcome: observation.outcome,
    },
    value: Math.max(0, observation.durationSeconds),
  });
}

/** Latency of the best-effort NATS live fan-out — the delivery path. A p99 climb
 *  here (with append healthy) is delivery, not the write path. */
export function recordSessionEventPublishLatency(
  observability: Observability,
  input: { durationSeconds: number },
): void {
  observability.observeHistogram({
    name: "opengeni_session_event_publish_seconds",
    help: "Duration in seconds of the best-effort NATS live fan-out publish (the delivery path).",
    buckets: STREAM_IO_BUCKETS,
    value: input.durationSeconds,
  });
}

// Context tokens per response span a wide range; buckets retain context-pressure
// diagnostics while compaction alerting follows the durable model-aware start.
const MODEL_INPUT_TOKENS_BUCKETS = [
  1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 150_000, 200_000, 300_000, 500_000, 1_000_000,
];

/** Observed input (context) tokens per model response for context-pressure
 *  dashboards and provider diagnostics. */
export function recordModelInputTokens(
  observability: Observability,
  provider: string,
  inputTokens: number,
): void {
  const normalizedInputTokens = modelUsageTokenCountOrNull(inputTokens);
  if (normalizedInputTokens === null || normalizedInputTokens === 0) {
    return;
  }
  observability.observeHistogram({
    name: "opengeni_model_input_tokens",
    help: "Observed input (context) tokens per model response, by provider.",
    buckets: MODEL_INPUT_TOKENS_BUCKETS,
    labels: { provider },
    value: normalizedInputTokens,
  });
}

/** A context compaction successfully completed, by bounded trigger. */
export function recordContextCompaction(
  observability: Observability,
  trigger: ContextCompactionTrigger,
): void {
  observability.incrementCounter({ ...CONTEXT_COMPACTIONS_METRIC, labels: { trigger } });
}

/**
 * A durable context-compaction start, recorded only after the attempt-fenced
 * `compaction.started` transaction commits. This is the model-aware threshold
 * signal; it does not guess from a static token count shared by unlike models.
 */
export function recordContextCompactionStarted(
  observability: Observability,
  trigger: ContextCompactionTrigger,
): void {
  observability.incrementCounter({ ...CONTEXT_COMPACTION_STARTS_METRIC, labels: { trigger } });
}

const MODEL_CONTEXT_CONTRIBUTION_TOKEN_BUCKETS = [1, 8, 32, 128, 512, 2_048, 8_192];

/**
 * Metadata-only Company Brain exposure telemetry. Labels are closed enums and
 * never include tenant ids, record ids, titles, descriptions, or content.
 */
export function recordCompanyBrainContributions(
  observability: Observability,
  receipt: CompanyBrainContributionReceipt,
): void {
  for (const contribution of receipt.contributions) {
    const labels = {
      category: contribution.category,
      source: contribution.source,
      inclusion_reason: contribution.inclusionReason,
      authority_scope: contribution.authorityScope,
      session_role: receipt.sessionRole,
      memory_prompt_mode: receipt.memoryPromptMode,
    };
    observability.incrementCounter({
      name: "opengeni_model_context_contributions_total",
      help: "Agent Knowledge contributions exposed to a model, by bounded reason and authority.",
      labels,
    });
    observability.observeHistogram({
      name: "opengeni_model_context_contribution_estimated_tokens",
      help: "Estimated tokens per model-visible Agent Knowledge contribution.",
      buckets: MODEL_CONTEXT_CONTRIBUTION_TOKEN_BUCKETS,
      labels,
      value: contribution.estimatedTokens,
    });
  }
}

// ── Prompt-cache efficiency ─────────────────────────────────────────────────
// Per model-call prompt-cache signal, provider-labelled only (bounded
// cardinality — never a session id or account). `cached_tokens` is the slice of
// the prompt the provider served from its prompt cache; the ratio cached/prompt
// is the efficiency of that call. The account-switch hypothesis (a codex account
// rotation cold-starts the provider's per-account prompt cache) is tested from
// the per-call STRUCTURED LOG below — the account id is unbounded, so it is
// hashed into a log field and NEVER a Prometheus label.

// The hit ratio lives in [0, 1]; bucket tighter around the alerting threshold so
// a p50 near 40% resolves. The default duration buckets (to 3600) would collapse
// every ratio into the first bucket.
const MODEL_CACHE_HIT_RATIO_BUCKETS = [
  0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1,
];

/**
 * Prompt-cache efficiency of one model response, by provider. Reads from the SAME
 * usage frame that feeds input-token accounting, so the two are always consistent:
 *   - `opengeni_model_cached_tokens_total{provider}` — cumulative prompt tokens the
 *     provider served from cache. Advanced only when >0, so a provider that never
 *     reports cached tokens contributes nothing rather than phantom zero-increments.
 *   - `opengeni_model_cache_write_tokens_total{provider}` — cumulative tokens a
 *     reporting provider wrote into its prompt cache. Absent telemetry contributes
 *     nothing; in particular, Codex subscription usage does not currently expose it.
 *   - `opengeni_model_cache_hit_ratio{provider}` — cached/prompt for the call,
 *     observed only when prompt tokens are known (>0) AND cached tokens are reported.
 *     A reported cached-token zero records a real 0%; absent/null telemetry remains
 *     unknown and must not fabricate a low-cache signal.
 *   - `opengeni_model_cache_read_telemetry_total{provider,status}` — one bounded
 *     availability observation per authoritative call (`reported` or `missing`).
 * Invalid, fractional, unsafe, or over-contract token telemetry is rejected. A call
 * with no prompt tokens has no ratio (skipped).
 */
export function recordModelCacheTokens(
  observability: Observability,
  provider: string,
  input: {
    cachedTokens: number | null | undefined;
    cacheWriteTokens?: number | null | undefined;
    promptTokens: number | null | undefined;
  },
): void {
  const cached = modelUsageTokenCountOrNull(input.cachedTokens);
  const cacheWrite = modelUsageTokenCountOrNull(input.cacheWriteTokens);
  const prompt = modelUsageTokenCountOrNull(input.promptTokens);
  incrementBoundedModelCacheCounter(observability, {
    name: "opengeni_model_cache_read_telemetry_total",
    help: "Authoritative model calls with reported or missing cache-read telemetry, by provider.",
    provider,
    labels: { provider, status: cached === null ? "missing" : "reported" },
    amount: 1,
  });
  if (cached !== null && cached > 0) {
    incrementBoundedModelCacheCounter(observability, {
      name: "opengeni_model_cached_tokens_total",
      help: "Total prompt tokens served from the provider's prompt cache, by provider.",
      provider,
      labels: { provider },
      amount: cached,
    });
  }
  if (cacheWrite !== null && cacheWrite > 0) {
    incrementBoundedModelCacheCounter(observability, {
      name: "opengeni_model_cache_write_tokens_total",
      help: "Total prompt tokens written to the provider's prompt cache, by provider.",
      provider,
      labels: { provider },
      amount: cacheWrite,
    });
  }
  if (cached !== null && prompt !== null && prompt > 0) {
    observability.observeHistogram({
      name: "opengeni_model_cache_hit_ratio",
      help: "Per-call prompt-cache hit ratio (cached/prompt tokens) by provider.",
      buckets: MODEL_CACHE_HIT_RATIO_BUCKETS,
      labels: { provider },
      // Clamp to [0, 1]: a provider that (rarely) reports cached >= prompt must
      // not skew the histogram past 1.0.
      value: Math.min(1, cached / prompt),
    });
  }
}

function incrementBoundedModelCacheCounter(
  observability: Observability,
  input: {
    name: string;
    help: string;
    provider: string;
    labels: Record<string, string>;
    amount: number;
  },
): void {
  const totals = modelCacheCounterTotals.get(observability) ?? new Map<string, number>();
  if (!modelCacheCounterTotals.has(observability)) {
    modelCacheCounterTotals.set(observability, totals);
  }
  const labelKey = Object.entries(input.labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const key = `${input.name}:${labelKey}`;
  const current = totals.get(key) ?? 0;
  if (input.amount > MAX_MODEL_CACHE_COUNTER_TOTAL - current) {
    observability.warn("model cache metric cumulative limit reached", {
      provider: input.provider,
      metric: input.name,
    });
    return;
  }
  observability.incrementCounter({
    name: input.name,
    help: input.help,
    labels: input.labels,
    amount: input.amount,
  });
  totals.set(key, current + input.amount);
}

function nonnegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function requiredTemporalNumber(
  value: unknown,
  field: string,
  options: { integer?: boolean } = {},
): number {
  if (value === null || value === undefined) {
    throw new Error(`Temporal stats omitted required ${field}`);
  }
  // protobuf Long is supported through its string representation. Refuse JS
  // coercions (booleans, arrays, blanks) and hostile toString implementations.
  let raw: unknown = value;
  try {
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) raw = raw.toString();
  } catch {
    throw new Error(`Temporal stats returned invalid ${field}`);
  }
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    (options.integer && !Number.isSafeInteger(parsed))
  ) {
    throw new Error(`Temporal stats returned invalid ${field}`);
  }
  return parsed;
}

function optionalTemporalNumber(
  value: unknown,
  field: string,
  options: { integer?: boolean } = {},
): number {
  return value === null || value === undefined ? 0 : requiredTemporalNumber(value, field, options);
}

/**
 * An opaque, stable, non-reversible tag for a codex credential (account) — the
 * per-call log dimension the account-switch hypothesis correlates against. It is
 * a hash of the NON-SECRET credential ROW id (never a token/bearer), truncated so
 * it is short in logs while still distinguishing a handful of accounts without
 * collision. A null/absent credential (non-codex turn, no active account) tags as
 * "none" so the field is always present and never leaks an id verbatim.
 */
export function stableAccountHash(credentialId: string | null | undefined): string {
  if (!credentialId) {
    return "none";
  }
  return createHash("sha256").update(credentialId).digest("hex").slice(0, 12);
}

/**
 * The per-call account dimensions for the usage log: the opaque serving-account
 * tag and whether that account CHANGED versus the session's previous call. Within
 * one turn the serving credential is fixed, so a switch can only surface on the
 * turn's FIRST call (compared against the session's durably-recorded prior
 * credential); later calls in the same turn report `false`. A switch is reported
 * only when there was a KNOWN prior account that differs — a session's very first
 * call (no prior) is a cold start, not a switch.
 */
export function modelCallAccountContext(input: {
  servingCredentialId: string | null;
  priorSessionCredentialId: string | null;
  isFirstCallOfTurn: boolean;
}): { servingAccountHash: string; accountChangedFromPrevCall: boolean } {
  const accountChangedFromPrevCall =
    input.isFirstCallOfTurn &&
    input.servingCredentialId !== null &&
    input.priorSessionCredentialId !== null &&
    input.priorSessionCredentialId !== input.servingCredentialId;
  return {
    servingAccountHash: stableAccountHash(input.servingCredentialId),
    accountChangedFromPrevCall,
  };
}

export type CodeSearchCallOutcome =
  | "completed"
  | "jev_unavailable"
  | "jev_rejected"
  | "workspace_unavailable"
  | "invalid_arguments"
  | "breaker_open"
  | "cancelled"
  | "failed";

/** One `code_search` tool call: outcome, wall time and the Jev work it used. */
export function recordCodeSearchCall(
  observability: Observability,
  input: {
    outcome: CodeSearchCallOutcome;
    durationSeconds: number;
    jevRequests: number;
    jevCostUsd: number;
  },
): void {
  observability.incrementCounter({
    name: "opengeni_code_search_calls_total",
    help: "Jev-backed code_search tool calls by outcome.",
    labels: { outcome: input.outcome },
  });
  observability.observeHistogram({
    name: "opengeni_code_search_duration_seconds",
    help: "Wall time of one code_search tool call.",
    buckets: [0.5, 1, 2, 4, 8, 15, 30, 60],
    labels: { outcome: input.outcome },
    value: Math.max(0, input.durationSeconds),
  });
  if (input.jevRequests > 0) {
    observability.incrementCounter({
      name: "opengeni_code_search_jev_requests_total",
      help: "Jev requests made by code_search.",
      amount: input.jevRequests,
    });
  }
  if (input.jevCostUsd > 0) {
    observability.incrementCounter({
      name: "opengeni_code_search_jev_cost_micro_usd_total",
      help: "Estimated Jev list-price cost of code_search, in micro-USD.",
      amount: Math.round(input.jevCostUsd * 1_000_000),
    });
  }
}

/**
 * One skill_read call. Labels are closed sets: `skill` is a built-in id or
 * `custom` for every other Skill, so tenant Skill ids, names, and requested
 * identifiers never become labels. `source` is `unknown` when the read was
 * refused before a Skill resolved.
 */
export function recordSkillRead(
  observability: Observability,
  read: {
    caller: "model" | "codemode";
    kind: SkillReadKind;
    source: SkillUseSource | null;
    /** The resolved Skill id, or the requested identifier when none resolved. */
    skill: string;
  },
): void {
  observability.incrementCounter({
    name: "opengeni_skill_reads_total",
    help: "skill_read calls by Skill source, built-in Skill id (custom for any other Skill), result kind, and caller.",
    labels: {
      source: read.source ?? "unknown",
      skill: skillReadMetricLabel(read.source, read.skill),
      kind: read.kind,
      caller: read.caller,
    },
  });
}

/**
 * One skill_checkout call. Labels are closed sets and never carry Skill ids,
 * names, or paths. Phases that did not run are not observed.
 */
export function recordSkillCheckout(
  observability: Observability,
  checkout: {
    outcome: "written" | "unchanged" | "refused" | "failed";
    selection: "all" | "paths";
    written: number;
    unchanged: number;
    resolveSeconds: number | null;
    sandboxSeconds: number | null;
    writeSeconds: number | null;
    totalSeconds: number;
  },
): void {
  observability.incrementCounter({
    name: "opengeni_skill_checkouts_total",
    help: "skill_checkout calls by outcome and whether they selected specific paths.",
    labels: { outcome: checkout.outcome, selection: checkout.selection },
  });
  const phases = [
    ["resolve", checkout.resolveSeconds],
    ["sandbox", checkout.sandboxSeconds],
    ["write", checkout.writeSeconds],
    ["total", checkout.totalSeconds],
  ] as const;
  for (const [phase, seconds] of phases) {
    if (seconds === null) continue;
    observability.observeHistogram({
      name: "opengeni_skill_checkout_duration_seconds",
      help: "Wall time of skill_checkout phases: resolve (authority and Skill read), sandbox (filesystem handle, including lazy box start), write (batched file write), and total.",
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60],
      labels: { phase, outcome: checkout.outcome },
      value: Math.max(0, seconds),
    });
  }
  for (const [result, amount] of [
    ["written", checkout.written],
    ["unchanged", checkout.unchanged],
  ] as const) {
    if (amount <= 0) continue;
    observability.incrementCounter({
      name: "opengeni_skill_checkout_files_total",
      help: "Files skill_checkout wrote or found already present with the same content.",
      labels: { result },
      amount,
    });
  }
}

function skillReadMetricLabel(source: SkillUseSource | null, skill: string): string {
  if (source !== null && source !== "builtin") return "custom";
  // A refused read may name a built-in by its plain name.
  for (const candidate of source === null ? [skill, `builtin:${skill}`] : [skill]) {
    const parsed = BundledSkillId.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return "custom";
}
