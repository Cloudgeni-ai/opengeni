import { createHash } from "node:crypto";
import { errorCodeToJSON } from "@opengeni/agent-proto";
import type { SessionEventType } from "@opengeni/contracts";
import type { EventLogger } from "@opengeni/events";
import type { Attributes, AttributeValue, Observability } from "@opengeni/observability";
import {
  SELFHOSTED_INFRASTRUCTURE_FAULT_CLASSES,
  type RuntimeMetricsHooks,
  type SelfhostedOpObservation,
  type SelfhostedOpObserver,
} from "@opengeni/runtime";

export type TurnOutcome = "completed" | "failed" | "cancelled" | "recovering";
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
const creditBalanceGaugeAccounts = new WeakMap<Observability, Set<string>>();

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
  const sanitized: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    sanitized[key] = eventAttributeValue(value);
  }
  return sanitized;
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
    onSandboxCreate: ({ backend, outcome, durationSeconds }) => {
      observability.incrementCounter({
        name: "opengeni_sandbox_creates_total",
        help: "Total sandbox create attempts by backend and outcome.",
        labels: { backend, outcome },
      });
      observability.observeHistogram({
        name: "opengeni_sandbox_create_duration_seconds",
        help: "Sandbox create duration in seconds by backend.",
        labels: { backend },
        value: durationSeconds,
      });
    },
    onSandboxWarmingTimeout: () => {
      observability.incrementCounter({
        name: "opengeni_sandbox_warming_timeouts_total",
        help: "Total sandbox warming timeouts.",
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
  payload: { op: string; faultClass: string; attempts: number; machineId?: string };
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

export class TurnLifecycleMetrics {
  private readonly startedTurns = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly observability: Observability,
    private readonly options: { now?: () => number; refreshIntervalMs?: number } = {},
  ) {}

  start(turnId: string): void {
    this.startedTurns.set(turnId, this.now());
    this.ensureTimer();
    this.refreshGauges();
  }

  finish(turnId: string, outcome: TurnOutcome | null, durationSeconds?: number): void {
    const startedAt = this.startedTurns.get(turnId);
    if (startedAt !== undefined) {
      this.startedTurns.delete(turnId);
    }
    if (outcome) {
      const observedDuration =
        durationSeconds ??
        (startedAt === undefined ? 0 : Math.max(0, (this.now() - startedAt) / 1000));
      this.observability.incrementCounter({
        name: "opengeni_turns_total",
        help: "Total agent turns by terminal outcome.",
        labels: { outcome },
      });
      this.observability.observeHistogram({
        name: "opengeni_turn_duration_seconds",
        help: "Agent turn duration in seconds by terminal outcome.",
        labels: { outcome },
        value: observedDuration,
      });
    }
    this.refreshGauges();
    if (this.startedTurns.size === 0) {
      this.stopTimer();
    }
  }

  refreshGauges(): void {
    this.observability.setGauge({
      name: "opengeni_turns_inflight",
      help: "Current number of in-flight agent turns in this worker process.",
      value: this.startedTurns.size,
    });
    this.observability.setGauge({
      name: "opengeni_turn_oldest_inflight_age_seconds",
      help: "Age in seconds of the oldest in-flight agent turn in this worker process.",
      value: this.oldestInflightAgeSeconds(),
    });
  }

  stop(): void {
    this.startedTurns.clear();
    this.refreshGauges();
    this.stopTimer();
  }

  private oldestInflightAgeSeconds(): number {
    if (this.startedTurns.size === 0) {
      return 0;
    }
    let oldest = Number.POSITIVE_INFINITY;
    for (const startedAt of this.startedTurns.values()) {
      oldest = Math.min(oldest, startedAt);
    }
    return Math.max(0, (this.now() - oldest) / 1000);
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

/**
 * Record the authoritative turn activity queue rather than aggregate Postgres
 * prompts. A paused human prompt is durable queue truth but is not runnable and
 * never reaches this Temporal task queue. DescribeTaskQueue's approximate
 * backlog count and age are explicitly documented by Temporal as autoscaling
 * signals.
 */
export function recordTurnTaskQueueStats(
  observability: Observability,
  stats: TurnTaskQueueStats,
): void {
  observability.setGauge({
    name: "opengeni_turn_eligible_backlog",
    help: "Temporal runAgentTurn activity tasks eligible for immediate worker admission.",
    value: nonnegativeFinite(stats.eligibleBacklog),
  });
  observability.setGauge({
    name: "opengeni_turn_eligible_backlog_oldest_age_seconds",
    help: "Approximate age of the oldest eligible runAgentTurn activity task.",
    value: nonnegativeFinite(stats.oldestBacklogAgeSeconds),
  });
  observability.setGauge({
    name: "opengeni_turn_eligible_tasks_add_rate",
    help: "Temporal runAgentTurn tasks added per second over its rolling window.",
    value: nonnegativeFinite(stats.tasksAddRate),
  });
  observability.setGauge({
    name: "opengeni_turn_eligible_tasks_dispatch_rate",
    help: "Temporal runAgentTurn tasks dispatched per second over its rolling window.",
    value: nonnegativeFinite(stats.tasksDispatchRate),
  });
}

export function normalizeTurnTaskQueueStats(
  stats: TemporalTurnTaskQueueStats | undefined,
): TurnTaskQueueStats {
  return {
    eligibleBacklog: temporalNumber(stats?.approximateBacklogCount),
    oldestBacklogAgeSeconds: Math.max(
      0,
      temporalNumber(stats?.approximateBacklogAge?.seconds) +
        temporalNumber(stats?.approximateBacklogAge?.nanos) / 1_000_000_000,
    ),
    tasksAddRate: temporalNumber(stats?.tasksAddRate),
    tasksDispatchRate: temporalNumber(stats?.tasksDispatchRate),
  };
}

export function startTurnCapacityMonitor(input: {
  observability: Observability;
  read: () => Promise<TurnTaskQueueStats>;
  intervalMs?: number;
  now?: () => number;
}): { close: () => Promise<void> } {
  const intervalMs = input.intervalMs ?? 15_000;
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
      "Whether eligible-backlog gauges have a successful Temporal read within three monitor intervals.",
      lastReadSucceeded && lastSuccessAt !== null && successAgeMs <= intervalMs * 3 ? 1 : 0,
    );
  };
  const refresh = () => {
    // Advance freshness age even while a Temporal read is hung. Old backlog
    // values remain observable for diagnosis but cease to be authoritative.
    recordStatus();
    if (stopped || running) return;
    running = input
      .read()
      .then((stats) => {
        recordTurnTaskQueueStats(input.observability, stats);
        lastSuccessAt = now();
        lastReadSucceeded = true;
        recordStatus();
      })
      .catch((error) => {
        lastReadSucceeded = false;
        recordStatus();
        input.observability.warn("turn capacity monitor: Temporal task-queue stats failed", {
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

// TTFT and inter-delta live on a human-perceptible scale (tens of ms to a few
// seconds), so they get their own SHORT buckets — the default duration buckets
// (which run to 3600s) would collapse every real streaming value into one bucket.
const STREAM_TTFT_BUCKETS = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10];
const STREAM_INTER_DELTA_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 1, 2, 5];

/**
 * Per-turn stream-timing tracker fed every normalized runtime event in push order.
 * It emits two model-responsiveness SLIs from the worker's seat on the stream:
 *
 *   - `opengeni_stream_ttft_seconds{provider}` — time from a model (re)start to its
 *     first streamed content delta. The anchor starts at construction (≈ runStream
 *     start, so the first observation is "how long until text appears") and re-arms
 *     on every non-content event (a tool call, a completed message, a usage frame),
 *     so a post-tool response measures the model's restart latency, NOT our own
 *     tool-execution time.
 *   - `opengeni_stream_inter_delta_gap_seconds{provider,class}` — gap between
 *     consecutive content deltas of the SAME class. The run resets on any
 *     non-content event so a gap never spans a tool call or a model boundary — it
 *     measures only the choppiness of a live token stream.
 *
 * Purely observational and clock-injectable; it never touches the events it sees.
 */
export class StreamTimingMetrics {
  private readonly now: () => number;
  private ttftAnchor: number;
  private ttftArmed = true;
  private readonly lastDeltaAt = new Map<StreamDeltaClass, number>();

  constructor(
    private readonly observability: Observability,
    private readonly options: { provider: string; now?: () => number },
  ) {
    this.now = options.now ?? (() => performance.now());
    this.ttftAnchor = this.now();
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
        help: "Seconds from a model (re)start to its first streamed content delta.",
        buckets: STREAM_TTFT_BUCKETS,
        labels: { provider: this.options.provider },
        value: Math.max(0, (at - this.ttftAnchor) / 1000),
      });
      this.ttftArmed = false;
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

// Context tokens per response span a wide range; buckets track the pressure toward
// a model's window so "sessions are running hot but never compacting" is queryable.
const MODEL_INPUT_TOKENS_BUCKETS = [
  1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 150_000, 200_000, 300_000, 500_000, 1_000_000,
];

/** Observed input (context) tokens per model response — the context-pressure
 *  signal. Paired with `opengeni_context_compactions_total`, it makes the
 *  "compaction never firing while contexts run hot" failure mode expressible. */
export function recordModelInputTokens(
  observability: Observability,
  provider: string,
  inputTokens: number,
): void {
  if (!(inputTokens > 0)) {
    return;
  }
  observability.observeHistogram({
    name: "opengeni_model_input_tokens",
    help: "Observed input (context) tokens per model response, by provider.",
    buckets: MODEL_INPUT_TOKENS_BUCKETS,
    labels: { provider },
    value: inputTokens,
  });
}

/** A context compaction actually fired, by trigger (operator | overflow | proactive
 *  | auto). The rate of this — against the input-tokens histogram above — is how an
 *  operator sees compaction working (or silently not). */
export function recordContextCompaction(observability: Observability, trigger: string): void {
  observability.incrementCounter({
    name: "opengeni_context_compactions_total",
    help: "Total context compactions performed, by trigger.",
    labels: { trigger },
  });
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
 *   - `opengeni_model_cache_hit_ratio{provider}` — cached/prompt for the call,
 *     observed whenever prompt tokens are known (>0). A call whose provider does NOT
 *     report cached_tokens records a real 0 here — "we saw a call and the cache did
 *     nothing" is exactly the signal the alert watches, so it must not be swallowed.
 * Absent/zero/non-finite `cachedTokens` (providers that don't report it) is safe: no
 * counter increment, ratio 0. A call with no prompt tokens has no ratio (skipped).
 */
export function recordModelCacheTokens(
  observability: Observability,
  provider: string,
  input: { cachedTokens: number | null | undefined; promptTokens: number | null | undefined },
): void {
  const cached = nonNegativeTokenCount(input.cachedTokens);
  const prompt = nonNegativeTokenCount(input.promptTokens);
  if (cached > 0) {
    observability.incrementCounter({
      name: "opengeni_model_cached_tokens_total",
      help: "Total prompt tokens served from the provider's prompt cache, by provider.",
      labels: { provider },
      amount: cached,
    });
  }
  if (prompt > 0) {
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

function nonNegativeTokenCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nonnegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function temporalNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
