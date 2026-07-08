import type { EventLogger } from "@opengeni/events";
import type { Attributes, AttributeValue, Observability } from "@opengeni/observability";
import type { RuntimeMetricsHooks } from "@opengeni/runtime";

export type TurnOutcome = "completed" | "failed" | "cancelled" | "preempted";
export type CreditMicrosKind = "usage" | "grant" | "topup" | "refund";
export type SandboxLeaseLiveness = "cold" | "warming" | "warm" | "draining";
export type CreditBalanceGauge = { accountId: string; balanceMicros: number };

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

export function recordTurnsQueuedGauge(observability: Observability, value: number): void {
  observability.setGauge({
    name: "opengeni_turns_queued",
    help: "Current number of queued session turns.",
    value,
  });
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
