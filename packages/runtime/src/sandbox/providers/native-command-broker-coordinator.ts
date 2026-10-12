import { createHash } from "node:crypto";
import { z } from "zod";
import {
  nativeBrokerStdinChunkRequestId,
  NATIVE_BROKER_STDIN_MAX_BYTES,
} from "./native-command-broker-stdin";
import { setTimeout as delay } from "node:timers/promises";
import { NativeBrokerDriver, type NativeBrokerChannel } from "./native-command-broker-driver";
import { NativeBrokerDiagnosticsOwner } from "./native-command-broker-diagnostics-owner";
import type { NativeBrokerDiagnosticsChannel } from "./native-command-broker-diagnostics";
import { nativeBrokerRequestAllowsDiagnosticFault } from "./native-command-broker-transport";
import type { NativeBrokerRequest } from "./native-command-broker-input";
import {
  NativeBrokerFrameDecoder,
  NATIVE_BROKER_PAYLOAD_MAX_BYTES,
} from "./native-command-broker-wire";
import type {
  DurableNativeBrokerTransport,
  NativeBrokerRetainedInput,
} from "./native-command-broker-transport";

/** Only observation is bounded. Expiry never settles a command, clears an
 * input, authorizes replay or changes the command's execution lifetime. */
export class NativeBrokerReconciliationRequiredError extends Error {
  constructor(
    readonly requestId: string,
    cause?: unknown,
  ) {
    super("Native broker request requires reconciliation of its original durable identity", {
      cause,
    });
    this.name = "NativeBrokerReconciliationRequiredError";
  }
}

function operationId(parts: ReadonlyArray<string | number>): string {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x80;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Abort this waiter only. The original operation remains joined by its owner. */
function interested<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Shared host coordination for an ALREADY qualified and retained broker.
 * Construction grants no bootstrap, creation or command authority. All callers
 * sharing this physical instance must use the same coordinator; DB writer
 * epochs fence other hosts. Canonical process admission remains upstream.
 *
 * Input is serialized only through native acceptance, never command lifetime.
 * One demand-driven output reader commits each page before waking readers.
 * An unknown write is never replayed here, including after reconnection. The
 * separate driver's explicit recovery method remains an operator-owned action.
 * Closing disposes host observation only, never the sandbox or initial stdin.
 */
export class NativeBrokerCoordinator {
  private readonly driver: NativeBrokerDriver;
  private readonly diagnostics: NativeBrokerDiagnosticsOwner;
  private readonly stopped = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private waiters = 0;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private observationError: unknown;
  private pump: { controller: AbortController; settled: Promise<void> } | null = null;

  constructor(
    private readonly journal: DurableNativeBrokerTransport,
    private readonly channel: NativeBrokerChannel & NativeBrokerDiagnosticsChannel,
    writerId: string,
  ) {
    this.driver = new NativeBrokerDriver(journal, channel, writerId);
    this.diagnostics = new NativeBrokerDiagnosticsOwner(journal, channel);
  }

  /** One reference per attached session surface, independent of output waits.
   * The returned release joins the final shared diagnostics read. */
  retainDiagnostics() {
    this.stopped.signal.throwIfAborted();
    return this.diagnostics.acquire();
  }

  private signal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, this.stopped.signal]) : this.stopped.signal;
  }

  private notify() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private changed(version: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (version !== this.version) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        this.listeners.delete(changed);
        signal.removeEventListener("abort", aborted);
      };
      const changed = () => {
        finish();
        resolve();
      };
      const aborted = () => {
        finish();
        reject(signal.reason);
      };
      this.listeners.add(changed);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  private startPump() {
    if (this.pump || !this.waiters || this.stopped.signal.aborted || this.observationError) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.stopped.signal]);
    const run = async () => {
      while (this.waiters) {
        signal.throwIfAborted();
        const state = await this.journal.read();
        if (
          state.output.sandboxId !== this.channel.sandboxId ||
          state.output.taskId !== this.channel.taskId
        )
          throw new Error("Native broker collector changed physical identity");
        if (state.output.providerEof) return;
        let cursor = state.output.cursor,
          pages = 0;
        for await (const page of this.channel.output(cursor, signal)) {
          signal.throwIfAborted();
          const saved = await this.journal.captureOutput(cursor, page);
          cursor = saved.cursor;
          pages++;
          this.notify();
          if (saved.providerEof || !this.waiters) return;
        }
        // A real provider query normally waits server-side. A provider that
        // immediately completes an empty query must not create a busy loop.
        if (!pages) await delay(250, undefined, { signal });
      }
    };
    const settled = run()
      .catch((error: unknown) => {
        if (!signal.aborted) this.observationError = error;
      })
      .finally(() => {
        if (this.pump?.controller === controller) this.pump = null;
        this.notify();
      });
    this.pump = { controller, settled };
  }

  private async until<T>(read: () => Promise<T | undefined>, signal?: AbortSignal): Promise<T> {
    const bounded = this.signal(signal);
    bounded.throwIfAborted();
    this.waiters++;
    try {
      for (;;) {
        bounded.throwIfAborted();
        const version = this.version;
        const value = await read();
        bounded.throwIfAborted();
        if (value !== undefined) return value;
        if (this.observationError) throw this.observationError;
        if ((await this.journal.read()).output.providerEof)
          throw new Error(
            "Native broker initial output ended without the required command evidence",
          );
        this.startPump();
        await this.changed(version, bounded);
      }
    } finally {
      if (--this.waiters === 0)
        this.pump?.controller.abort(
          new Error("Native broker observation has no remaining waiters"),
        );
    }
  }

  private async accepted(requestId: string, signal: AbortSignal) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    try {
      return await this.until(async () => {
        const request = await this.journal.request(requestId);
        if (!request) throw new Error("Native broker acceptance target is not retained");
        return request.accepted ? request : undefined;
      }, bounded);
    } catch (cause) {
      throw new NativeBrokerReconciliationRequiredError(requestId, cause);
    }
  }

  private async exclusive<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    const bounded = this.signal(signal);
    bounded.throwIfAborted();
    if (this.queued >= 128) throw new Error("Native broker input queue is full");
    this.queued++;
    const previous = this.tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A cancelled queued call releases only its own slot. Its successor still
    // waits for every predecessor, including the current physical dispatch.
    this.tail = previous.then(() => gate);
    try {
      await interested(previous, bounded);
      bounded.throwIfAborted();
      return await run(bounded);
    } finally {
      this.queued--;
      release();
    }
  }

  private async ready(signal: AbortSignal, targetRequestId?: string) {
    let state = await this.journal.read();
    if (state.input.pending) {
      // Observe acceptance only; neither provider ACK nor elapsed time lets a
      // successor skip or rewrite the unresolved input.
      const pending = state.input.pending;
      const decoder = new NativeBrokerFrameDecoder(state.input.brokerId);
      const frames = decoder.push(Buffer.from(pending.frameBase64, "base64"));
      decoder.finish();
      const frame = frames[0];
      if (frames.length !== 1 || !frame || frame.direction !== "request")
        throw new Error("Native broker pending request is invalid");
      // The original never-dispatched reservation may enter its FIRST intent.
      // A sent/unknown request must instead obtain actual acceptance; this
      // coordinator never calls the driver's explicit physical replay method.
      if (frame.requestId === targetRequestId && pending.phase === "reserved")
        return this.driver.claimWriter();
      await this.accepted(frame.requestId, signal);
    }
    const writer = await this.driver.claimWriter();
    state = await this.journal.read();
    if (state.input.acceptedWriterEpoch !== writer.epoch) {
      const requestId = operationId([
        "native-broker-writer-fence-v1",
        state.input.brokerId,
        writer.epoch,
      ]);
      await this.driver.send(
        { requestId, commandId: null, kind: "fence", offset: 0, payload: new Uint8Array() },
        signal,
      );
      await this.accepted(requestId, signal);
    }
    return writer;
  }

  /** Election and one exact native fence, without permission to start work. */
  claimWriter(signal?: AbortSignal) {
    return this.exclusive((bounded) => this.ready(bounded), signal);
  }

  /** Retire only the already committed initial-output prefix. This is distinct
   * from a command's receipt ACK: it neither settles a command nor deletes the
   * durable journal. Call after useful collection progress, not recursively for
   * ACK-only replies. Unknown dispatch remains the original pending request. */
  acknowledgeOutput(signal?: AbortSignal) {
    return this.exclusive(async (bounded) => {
      const writer = await this.ready(bounded);
      const state = await this.journal.read();
      const sequence = state.output.lastSequence;
      if (!sequence) throw new Error("Cannot acknowledge an empty native broker output prefix");
      const requestId = operationId([
        "native-broker-output-ack-v1",
        state.input.brokerId,
        writer.epoch,
        sequence,
      ]);
      const sent = await this.driver.send(
        { requestId, commandId: null, kind: "ack", offset: sequence, payload: new Uint8Array() },
        bounded,
        writer.epoch,
      );
      await this.accepted(requestId, bounded);
      return { state: "accepted" as const, sequence, requestId, index: sent.index };
    }, signal);
  }

  async send(request: NativeBrokerRequest, signal?: AbortSignal, expectedEpoch?: number) {
    if (
      !(request.payload instanceof Uint8Array) ||
      request.payload.length > NATIVE_BROKER_PAYLOAD_MAX_BYTES
    )
      throw new Error("Native broker request payload exceeds its bound");
    const copy = { ...request, payload: Uint8Array.from(request.payload) };
    if (copy.kind === "fence") throw new Error("The native broker coordinator owns writer fences");
    if (!nativeBrokerRequestAllowsDiagnosticFault(copy))
      await this.diagnostics.check(this.signal(signal));
    return this.exclusive(async (bounded) => {
      await this.ready(bounded, copy.requestId);
      const sent = await this.driver.send(copy, bounded, expectedEpoch);
      await this.accepted(copy.requestId, bounded);
      return { state: "accepted" as const, index: sent.index };
    }, signal);
  }

  async sendRetainedStdin(
    input: NativeBrokerRetainedInput,
    payload: Uint8Array,
    signal?: AbortSignal,
  ) {
    if (
      !(payload instanceof Uint8Array) ||
      !payload.length ||
      payload.length > NATIVE_BROKER_STDIN_MAX_BYTES
    )
      throw new Error("Native broker stdin payload exceeds its bound");
    const copy = { ...input },
      bytes = Uint8Array.from(payload);
    if (bytes.length > NATIVE_BROKER_PAYLOAD_MAX_BYTES)
      return this.sendRetainedStdinPayload(copy, bytes, signal);
    await this.diagnostics.check(this.signal(signal));
    return this.exclusive(async (bounded) => {
      await this.ready(bounded, copy.admissionId);
      const sent = await this.driver.sendRetainedStdin(copy, bytes, bounded);
      await this.accepted(copy.admissionId, bounded);
      return { state: "accepted" as const, index: sent.index, offset: sent.offset };
    }, signal);
  }

  private async sendRetainedStdinPayload(
    input: NativeBrokerRetainedInput,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ) {
    const bounded = this.signal(signal);
    const release = this.retainDiagnostics();
    try {
      await this.diagnostics.check(bounded);
      const plan = await this.exclusive(async (current) => {
        const old = await this.journal.findRetainedStdinPlan(input, bytes);
        if (old) return old;
        const writer = await this.ready(current);
        return this.journal.prepareRetainedStdinPayload(writer.id!, writer.epoch, input, bytes);
      }, bounded);
      let index = 0;
      for (let offset = 0; offset < plan.byteLength; offset += NATIVE_BROKER_PAYLOAD_MAX_BYTES) {
        bounded.throwIfAborted();
        const requestId = nativeBrokerStdinChunkRequestId(input.admissionId, offset);
        const sent = await this.exclusive(async (current) => {
          const old = await this.journal.request(requestId);
          if (old?.accepted) {
            // Replay of the committed prefix must not wait for a later chunk's
            // still-reserved first dispatch. It sends nothing; the reply below
            // must separately prove the exact original bytes were delivered.
            const frame = old.frame;
            if (
              frame.kind !== "stdin" ||
              frame.commandId !== input.commandId ||
              frame.offset !== plan.offset + offset ||
              !Buffer.from(frame.payload).equals(
                bytes.subarray(offset, offset + NATIVE_BROKER_PAYLOAD_MAX_BYTES),
              )
            )
              throw new Error("Retained broker stdin prefix changed its original bytes");
            return {
              index: frame.sequence,
              offset: frame.offset,
              byteLength: frame.payload.length,
            };
          }
          await this.ready(current, requestId);
          const dispatched = await this.driver.sendRetainedStdinChunk(input, offset, current);
          await this.accepted(requestId, current);
          return dispatched;
        }, bounded);
        // Acceptance alone does not prove delivery to the command's stdin.
        // Do not hold the input queue while that command consumes its bytes:
        // cancellation and other commands must remain usable meanwhile.
        const reply = await this.reply(requestId, bounded);
        let delivered = false;
        try {
          delivered =
            reply.kind === "status" &&
            reply.offset === sent.offset + sent.byteLength &&
            z
              .object({ stdinWritten: z.literal(true) })
              .strict()
              .safeParse(
                JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.payload)),
              ).success;
        } catch {
          /* Preserve the original chunk on malformed or incomplete reply. */
        }
        if (!delivered) throw new NativeBrokerReconciliationRequiredError(requestId);
        index = sent.index;
      }
      return { state: "accepted" as const, index, offset: plan.offset };
    } finally {
      await release();
    }
  }

  /** Exact committed operation reply, independently of input acceptance. */
  async reply(requestId: string, signal?: AbortSignal) {
    const bounded = AbortSignal.any([this.signal(signal), AbortSignal.timeout(5_000)]);
    try {
      return await this.until(
        async () => (await this.journal.requestReply(requestId)) ?? undefined,
        bounded,
      );
    } catch (cause) {
      throw new NativeBrokerReconciliationRequiredError(requestId, cause);
    }
  }

  /** One committed prefix advance. Cancellation ends only this reader; another
   * active command or request keeps the shared collector alive. */
  async observeAfter(sequence: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new Error("Invalid native broker observation sequence");
    return this.until(async () => {
      const state = await this.journal.read();
      if (sequence > state.output.lastSequence)
        throw new Error("Native broker observation begins beyond retained output");
      return state.output.lastSequence > sequence || state.output.providerEof
        ? state.output
        : undefined;
    }, signal);
  }

  async close() {
    this.stopped.abort(new Error("Native broker coordinator is closed"));
    const pump = this.pump;
    await Promise.all([pump?.settled, this.tail, this.diagnostics.close()]);
  }
}
