import type { NativeBrokerOutputPage } from "./native-command-broker-output";
import type { NativeBrokerRequest } from "./native-command-broker-input";
import type {
  DurableNativeBrokerTransport,
  NativeBrokerRetainedInput,
} from "./native-command-broker-transport";
import { NativeBrokerFrameDecoder } from "./native-command-broker-wire";
import { nativeBrokerStdinChunkRequestId } from "./native-command-broker-stdin";

/** Exact authenticated initial-process channels, never TaskExec, guest files,
 * or ordinary command stdout. Provider implementations must dispatch writes
 * once, preserve AbortSignal and perform no invisible retry. */
export type NativeBrokerChannel = {
  readonly sandboxId: string;
  readonly taskId: string;
  write(
    input: { index: number; input: Uint8Array; eof: false },
    signal?: AbortSignal,
  ): Promise<void>;
  output(cursor: string, signal?: AbortSignal): AsyncIterable<NativeBrokerOutputPage>;
};

/** The caller can reconcile the exact journaled operation. This never grants
 * permission to allocate another request ID, index, command or launch. */
export class NativeBrokerDispatchUnknownError extends Error {
  constructor(
    readonly requestId: string,
    readonly inputIndex: number,
    cause: unknown,
  ) {
    super("Native broker input outcome is unknown; reconcile the original journaled request", {
      cause,
    });
    this.name = "NativeBrokerDispatchUnknownError";
  }
}

/** Physical transport composition only. Canonical command authority, initial
 * bootstrap provenance, qualified artifact and persisted command binding are
 * upstream gates. Merely constructing this driver does not confer them.
 *
 * One in-process input operation at a time; the database writer epoch owns
 * cross-process exclusion. Output observation remains independent so stdout
 * backpressure never queues cancellation behind an unbounded provider read.
 * No process/control/receipt is settled by this class. */
export class NativeBrokerDriver {
  private inputBusy = false;
  private writerEpoch: number | null = null;
  constructor(
    private readonly journal: DurableNativeBrokerTransport,
    private readonly channel: NativeBrokerChannel,
    private readonly writerId: string,
  ) {}

  private async identity() {
    const state = await this.journal.read();
    if (
      state.output.sandboxId !== this.channel.sandboxId ||
      state.output.taskId !== this.channel.taskId
    )
      throw new Error("Native broker physical channel does not match its durable binding");
    return state;
  }

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.inputBusy) throw new Error("Native broker input operation is already in progress");
    this.inputBusy = true;
    try {
      return await run();
    } finally {
      this.inputBusy = false;
    }
  }

  /** Renew/elect only. A takeover preserves old pending bytes and cannot send
   * a new fence until the broker has accepted those exact bytes. */
  async claimWriter() {
    await this.identity();
    return this.claim();
  }

  private async claim() {
    const writer = await this.journal.claimWriter(this.writerId);
    this.writerEpoch = writer.epoch;
    return writer;
  }

  /** Called only after the coordinator has joined its actual provider work.
   * An unacknowledged claim or a replaced owner is not ours to release. */
  async releaseWriter() {
    return this.exclusive(async () => {
      if (this.writerEpoch === null) return false;
      return this.journal.releaseWriter(this.writerId, this.writerEpoch);
    });
  }

  private async dispatch(
    epoch: number,
    requestId: string,
    signal?: AbortSignal,
    stdin?: NativeBrokerRetainedInput,
    stdinChunkOffset?: number,
  ) {
    signal?.throwIfAborted();
    const write = stdin
      ? stdinChunkOffset === undefined
        ? await this.journal.dispatchRetainedStdinIntent(this.writerId, epoch, stdin)
        : await this.journal.dispatchRetainedStdinChunkIntent(
            this.writerId,
            epoch,
            stdin,
            stdinChunkOffset,
          )
      : await this.journal.dispatchIntent(this.writerId, epoch, requestId);
    if (!write) return { state: "accepted" as const };
    try {
      // The intent is committed before this call. Even abort immediately after
      // commit leaves that exact intent pending, never manufactures non-dispatch.
      signal?.throwIfAborted();
      await this.channel.write(write, signal);
      await this.journal.providerAcknowledged(this.writerId, epoch, requestId);
      return { state: "provider_acknowledged" as const };
    } catch (error) {
      throw new NativeBrokerDispatchUnknownError(requestId, write.index, error);
    }
  }

  /** A chunk retains the ORIGINAL stdin admission. Its exact bytes are read
   * from the committed payload plan, never reconstructed from a replacement
   * caller body. Unknown physical dispatch is observed, not retried. */
  async sendRetainedStdinChunk(
    input: NativeBrokerRetainedInput,
    offset: number,
    signal?: AbortSignal,
  ) {
    input = { ...input };
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      await this.identity();
      const writer = await this.claim();
      const reserved = await this.journal.reserveRetainedStdinChunk(
        this.writerId,
        writer.epoch,
        input,
        offset,
      );
      const old = await this.journal.request(reserved.requestId);
      if (!old) throw new Error("Native broker reserved stdin chunk is absent");
      if (old.accepted) return { ...reserved, state: "accepted" as const };
      if (old.phase !== "reserved")
        return { ...reserved, state: "reconciliation_required" as const };
      return {
        ...reserved,
        ...(await this.dispatch(writer.epoch, reserved.requestId, signal, input, offset)),
      };
    });
  }

  /** One canonical stdin admission owns one bounded immutable payload. The DB
   * reserves its command byte offset and transport index in the same commit.
   * Re-entry never increments the offset or silently repeats physical input. */
  async sendRetainedStdin(
    input: NativeBrokerRetainedInput,
    payload: Uint8Array,
    signal?: AbortSignal,
  ) {
    input = { ...input };
    const bytes = Buffer.from(payload);
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      await this.identity();
      const writer = await this.claim();
      const reserved = await this.journal.reserveRetainedStdin(
        this.writerId,
        writer.epoch,
        input,
        bytes,
      );
      const old = await this.journal.request(input.admissionId);
      if (!old) throw new Error("Native broker reserved stdin is absent");
      if (old.accepted)
        return { state: "accepted" as const, index: reserved.index, offset: reserved.offset };
      if (old.phase !== "reserved")
        return {
          state: "reconciliation_required" as const,
          index: reserved.index,
          offset: reserved.offset,
        };
      return {
        ...(await this.dispatch(writer.epoch, input.admissionId, signal, input)),
        index: reserved.index,
        offset: reserved.offset,
      };
    });
  }

  /** A new reservation may be dispatched once. Re-entering a known request
   * inspects its durable phase without silently repeating a provider write. */
  async send(request: NativeBrokerRequest, signal?: AbortSignal, expectedEpoch?: number) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      await this.identity();
      const writer = await this.claim();
      if (expectedEpoch !== undefined && writer.epoch !== expectedEpoch)
        throw new Error("Native broker launch writer epoch changed before reservation");
      const reserved = await this.journal.reserve(this.writerId, writer.epoch, request);
      const old = await this.journal.request(request.requestId);
      if (!old) throw new Error("Native broker reserved request is absent");
      if (old.accepted) return { state: "accepted" as const, index: reserved.index };
      if (old.phase !== "reserved")
        return { state: "reconciliation_required" as const, index: reserved.index };
      return {
        ...(await this.dispatch(writer.epoch, request.requestId, signal)),
        index: reserved.index,
      };
    });
  }

  /** Explicit recovery for the protocol's qualified exact-last-input replay.
   * Inspect/capture available output first. Replay retains the original body,
   * epoch and provider index even after a writer takeover; it never skips an
   * unresolved input to send a newer fence. No automatic retry loop exists. */
  async replayPending(
    signal?: AbortSignal,
    stdin?: NativeBrokerRetainedInput,
    stdinChunkOffset?: number,
  ) {
    stdin = stdin ? { ...stdin } : undefined;
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      await this.identity();
      const writer = await this.claim();
      const state = await this.identity();
      if (!state.input.pending) return { state: "nothing_pending" as const };
      const decoder = new NativeBrokerFrameDecoder(state.input.brokerId);
      const frame = decoder.push(Buffer.from(state.input.pending.frameBase64, "base64"))[0];
      decoder.finish();
      if (!frame || frame.direction !== "request")
        throw new Error("Native broker pending input is corrupt");
      if (
        frame.kind === "stdin"
          ? !stdin ||
            (stdinChunkOffset === undefined
              ? stdin.admissionId
              : nativeBrokerStdinChunkRequestId(stdin.admissionId, stdinChunkOffset)) !==
              frame.requestId ||
            stdin.commandId !== frame.commandId
          : stdin !== undefined || stdinChunkOffset !== undefined
      )
        throw new Error("Native broker stdin recovery requires its exact retained admission");
      return this.dispatch(writer.epoch, frame.requestId, signal, stdin, stdinChunkOffset);
    });
  }

  /** One bounded provider observation; callers repeat for actual work, not a
   * busy background loop. Each page commits before requesting its successor.
   * A stale competing collector throws: caller restarts at the committed cursor.
   * Cancellation ends observation only, not the command or initial process. */
  async observe(signal?: AbortSignal, maxPages = 64) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 128)
      throw new Error("Native broker observation page bound is invalid");
    signal?.throwIfAborted();
    const state = await this.identity();
    if (state.output.providerEof) return { pages: 0, capturedFrames: 0, providerEof: true };
    let cursor = state.output.cursor,
      pages = 0,
      capturedFrames = 0,
      providerEof = false;
    for await (const page of this.channel.output(cursor, signal)) {
      signal?.throwIfAborted();
      const captured = await this.journal.captureOutput(cursor, page);
      cursor = captured.cursor;
      capturedFrames += captured.capturedFrames;
      pages++;
      providerEof = captured.providerEof;
      if (providerEof || pages >= maxPages) break;
    }
    return { pages, capturedFrames, providerEof };
  }
}
