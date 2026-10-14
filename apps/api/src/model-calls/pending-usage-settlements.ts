/**
 * Fast in-process retry for task usage receipts of attempt-authenticated
 * single model calls. Durable custody lives in the database, not here.
 *
 * Before dispatch, admission opens a durable pending marker for the call's
 * source identity (`model_call:<requestId>`). The provider response has
 * already been returned when settlement runs, so a failed settlement is never
 * fixed by calling the provider again:
 *
 * - the exact settlement is retained here and retried against the database
 *   with bounded backoff until it lands (no expiry, no silent eviction);
 * - the marker is fenced at once when possible, and any marker left unfilled
 *   (fenced, or older than the overdue window after a crash or on another
 *   replica) blocks new model requests for the whole task on every replica;
 * - maintenance discloses a marker that is never filled as an unpriced call,
 *   so coverage reads partial instead of complete.
 *
 * Settlement is idempotent on the source identity and fills the marker
 * exactly once, so a retry racing a slow original write records usage once.
 * When this process already retains `maxEntries` settlements it refuses new
 * task calls instead of dropping any.
 */
export type RetainedSettlement = () => Promise<unknown>;

export type PendingUsageSettlementsOptions = {
  /** Upper bound on retained settlements across all sessions. */
  maxEntries?: number;
  /** First background retry delay; doubles up to `maxDelayMs`. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Test hook; defaults to setTimeout with unref. */
  schedule?: (fn: () => void, delayMs: number) => void;
};

type Entry = {
  sessionId: string;
  settle: RetainedSettlement;
  delayMs: number;
  scheduled: boolean;
};

export class PendingUsageSettlements {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(private readonly options: PendingUsageSettlementsOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 1_000);
    this.initialDelayMs = Math.max(10, options.initialDelayMs ?? 1_000);
    this.maxDelayMs = Math.max(this.initialDelayMs, options.maxDelayMs ?? 60_000);
  }

  get size(): number {
    return this.entries.size;
  }

  /** True when no further settlement can be retained: new task calls are refused. */
  get full(): boolean {
    return this.entries.size >= this.maxEntries;
  }

  /** True when this session has a retained, not yet recorded settlement. */
  has(sessionId: string): boolean {
    for (const entry of this.entries.values()) if (entry.sessionId === sessionId) return true;
    return false;
  }

  /**
   * Retain a failed settlement for exact DB-only retry. Returns false only
   * when the process is already at capacity; the durable marker then remains
   * the custody (fenced or overdue, later disclosed as unpriced).
   */
  retain(sessionId: string, sourceId: string, settle: RetainedSettlement): boolean {
    const key = `${sessionId}\u0000${sourceId}`;
    if (this.entries.has(key)) return true;
    if (this.full) return false;
    const entry: Entry = { sessionId, settle, delayMs: this.initialDelayMs, scheduled: false };
    this.entries.set(key, entry);
    this.scheduleRetry(key, entry);
    return true;
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
