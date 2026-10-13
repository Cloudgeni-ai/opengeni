/**
 * DB-only recovery for task usage receipts of attempt-authenticated single
 * model calls (OPE-798).
 *
 * The provider response has already been returned, so a failed settlement is
 * never fixed by calling the provider again. Instead the exact settlement is
 * retained in this process and retried against the database:
 *
 * - before this replica admits another call for the same session, every
 *   retained settlement of that session must succeed first (otherwise the
 *   call is refused as "usage unavailable", never admitted on an undercount);
 * - a background retry with bounded backoff lands it even when no further
 *   call arrives.
 *
 * Settlement is idempotent on the request's source identity, so a retry that
 * races a slow original write records the usage once. The fence is
 * per-process and bounded: a crash or eviction before recovery loses the
 * retained receipt (logged and counted), which is the documented gap.
 */
export type RetainedSettlement = () => Promise<unknown>;

export type PendingUsageSettlementsOptions = {
  /** Upper bound on retained settlements across all sessions. */
  maxEntries?: number;
  /** First background retry delay; doubles up to `maxDelayMs`. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Give up (and report) after this long. */
  maxAgeMs?: number;
  now?: () => number;
  onDropped?: (reason: "evicted" | "expired", sessionId: string) => void;
  /** Test hook; defaults to setTimeout with unref. */
  schedule?: (fn: () => void, delayMs: number) => void;
};

type Entry = {
  sessionId: string;
  settle: RetainedSettlement;
  firstFailedAt: number;
  delayMs: number;
  scheduled: boolean;
};

export class PendingUsageSettlements {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(private readonly options: PendingUsageSettlementsOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 1_000);
    this.initialDelayMs = Math.max(10, options.initialDelayMs ?? 1_000);
    this.maxDelayMs = Math.max(this.initialDelayMs, options.maxDelayMs ?? 60_000);
    this.maxAgeMs = Math.max(this.initialDelayMs, options.maxAgeMs ?? 60 * 60_000);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** True when this session has a retained, not yet recorded settlement. */
  has(sessionId: string): boolean {
    for (const entry of this.entries.values()) if (entry.sessionId === sessionId) return true;
    return false;
  }

  /** Retain a failed settlement for exact DB-only retry. */
  retain(sessionId: string, sourceId: string, settle: RetainedSettlement): void {
    const key = `${sessionId}\u0000${sourceId}`;
    if (this.entries.has(key)) return;
    while (this.entries.size >= this.maxEntries) {
      const [oldestKey, oldest] = this.entries.entries().next().value as [string, Entry];
      this.entries.delete(oldestKey);
      this.options.onDropped?.("evicted", oldest.sessionId);
    }
    const entry: Entry = {
      sessionId,
      settle,
      firstFailedAt: this.now(),
      delayMs: this.initialDelayMs,
      scheduled: false,
    };
    this.entries.set(key, entry);
    this.scheduleRetry(key, entry);
  }

  /**
   * Record every retained settlement of `sessionId`. Throws the first failure;
   * successful ones are removed either way.
   */
  async flush(sessionId: string): Promise<void> {
    let failure: unknown = null;
    for (const [key, entry] of [...this.entries]) {
      if (entry.sessionId !== sessionId) continue;
      try {
        await entry.settle();
        this.entries.delete(key);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
  }

  private scheduleRetry(key: string, entry: Entry): void {
    if (entry.scheduled) return;
    entry.scheduled = true;
    const run = async () => {
      entry.scheduled = false;
      if (this.entries.get(key) !== entry) return;
      try {
        await entry.settle();
        if (this.entries.get(key) === entry) this.entries.delete(key);
      } catch {
        if (this.entries.get(key) !== entry) return;
        if (this.now() - entry.firstFailedAt >= this.maxAgeMs) {
          this.entries.delete(key);
          this.options.onDropped?.("expired", entry.sessionId);
          return;
        }
        entry.delayMs = Math.min(this.maxDelayMs, entry.delayMs * 2);
        this.scheduleRetry(key, entry);
      }
    };
    const schedule =
      this.options.schedule ??
      ((fn: () => void, delayMs: number) => {
        const timer = setTimeout(fn, delayMs);
        (timer as { unref?: () => void }).unref?.();
      });
    schedule(() => void run(), entry.delayMs);
  }
}
