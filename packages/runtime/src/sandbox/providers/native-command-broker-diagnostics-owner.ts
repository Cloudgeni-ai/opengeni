import { setTimeout as delay } from "node:timers/promises";
import {
  inspectNativeBrokerInitialDiagnostics,
  NativeBrokerInitialDiagnosticsError,
  type NativeBrokerDiagnosticsChannel,
} from "./native-command-broker-diagnostics";
import type { DurableNativeBrokerTransport } from "./native-command-broker-transport";

/** Each query starts at the original stderr origin. A definite fault commits
 * before rejection; uncertainty and abort alone are not permanent faults.
 * Faults from another observer win even a concurrent clean query. */
export async function observeDurableNativeBrokerDiagnostics(
  journal: DurableNativeBrokerTransport,
  channel: NativeBrokerDiagnosticsChannel,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { output } = await journal.read();
  if (output.sandboxId !== channel.sandboxId || output.taskId !== channel.taskId)
    throw new Error("Native broker diagnostic channel changed physical identity");
  const old = await journal.diagnosticFault();
  if (old) throw new NativeBrokerInitialDiagnosticsError(old);
  let observation;
  try {
    observation = await inspectNativeBrokerInitialDiagnostics(channel, signal);
  } catch (error) {
    if (!(error instanceof NativeBrokerInitialDiagnosticsError)) throw error;
    const retained = await journal.recordDiagnosticFault(error.observation);
    throw new NativeBrokerInitialDiagnosticsError(retained);
  }
  const concurrent = await journal.diagnosticFault();
  if (concurrent) throw new NativeBrokerInitialDiagnosticsError(concurrent);
  signal?.throwIfAborted();
  return observation;
}

/** One explicitly owned observer for a physical broker. No read starts in the
 * constructor. Session surfaces hold a reference while attached; a work check
 * holds a temporary reference too. One query serves all overlapping checks.
 * Last release aborts AND joins its actual read; a new owner waits for that
 * cleanup before another query starts. No provider writes or exit inference.
 *
 * Definite faults stop periodic reads. Transient failures are retried only
 * while an owner remains, paced by a one-second gap after each bounded query.
 * A fresh work check never uses a cached clean result or suppresses an error.
 */
export class NativeBrokerDiagnosticsOwner {
  private readonly stopped = new AbortController();
  private readonly owners = new Set<symbol>();
  private checks = 0;
  private query: {
    controller: AbortController;
    result: Promise<void>;
    settled: Promise<void>;
  } | null = null;
  private loop: { controller: AbortController; settled: Promise<void> } | null = null;
  private fault: NativeBrokerInitialDiagnosticsError | null = null;

  constructor(
    private readonly journal: DurableNativeBrokerTransport,
    private readonly channel: NativeBrokerDiagnosticsChannel,
  ) {}

  private async inspect(): Promise<void> {
    this.stopped.signal.throwIfAborted();
    if (this.fault) throw this.fault;
    // A new owner must not borrow a cancelled predecessor's read or overlap
    // its still-unwinding provider iterator.
    if (this.query?.controller.signal.aborted) await this.query.settled;
    this.stopped.signal.throwIfAborted();
    if (!this.owners.size) throw new Error("Native broker diagnostics have no live owner");
    if (this.query) return this.query.result;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.stopped.signal]);
    const result = observeDurableNativeBrokerDiagnostics(this.journal, this.channel, signal)
      .then(() => {})
      .catch((error: unknown) => {
        // observeDurable... has already committed this exact first fault.
        if (error instanceof NativeBrokerInitialDiagnosticsError) this.fault = error;
        throw error;
      });
    const settled = result
      .catch(() => {})
      .finally(() => {
        if (this.query?.controller === controller) this.query = null;
      });
    this.query = { controller, result, settled };
    return result;
  }

  private startLoop() {
    if (this.loop || !this.owners.size || this.stopped.signal.aborted || this.fault) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.stopped.signal]);
    const run = async () => {
      while (this.owners.size && !this.fault) {
        signal.throwIfAborted();
        // Work checks observe the original result; the background owner must
        // join failures rather than leak an unhandled rejection.
        await this.inspect().catch(() => {});
        if (this.fault) return;
        await delay(1_000, undefined, { signal });
      }
    };
    const settled = run()
      .catch(() => {})
      .finally(() => {
        if (this.loop?.controller === controller) this.loop = null;
        this.startLoop();
      });
    this.loop = { controller, settled };
  }

  acquire(): () => Promise<void> {
    this.stopped.signal.throwIfAborted();
    const owner = Symbol();
    this.owners.add(owner);
    this.startLoop();
    const release = async () => {
      if (!this.owners.delete(owner) || this.owners.size) return;
      const loop = this.loop;
      const query = this.query;
      const reason = new Error("Native broker diagnostics have no remaining owners");
      loop?.controller.abort(reason);
      query?.controller.abort(reason);
      await Promise.all([loop?.settled, query?.settled]);
    };
    let released: Promise<void> | undefined;
    return () => (released ??= release());
  }

  /** Observation only, never bootstrap/command authority. Run before joining
   * the input queue so a slow diagnostics read cannot queue ahead of cancel. */
  async check(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.checks >= 128) throw new Error("Native broker diagnostics work queue is full");
    this.checks++;
    let release: (() => Promise<void>) | undefined;
    try {
      release = this.acquire();
      const result = this.inspect();
      if (!signal) await result;
      else
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          void result
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
          if (signal.aborted) abort();
        });
      signal?.throwIfAborted();
    } finally {
      this.checks--;
      await release?.();
    }
  }

  async close() {
    this.stopped.abort(new Error("Native broker diagnostics owner is closed"));
    this.owners.clear();
    await Promise.all([this.loop?.settled, this.query?.settled]);
  }
}
