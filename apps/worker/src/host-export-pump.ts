import type { HostEventSink, HostUsageSink } from "@opengeni/contracts";
import {
  acknowledgeHostExportBatch,
  claimHostExportBatch,
  disableHostExportConsumer,
  failHostExportBatch,
  getHostExportConsumerStatus,
  pruneHostExportOutbox,
  registerHostExportConsumer,
  retireHostExportConsumer,
  type Database,
  type HostExportConsumerStatus,
  type HostExportKind,
} from "@opengeni/db";
import type { Observability } from "@opengeni/observability";

export type HostExportDrainResult =
  | { kind: HostExportKind; outcome: "not_configured" | "idle" }
  | { kind: HostExportKind; outcome: "blocked"; failures: number }
  | {
      kind: HostExportKind;
      outcome: "delivered";
      count: number;
      throughCursor: string;
    }
  | {
      kind: HostExportKind;
      outcome: "failed";
      failures: number;
      blocked: boolean;
    };

export type HostExportPumpOptions = {
  /** A handle authenticated as the separately provisioned host-export role. */
  db: Database;
  eventSink?: HostEventSink;
  usageSink?: HostUsageSink;
  observability?: Observability;
  instanceId?: string;
  pollIntervalMs?: number;
  leaseSeconds?: number;
  batchLimit?: number;
  batchMaxBytes?: number;
  maxFailures?: number;
  /** Maximum catch-up batches per poll tick; bounds one iteration's work. */
  maxBatchesPerPoll?: number;
  /** Acked rows younger than this remain available for replay. */
  pruneGraceSeconds?: number;
  /** Maximum rows pruned after one successful acknowledgement. */
  pruneLimit?: number;
};

export type HostExportPump = {
  /** Register configured consumers and start the non-overlapping poll loop. */
  start: () => Promise<void>;
  /** Stop polling and wait for the currently executing sink call, if any. */
  stop: () => Promise<void>;
  /** Execute at most one bounded batch for each configured sink. */
  drainOnce: () => Promise<HostExportDrainResult[]>;
  /**
   * Disable this named consumer while retaining its replay checkpoint. If it is
   * the last enabled consumer of the kind, capture stops and that interval is
   * intentionally unrecoverable. Normal process shutdown must not call this.
   */
  disable: (kind: HostExportKind) => Promise<void>;
  /** Permanently remove a stopped consumer and release its retention floor. */
  retire: (kind: HostExportKind) => Promise<void>;
  status: (kind: HostExportKind) => Promise<HostExportConsumerStatus | null>;
};

/**
 * Build the durable delivery loop used by embedded hosts.
 *
 * The source transaction writes the outbox; this pump only leases, delivers,
 * and checkpoints it. Delivery is intentionally at least once: a process death
 * after sink success but before acknowledgement repeats the same idempotency
 * keys. Sink implementations must therefore deduplicate those keys.
 */
export function createHostExportPump(options: HostExportPumpOptions): HostExportPump {
  if (!options.eventSink && !options.usageSink) {
    throw new Error("createHostExportPump requires at least one host sink");
  }
  const instanceId = validateInstanceId(
    options.instanceId ?? `worker-${process.pid}-${crypto.randomUUID()}`,
  );
  const pollIntervalMs = boundedInteger(options.pollIntervalMs, 1_000, 25, 60_000);
  const leaseSeconds = boundedInteger(options.leaseSeconds, 60, 5, 300);
  const batchLimit = boundedInteger(options.batchLimit, 100, 1, 256);
  const batchMaxBytes = boundedInteger(options.batchMaxBytes, 1_048_576, 98_304, 4_194_304);
  const maxFailures = boundedInteger(options.maxFailures, 20, 1, 1_000);
  const maxBatchesPerPoll = boundedInteger(options.maxBatchesPerPoll, 32, 1, 1_000);
  const pruneGraceSeconds = boundedInteger(options.pruneGraceSeconds, 3_600, 0, 604_800);
  const pruneLimit = boundedInteger(options.pruneLimit, 1_000, 1, 10_000);
  let running = false;
  let loopPromise: Promise<void> | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeWait: (() => void) | null = null;
  let lifecycleTail: Promise<void> = Promise.resolve();
  let drainTail: Promise<void> = Promise.resolve();
  const retiringKinds = new Set<HostExportKind>();

  const configuredConsumer = (kind: HostExportKind): string | null =>
    kind === "session_event"
      ? (options.eventSink?.consumerId ?? null)
      : (options.usageSink?.consumerId ?? null);

  const recordResult = (result: HostExportDrainResult, durationSeconds: number) => {
    const labels = { kind: result.kind, outcome: result.outcome };
    options.observability?.incrementCounter({
      name: "opengeni_host_export_batches_total",
      help: "Durable host export batch attempts by outcome.",
      labels,
    });
    options.observability?.observeHistogram({
      name: "opengeni_host_export_batch_duration_seconds",
      help: "Duration of durable host export batch attempts.",
      labels: { kind: result.kind },
      value: durationSeconds,
    });
    if (result.outcome === "delivered") {
      options.observability?.incrementCounter({
        name: "opengeni_host_export_records_total",
        help: "Durable host export records acknowledged by a host sink.",
        labels: { kind: result.kind },
        amount: result.count,
      });
      options.observability?.setGauge({
        name: "opengeni_host_export_consumer_blocked",
        help: "Whether the durable host export consumer is blocked.",
        labels: { kind: result.kind },
        value: 0,
      });
    } else if (result.outcome === "failed") {
      options.observability?.setGauge({
        name: "opengeni_host_export_consumer_blocked",
        help: "Whether the durable host export consumer is blocked.",
        labels: { kind: result.kind },
        value: result.blocked ? 1 : 0,
      });
    } else if (result.outcome === "blocked") {
      options.observability?.setGauge({
        name: "opengeni_host_export_consumer_blocked",
        help: "Whether the durable host export consumer is blocked.",
        labels: { kind: result.kind },
        value: 1,
      });
    }
  };

  const drainKind = async (kind: HostExportKind): Promise<HostExportDrainResult> => {
    if (retiringKinds.has(kind)) return { kind, outcome: "not_configured" };
    const startedAt = performance.now();
    const consumerId = configuredConsumer(kind);
    if (!consumerId) {
      const result: HostExportDrainResult = { kind, outcome: "not_configured" };
      recordResult(result, (performance.now() - startedAt) / 1_000);
      return result;
    }
    const leaseToken = crypto.randomUUID();
    const common = {
      consumerId,
      leaseToken,
      leaseHolderId: instanceId,
      leaseSeconds,
      limit: batchLimit,
      maxBytes: batchMaxBytes,
    };
    const settleFailure = async (error: unknown): Promise<HostExportDrainResult> => {
      const message = safeErrorMessage(error);
      let failures = 0;
      try {
        failures = await failHostExportBatch(options.db, {
          kind,
          consumerId,
          leaseToken,
          error: message,
          maxFailures,
        });
      } catch (settlementError) {
        options.observability?.warn("host export failure settlement was stale", {
          kind,
          consumerId,
          error: safeErrorMessage(settlementError),
        });
      }
      const blocked = failures >= maxFailures;
      options.observability?.warn("host export batch failed", {
        kind,
        consumerId,
        failures,
        blocked,
        error: message,
      });
      const result: HostExportDrainResult = {
        kind,
        outcome: "failed",
        failures,
        blocked,
      };
      recordResult(result, (performance.now() - startedAt) / 1_000);
      return result;
    };
    const deliverClaim = async (
      count: number,
      deliver: () => Promise<void>,
    ): Promise<HostExportDrainResult> => {
      await deliver();
      const throughCursor = await acknowledgeHostExportBatch(options.db, {
        kind,
        consumerId,
        leaseToken,
      });
      try {
        await pruneHostExportOutbox(options.db, {
          kind,
          graceSeconds: pruneGraceSeconds,
          limit: pruneLimit,
        });
      } catch (error) {
        // The sink and checkpoint are already committed. A retention failure
        // must be visible, but must never turn into a false delivery failure or
        // a duplicate settlement attempt for the now-stale lease.
        options.observability?.error("host export retention prune failed", {
          kind,
          consumerId,
          error: safeErrorMessage(error),
        });
      }
      const result: HostExportDrainResult = {
        kind,
        outcome: "delivered",
        count,
        throughCursor,
      };
      recordResult(result, (performance.now() - startedAt) / 1_000);
      return result;
    };

    try {
      if (kind === "session_event") {
        const sink = options.eventSink;
        if (!sink) return { kind, outcome: "not_configured" };
        const batch = await claimHostExportBatch(options.db, {
          kind,
          ...common,
        });
        if (batch) return await deliverClaim(batch.events.length, () => sink.deliverEvents(batch));
      } else {
        const sink = options.usageSink;
        if (!sink) return { kind, outcome: "not_configured" };
        const batch = await claimHostExportBatch(options.db, {
          kind,
          ...common,
        });
        if (batch) return await deliverClaim(batch.events.length, () => sink.deliverUsage(batch));
      }
    } catch (error) {
      return await settleFailure(error);
    }
    const status = await getHostExportConsumerStatus(options.db, {
      kind,
      consumerId,
    });
    if (status?.blockedAt) {
      const result: HostExportDrainResult = {
        kind,
        outcome: "blocked",
        failures: status.consecutiveFailures,
      };
      recordResult(result, (performance.now() - startedAt) / 1_000);
      return result;
    }
    const result: HostExportDrainResult = { kind, outcome: "idle" };
    recordResult(result, (performance.now() - startedAt) / 1_000);
    return result;
  };

  const drainConfiguredOnce = async (): Promise<HostExportDrainResult[]> => {
    const results: HostExportDrainResult[] = [];
    if (options.eventSink) results.push(await drainKind("session_event"));
    if (options.usageSink) results.push(await drainKind("usage_event"));
    return results;
  };

  const drainOnce = (): Promise<HostExportDrainResult[]> => {
    const next = drainTail.then(drainConfiguredOnce);
    drainTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const serializeLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = lifecycleTail.then(operation);
    lifecycleTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const waitForPoll = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      wakeWait = resolve;
      waitTimer = setTimeout(resolve, pollIntervalMs);
      waitTimer.unref?.();
    });
    wakeWait = null;
    if (waitTimer) clearTimeout(waitTimer);
    waitTimer = null;
  };

  return {
    start: () =>
      serializeLifecycle(async () => {
        if (running) return;
        await options.db.transaction(async (tx) => {
          const scoped = tx as unknown as Database;
          if (options.eventSink) {
            await registerHostExportConsumer(scoped, {
              kind: "session_event",
              consumerId: options.eventSink.consumerId,
            });
          }
          if (options.usageSink) {
            await registerHostExportConsumer(scoped, {
              kind: "usage_event",
              consumerId: options.usageSink.consumerId,
            });
          }
        });
        if (options.eventSink) retiringKinds.delete("session_event");
        if (options.usageSink) retiringKinds.delete("usage_event");
        running = true;
        loopPromise = (async () => {
          while (true) {
            if (!running) break;
            try {
              for (let batch = 0; batch < maxBatchesPerPoll; batch += 1) {
                if (!running) break;
                const results = await drainOnce();
                if (!results.some((result) => result.outcome === "delivered")) break;
              }
            } catch (error) {
              options.observability?.error("host export pump iteration failed", {
                error: safeErrorMessage(error),
              });
            }
            if (running) await waitForPoll();
          }
        })();
      }),
    stop: () =>
      serializeLifecycle(async () => {
        running = false;
        if (waitTimer) clearTimeout(waitTimer);
        wakeWait?.();
        await loopPromise;
        loopPromise = null;
      }),
    drainOnce,
    disable: async (kind) => {
      const consumerId = configuredConsumer(kind);
      if (!consumerId) throw new Error(`No ${kind} sink is configured`);
      await disableHostExportConsumer(options.db, { kind, consumerId });
    },
    retire: (kind) =>
      serializeLifecycle(async () => {
        if (running) throw new Error("Stop the host export pump before retiring a consumer");
        const consumerId = configuredConsumer(kind);
        if (!consumerId) throw new Error(`No ${kind} sink is configured`);
        retiringKinds.add(kind);
        try {
          await drainTail;
          await retireHostExportConsumer(options.db, { kind, consumerId });
        } catch (error) {
          retiringKinds.delete(kind);
          throw error;
        }
      }),
    status: async (kind) => {
      const consumerId = configuredConsumer(kind);
      if (!consumerId) return null;
      return await getHostExportConsumerStatus(options.db, {
        kind,
        consumerId,
      });
    },
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return candidate;
}

function validateInstanceId(value: string): string {
  if (value.length < 1 || value.length > 128) {
    throw new Error("Host export instanceId must contain 1 to 128 characters");
  }
  return value;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 500) || "host sink failed";
}
