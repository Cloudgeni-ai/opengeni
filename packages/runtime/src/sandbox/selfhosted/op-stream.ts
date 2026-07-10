// The op-stream EXEC client (op-stream protocol v1.1, server half; PROTOCOL.md
// + ENGINE-INTEGRATION.md step 6 in .agent/).
//
// Replaces the legacy monolithic exec request/reply with sequenced, acked,
// credit-flowed frames when the runner advertises `Capabilities.op_stream` AND
// the server flag is on. What it buys, in order of importance:
//
//   * ATTACH-NOT-RERUN (B1/B2): the op id is durable (`{tool_call_id}:{ordinal}`)
//     and OpStart is idempotent by it — a re-dispatched turn that re-executes the
//     same function_call COLLECTS the already-running/completed op instead of
//     re-running the command. The at-least-once re-run hazard dies here.
//   * No reply-size wall: output streams in ≤128 KiB frames; the runner retains
//     ring→spool for replay, and a too-big stream fails TYPED (OP_OVERFLOW with
//     exact counters), never silently truncated.
//   * Blip tolerance: a connection loss detaches, never kills; frames resume via
//     OpAttach replay (gap-triggered attach is a ROUTINE heal, incl. seq-0 loss).
//
// ACK POLICY (design delta Δ2, DESIGN-OPSTREAM-CLIENT.md): mid-op acks are
// CREDIT-ONLY — `OpAck{acked_seq: 0, credit_bytes: received_total + window}`.
// The runner FREES retained frames at acked_seq, and a re-dispatched consumer
// must reassemble from seq 0 (its predecessor's buffered bytes died with it),
// so no mid-op acked_seq > 0 is ever durably backed. Credit is an ABSOLUTE
// window replacement on the wire, so growing it keeps the child flowing while
// the runner retains everything (bounded by its ring+spool quotas — the honest
// output ceiling, typed when hit). The acked frontier advances exactly once,
// at the FINAL ack, after the consumed result is durable (the hard gate's
// ordering: result durable → journal persist → wire final ack — see
// `finalizeSettledOps`).
//
// Everything above the transport is unchanged: the caller builds the same
// `ExecRequest`, receives the same `ExecResponse` shape, and every failure is a
// `SelfhostedControlError` in the existing taxonomy so the fault renderer and
// the op observer behave identically across the transport swap.

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import {
  ControlRequest,
  ErrorCode,
  OpAck,
  OpChannel,
  OpFrame,
  OpLostReason,
  OpState,
  type ExecRequest,
  type ExecResponse,
  type OpExit,
  type OpStatus,
} from "@opengeni/agent-proto";
import {
  agentErrorToControlError,
  SelfhostedControlError,
  timeoutAgentError,
  type ControlRpc,
} from "./control-rpc";
import { selfhostedRetryBackoffMs, type SelfhostedRetryClock } from "./retry-policy";
import {
  opAckSubject,
  opFrameSubject,
  OpStreamUnavailableError,
  type OpStreamSubscription,
  type OpStreamTransport,
} from "./op-transport";

/** Initial send-credit window (bytes) when the caller does not size it. Matches
 *  the wire default OpStart advertises (~4 MiB). */
export const OP_STREAM_DEFAULT_WINDOW_BYTES = 4 * 1024 * 1024;
/** Cumulative-ack repetition cadence while an op is live (ruling M1: acks are
 *  best-effort and healed by repetition). */
export const OP_STREAM_ACK_INTERVAL_MS = 5_000;
/** Frame-silence threshold before the client starts probing with OpQuery. The
 *  runner emits Progress every 5s while an op is alive and quiet, so 30s of
 *  TOTAL silence means frames are not reaching us (or the op is gone). */
export const OP_STREAM_SILENCE_TIMEOUT_MS = 30_000;
/** How long a silent op is held open across a machine reconnect window before
 *  the client fails it typed (PROTOCOL liveness rule: hold ≤120s, then only a
 *  definitive answer fails the op). */
export const OP_STREAM_RECONNECT_HOLD_MS = 120_000;
/** Bound on stashed out-of-order frames per op (each ≤128 KiB payload). A gap
 *  that outgrows this is healed by attach-replay, not by buffering forever. */
const OP_STREAM_MAX_STASHED_FRAMES = 4_096;
/** OpStart DRAINING retry budget — mirrors the legacy exec's patient budget
 *  (retry-policy.ts): op start is not latency-critical and a saturated machine
 *  should queue, not fail. OpStart is idempotent by op id, so timeout blips are
 *  also safe to re-issue (unlike legacy exec) — same small bounded budget. */
const OP_START_DRAINING_MAX_RETRIES = 10;
const OP_START_BLIP_MAX_RETRIES = 3;

/**
 * The durable-resume journal the worker adapts onto Temporal (design delta Δ1:
 * the attach generation is `Info.currentAttemptScheduledTimestampMs` — strictly
 * monotonic across worker-death redispatches, which `Info.attempt` is NOT under
 * `maximumAttempts: 1`). `persistSettled` folds the op's settled frontier into
 * the activity heartbeat details and MUST complete before the wire final ack
 * (the durable-before-wire-ack gate); the default no-journal client (tests,
 * non-activity callers) uses generation "1" and skips persistence.
 */
export interface OpStreamJournal {
  /** The consumer's attach generation (u64 decimal string). */
  attachGeneration(): string;
  /** Durably record `opId` as settled at `exitSeq` BEFORE its final ack. */
  persistSettled(opId: string, exitSeq: string): void | Promise<void>;
}

export interface OpStreamExecClientDeps {
  workspaceId: string;
  agentId: string;
  /** The lease/active epoch every ControlRequest is fenced under. */
  epoch: number;
  /** The rpc request/reply seam (OpStart/OpQuery/OpAttach ride here). */
  controlRpc: ControlRpc;
  /** The rpc subject (`agent.<ws>.<id>.rpc`). */
  rpcSubject: string;
  /** The frame/ack seam (subscribe + publish). */
  transport: OpStreamTransport;
  journal?: OpStreamJournal;
  windowBytes?: number;
  /** Control-op round-trip timeout for OpStart/OpQuery/OpAttach (the SHORT
   *  control budget, not the exec deadline). */
  controlTimeoutMs: number;
  /** The retry clock (sleep + jitter), injected for deterministic tests. */
  retryClock: SelfhostedRetryClock;
  ackIntervalMs?: number;
  silenceTimeoutMs?: number;
  reconnectHoldMs?: number;
}

/** A completed op-stream exec: the legacy-shaped response plus the healing
 *  telemetry the session folds into its op observation. */
export interface OpStreamExecOutcome {
  response: ExecResponse;
  /** Attach/query heals that occurred after streaming began (gap replays,
   *  silence probes that re-attached). >0 marks the op `healed`. */
  heals: number;
  /** OpStart-level retries (draining/blip) before the op was accepted. */
  startRetries: number;
  /** Total reassembled Data payload bytes (the observer's replyBytes). */
  replyBytes: number;
}

/** One op settled but not yet final-acked (awaiting the turn's durable point). */
interface SettledOp {
  opId: string;
  exitSeq: string;
  generation: string;
}

const OP_CHANNEL_NAMES: Partial<Record<OpChannel, "stdout" | "stderr">> = {
  [OpChannel.OP_CHANNEL_STDOUT]: "stdout",
  [OpChannel.OP_CHANNEL_STDERR]: "stderr",
};

/**
 * The per-session op-stream exec client. One instance per `SelfhostedSession`;
 * `exec()` runs one op end-to-end; `finalizeSettledOps()` is the turn-end hook
 * that advances the acked frontier durably (journal) and then on the wire.
 */
export class OpStreamExecClient {
  private readonly deps: OpStreamExecClientDeps;
  private readonly settled: SettledOp[] = [];
  private readonly inFlight = new Set<string>();

  constructor(deps: OpStreamExecClientDeps) {
    this.deps = deps;
  }

  private generation(): string {
    return this.deps.journal?.attachGeneration() ?? "1";
  }

  /**
   * Run one exec over the op stream. `opId` is the durable id (B1) — a re-issue
   * with the same id attaches instead of re-running. `deadlineMs` is the exec
   * process budget (relative); the runner's enforcement is authoritative.
   * `wallMs` is the client-side give-up wall (deadline + reply grace).
   */
  async exec(
    opId: string,
    exec: ExecRequest,
    deadlineMs: number,
    wallMs: number,
  ): Promise<OpStreamExecOutcome> {
    if (this.inFlight.has(opId)) {
      throw new SelfhostedControlError({
        message: `op-stream exec: duplicate concurrent op id ${opId}`,
        code: ErrorCode.ERROR_CODE_PROTOCOL,
        reason: null,
        retryable: false,
      });
    }
    this.inFlight.add(opId);
    try {
      const consumer = new OpConsumer(this.deps, opId, this.generation());
      try {
        const outcome = await consumer.run(exec, deadlineMs, wallMs);
        this.settled.push({ opId, exitSeq: outcome.exitSeq, generation: consumer.generation });
        return outcome.outcome;
      } finally {
        consumer.teardown();
      }
    } finally {
      this.inFlight.delete(opId);
    }
  }

  /**
   * The turn-end durability hook (the hard gate's ordering): for every op whose
   * result the turn has durably consumed — (1) already true when this runs —
   * (2) persist the settled frontier to the journal, then (3) publish the wire
   * final ack (`acked_seq = exit_seq, final = true`), which licenses the runner
   * to GC the op. A kill between (2) and (3) is safe: the re-dispatched turn
   * does not re-execute a durably-recorded call, and the runner's retention TTL
   * reaps the never-final-acked op — no loss, bounded residue. Publish failures
   * are swallowed for the same reason.
   */
  async finalizeSettledOps(): Promise<void> {
    const ackSubject = opAckSubject(this.deps.workspaceId, this.deps.agentId);
    while (this.settled.length > 0) {
      // Non-null: length checked above (single-threaded event loop).
      const op = this.settled.shift() as SettledOp;
      await this.deps.journal?.persistSettled(op.opId, op.exitSeq);
      const ack = OpAck.encode({
        opId: op.opId,
        ackedSeq: op.exitSeq,
        creditBytes: "0",
        final: true,
        attachGeneration: op.generation,
      }).finish();
      try {
        await this.deps.transport.publish(ackSubject, ack);
      } catch {
        // Best-effort: the runner's retention TTL owns the fallback.
      }
    }
  }
}

/** Internal per-op consumer: subscription, reassembly, flow, liveness. */
class OpConsumer {
  private readonly deps: OpStreamExecClientDeps;
  private readonly opId: string;
  readonly generation: string;
  private readonly windowBytes: number;

  /** Highest contiguously APPLIED seq (frames start at 1; 0 = none yet). */
  private lastApplied = 0n;
  private readonly stash = new Map<bigint, OpFrame>();
  private readonly chunks: { stdout: Uint8Array[]; stderr: Uint8Array[] } = {
    stdout: [],
    stderr: [],
  };
  private receivedPayloadBytes = 0n;
  private creditAtLastAck = 0n;
  private exit: OpExit | undefined;
  private exitSeq: bigint | undefined;
  private heals = 0;
  private lastFrameAt: number;
  private silenceSince: number | undefined;
  private attachInFlight = false;
  private subscription: OpStreamSubscription | undefined;
  private ackTimer: ReturnType<typeof setInterval> | undefined;
  private settleResolve: (() => void) | undefined;
  private settleReject: ((error: unknown) => void) | undefined;
  private torn = false;

  constructor(deps: OpStreamExecClientDeps, opId: string, generation: string) {
    this.deps = deps;
    this.opId = opId;
    this.generation = generation;
    this.windowBytes = deps.windowBytes ?? OP_STREAM_DEFAULT_WINDOW_BYTES;
    this.lastFrameAt = Date.now();
  }

  private get ackIntervalMs(): number {
    return this.deps.ackIntervalMs ?? OP_STREAM_ACK_INTERVAL_MS;
  }
  private get silenceTimeoutMs(): number {
    return this.deps.silenceTimeoutMs ?? OP_STREAM_SILENCE_TIMEOUT_MS;
  }
  private get reconnectHoldMs(): number {
    return this.deps.reconnectHoldMs ?? OP_STREAM_RECONNECT_HOLD_MS;
  }

  teardown(): void {
    this.torn = true;
    if (this.ackTimer) {
      clearInterval(this.ackTimer);
      this.ackTimer = undefined;
    }
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  async run(
    exec: ExecRequest,
    deadlineMs: number,
    wallMs: number,
  ): Promise<{
    outcome: OpStreamExecOutcome;
    exitSeq: string;
  }> {
    // Subscription BEFORE OpStart (protocol invariant): no frame can be
    // published before the consumer exists on a healthy path.
    this.subscription = await this.deps.transport.subscribe(
      opFrameSubject(this.deps.workspaceId, this.deps.agentId, this.opId),
      (payload) => this.onFramePayload(payload),
    );

    const startRetries = await this.startOp(exec, deadlineMs);

    // The universal begin (B2): attach from our contiguous frontier under the
    // initial window — for a FRESH op that is seq 0 (replay nothing, start live
    // flow); for a KNOWN op (re-dispatch) it replays everything we do not hold.
    await this.attach(this.windowBytes);

    // Cumulative-ack repetition (M1) — the periodic leg.
    this.ackTimer = setInterval(() => {
      void this.sendAck();
    }, this.ackIntervalMs);

    const settled = new Promise<void>((resolve, reject) => {
      this.settleResolve = resolve;
      this.settleReject = reject;
    });
    const liveness = this.watchLiveness(wallMs);
    try {
      await Promise.race([settled, liveness.wall]);
    } finally {
      liveness.stop();
    }

    // Settled: the exit frame and every frame before it are applied.
    const exit = this.exit as OpExit;
    const exitSeq = this.exitSeq as bigint;
    this.verifyByteExact(exit);
    if (exit.failureCode) {
      throw runnerFailureToControlError(exit);
    }
    const stdout = concatChunks(this.chunks.stdout);
    const stderr = concatChunks(this.chunks.stderr);
    return {
      outcome: {
        response: {
          exitCode: exit.exitCode,
          stdout,
          stderr,
          timedOut: exit.timedOut,
          durationMs: exit.durationMs,
        },
        heals: this.heals,
        startRetries,
        replyBytes: stdout.byteLength + stderr.byteLength,
      },
      exitSeq: exitSeq.toString(),
    };
  }

  /** OpStart with the patient DRAINING budget and a small blip budget. OpStart
   *  is IDEMPOTENT BY OP ID (the request id), so a timed-out/never-sent start
   *  is safe to re-issue even though exec mutates — the runner either never saw
   *  it or answers the SAME op. The stable request id is what makes that true. */
  private async startOp(exec: ExecRequest, deadlineMs: number): Promise<number> {
    let drainingRetries = 0;
    let blipRetries = 0;
    for (;;) {
      try {
        const result = await this.controlOp(
          {
            $case: "opStart",
            opStart: {
              op: { $case: "exec", exec },
              windowBytes: String(this.windowBytes),
              // Absolute epoch deadline (the runner's clock decides the actual
              // budget; host clock skew shifts it — a known wire caveat).
              deadlineMs: deadlineMs > 0 ? String(Date.now() + deadlineMs) : "0",
              originId: this.deps.rpcSubject,
            },
          },
          this.opId,
        );
        if (result.$case !== "opStart") {
          throw protocolError(`op-stream start: unexpected result ${result.$case}`);
        }
        const status = result.opStart.status;
        if (!result.opStart.accepted) {
          throw this.refusedStart(status);
        }
        if (status?.state === OpState.OP_STATE_LOST) {
          throw lostToControlError(status);
        }
        return drainingRetries + blipRetries;
      } catch (error) {
        if (!(error instanceof SelfhostedControlError)) {
          throw error;
        }
        // A PROTOCOL/UNSUPPORTED refusal of the START ITSELF means the runner
        // does not speak op-stream (a capability/downgrade race — M8 latches
        // the transport per-op, and the legacy exec is the permanent fallback
        // wire form). The op provably never started, so falling back is safe.
        if (
          error.code === ErrorCode.ERROR_CODE_PROTOCOL ||
          error.code === ErrorCode.ERROR_CODE_UNSUPPORTED
        ) {
          throw new OpStreamUnavailableError(
            `the runner refused OpStart (${error.message}); falling back to the legacy exec`,
          );
        }
        const blip = error.reason === "agent_reconnecting" || error.neverSent;
        if (error.draining && drainingRetries < OP_START_DRAINING_MAX_RETRIES) {
          await this.deps.retryClock.sleep(
            selfhostedRetryBackoffMs(drainingRetries, this.deps.retryClock.jitter()),
          );
          drainingRetries += 1;
          continue;
        }
        if (blip && blipRetries < OP_START_BLIP_MAX_RETRIES) {
          await this.deps.retryClock.sleep(
            selfhostedRetryBackoffMs(blipRetries, this.deps.retryClock.jitter()),
          );
          blipRetries += 1;
          continue;
        }
        throw error;
      }
    }
  }

  private refusedStart(status: OpStatus | undefined): SelfhostedControlError {
    if (status?.state === OpState.OP_STATE_LOST) {
      return lostToControlError(status);
    }
    return protocolError("op-stream start: the runner refused the op without a typed reason");
  }

  /** One control op on the rpc subject; throws the mapped
   *  `SelfhostedControlError` on any AgentError. `requestId` is overridable
   *  because OpStart's REQUEST ID IS THE OP ID (its idempotency key) and must
   *  be STABLE across retries — every other op uses a fresh UUID per attempt. */
  private async controlOp(
    op: NonNullable<ControlRequest["op"]>,
    requestId: string = crypto.randomUUID(),
  ) {
    const res = await this.deps.controlRpc.request(
      this.deps.rpcSubject,
      { requestId, epoch: this.deps.epoch, op },
      { timeoutMs: this.deps.controlTimeoutMs },
    );
    if (res.error || !res.result) {
      throw agentErrorToControlError(
        res.error ?? {
          code: ErrorCode.ERROR_CODE_PROTOCOL,
          message: "agent returned an empty control response",
          retryable: false,
          detail: {},
        },
      );
    }
    return res.result;
  }

  /** OpAttach from the contiguous frontier. `windowBytes` sizes the fresh
   *  replay window; 0 = reuse the OpStart grant (the gap-heal path). */
  private async attach(windowBytes: number): Promise<OpStatus> {
    const result = await this.controlOp({
      $case: "opAttach",
      opAttach: {
        opId: this.opId,
        fromSeq: this.lastApplied.toString(),
        attachGeneration: this.generation,
        windowBytes: String(windowBytes),
      },
    });
    if (result.$case !== "opStatus") {
      throw protocolError(`op-stream attach: unexpected result ${result.$case}`);
    }
    if (result.opStatus.state === OpState.OP_STATE_LOST) {
      throw lostToControlError(result.opStatus);
    }
    return result.opStatus;
  }

  /** Gap/silence heal: one re-attach in flight at a time; each success counts
   *  as a heal (the observer's `healed` breadcrumb). Failures are left to the
   *  liveness watcher — a dead link fails typed there, not here. */
  private requestAttachHeal(): void {
    if (this.attachInFlight || this.torn) {
      return;
    }
    this.attachInFlight = true;
    void this.attach(0)
      .then(() => {
        this.heals += 1;
      })
      .catch((error) => {
        if (error instanceof SelfhostedControlError && !error.retryable && !error.agentOffline) {
          this.settleReject?.(error);
        }
      })
      .finally(() => {
        this.attachInFlight = false;
      });
  }

  private onFramePayload(payload: Uint8Array): void {
    let frame: OpFrame;
    try {
      frame = OpFrame.decode(payload);
    } catch {
      // A torn frame never kills the subscription; the seq gap it leaves is
      // healed by attach-replay.
      return;
    }
    if (frame.opId !== this.opId) {
      return;
    }
    this.lastFrameAt = Date.now();
    this.silenceSince = undefined;
    const seq = BigInt(frame.seq);
    if (seq <= this.lastApplied) {
      return; // Duplicate (re-delivery / replay overlap) — reassembly is seq-idempotent.
    }
    if (seq !== this.lastApplied + 1n) {
      // Out of order: stash and ask for the gap. Replay heals from the frontier,
      // so an overgrown stash is dropped, not grown without bound.
      if (this.stash.size < OP_STREAM_MAX_STASHED_FRAMES) {
        this.stash.set(seq, frame);
      }
      this.requestAttachHeal();
      return;
    }
    this.applyFrame(frame);
    // Drain any stashed continuation.
    for (;;) {
      const next = this.stash.get(this.lastApplied + 1n);
      if (!next) {
        break;
      }
      this.stash.delete(this.lastApplied + 1n);
      this.applyFrame(next);
    }
    this.maybeSettle();
    this.maybeGrantCredit();
  }

  private applyFrame(frame: OpFrame): void {
    this.lastApplied = BigInt(frame.seq);
    const body = frame.body;
    if (!body) {
      return;
    }
    switch (body.$case) {
      case "data": {
        const channel = OP_CHANNEL_NAMES[body.data.channel];
        if (channel) {
          this.chunks[channel].push(body.data.bytes);
        }
        this.receivedPayloadBytes += BigInt(body.data.bytes.byteLength);
        break;
      }
      case "progress":
        // A liveness tick; echo our cumulative ack (M1's on-progress leg).
        void this.sendAck();
        break;
      case "exit":
        this.exit = body.exit;
        this.exitSeq = BigInt(frame.seq);
        break;
    }
  }

  private maybeSettle(): void {
    if (this.exitSeq !== undefined && this.lastApplied >= this.exitSeq) {
      this.settleResolve?.();
    }
  }

  /** Prompt credit replenishment: the periodic ack alone would stall a fast
   *  child for up to the ack interval each window; grant as soon as half the
   *  window has been consumed since the last grant. */
  private maybeGrantCredit(): void {
    if (this.receivedPayloadBytes - this.creditAtLastAck >= BigInt(this.windowBytes) / 2n) {
      void this.sendAck();
    }
  }

  /** The mid-op cumulative ack: CREDIT-ONLY (Δ2 — acked_seq stays 0 so the
   *  runner retains every frame for a possible successor consumer; the credit
   *  is an absolute replacement sized to keep ~one window of live headroom). */
  private async sendAck(): Promise<void> {
    if (this.torn) {
      return;
    }
    this.creditAtLastAck = this.receivedPayloadBytes;
    const ack = OpAck.encode({
      opId: this.opId,
      ackedSeq: "0",
      creditBytes: (this.receivedPayloadBytes + BigInt(this.windowBytes)).toString(),
      final: false,
      attachGeneration: this.generation,
    }).finish();
    try {
      await this.deps.transport.publish(
        opAckSubject(this.deps.workspaceId, this.deps.agentId),
        ack,
      );
    } catch {
      // Acks are best-effort and healed by repetition (M1).
    }
  }

  /**
   * The liveness watcher: probes a silent op with OpQuery, re-attaches when the
   * runner is ahead of us (frames lost in flight), holds a quiet-but-alive op
   * open through the reconnect window, and enforces the client-side wall.
   * Resolves only by rejection (typed failure) or by `stop()` at settle.
   */
  private watchLiveness(wallMs: number): { wall: Promise<never>; stop: () => void } {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wall = new Promise<never>((_, reject) => {
      const startedAt = Date.now();
      const tick = async () => {
        if (stopped) {
          return;
        }
        try {
          if (Date.now() - startedAt >= wallMs) {
            // The runner enforces the exec deadline and emits Exit{timed_out};
            // reaching OUR wall means even that terminal frame never arrived —
            // the same ambiguity as a legacy reply timeout, surfaced the same.
            reject(agentErrorToControlError(timeoutAgentError()));
            return;
          }
          if (Date.now() - this.lastFrameAt >= this.silenceTimeoutMs) {
            await this.probeSilence(reject);
          }
        } catch (error) {
          reject(error);
          return;
        }
        timer = setTimeout(tick, Math.min(this.silenceTimeoutMs / 3, 2_500));
      };
      timer = setTimeout(tick, Math.min(this.silenceTimeoutMs / 3, 2_500));
    });
    return {
      wall,
      stop: () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
        }
      },
    };
  }

  /** One silence probe: OpQuery the op; a definitive answer acts, an offline /
   *  blip answer holds through the reconnect window, then fails typed. */
  private async probeSilence(reject: (error: unknown) => void): Promise<void> {
    this.silenceSince ??= Date.now();
    try {
      const result = await this.controlOp({ $case: "opQuery", opQuery: { opId: this.opId } });
      if (result.$case !== "opStatus") {
        throw protocolError(`op-stream query: unexpected result ${result.$case}`);
      }
      const status = result.opStatus;
      if (status.state === OpState.OP_STATE_LOST) {
        reject(lostToControlError(status));
        return;
      }
      // Alive on the runner. If it is ahead of our frontier, frames were lost
      // in flight — re-attach to replay them (this also restores live flow
      // after a reconnect). A quiet-but-current op just keeps holding.
      if (BigInt(status.nextSeq) > this.lastApplied + 1n) {
        this.requestAttachHeal();
      }
    } catch (error) {
      if (!(error instanceof SelfhostedControlError)) {
        throw error;
      }
      const transient =
        error.agentOffline || error.reason === "agent_reconnecting" || error.draining;
      if (!transient) {
        throw error;
      }
      const heldFor = Date.now() - (this.silenceSince ?? Date.now());
      if (heldFor >= this.reconnectHoldMs) {
        // The hold window expired without the machine coming back — surface
        // the LAST probe's typed error (offline/reconnecting), same taxonomy
        // as the legacy path.
        reject(error);
      }
      // Otherwise: keep holding — op ⊥ connection (the runner keeps the child
      // running and retains its output through the blip).
    }
  }

  /** Byte-exactness proof: totals AND blake3 digests of the reassembled
   *  channels must match the runner's Exit record exactly. */
  private verifyByteExact(exit: OpExit): void {
    for (const channel of ["stdout", "stderr"] as const) {
      const bytes = concatChunks(this.chunks[channel]);
      const declaredTotal = exit.totals[channel];
      if (declaredTotal !== undefined && BigInt(declaredTotal) !== BigInt(bytes.byteLength)) {
        throw protocolError(
          `op-stream reassembly: ${channel} total mismatch (got ${bytes.byteLength}, ` +
            `runner declared ${declaredTotal})`,
        );
      }
      const declaredDigest = exit.digests[channel];
      if (declaredDigest) {
        const digest = bytesToHex(blake3(bytes));
        if (digest !== declaredDigest) {
          throw protocolError(
            `op-stream reassembly: ${channel} digest mismatch (got ${digest}, ` +
              `runner declared ${declaredDigest})`,
          );
        }
      }
    }
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function protocolError(message: string): SelfhostedControlError {
  return new SelfhostedControlError({
    message,
    code: ErrorCode.ERROR_CODE_PROTOCOL,
    reason: null,
    retryable: false,
  });
}

/** A definitive `lost` status → a typed op-level failure. The result was
 *  bounded-retention collateral (LRU eviction / a runner restart predating the
 *  persistence milestone) — honest, never silent. */
function lostToControlError(status: OpStatus): SelfhostedControlError {
  const reason =
    status.lostReason === OpLostReason.OP_LOST_REASON_EVICTED
      ? "its retained result was evicted before collection"
      : status.lostReason === OpLostReason.OP_LOST_REASON_AGENT_RESTARTED
        ? "the machine agent restarted and the op did not survive"
        : "the runner reported it lost";
  return new SelfhostedControlError({
    message:
      `The command's result is no longer available on the machine (${reason}). ` +
      "Check whether its effects already took place before re-running it.",
    code: ErrorCode.ERROR_CODE_STREAM,
    reason: null,
    retryable: false,
    detail: { lost_reason: String(status.lostReason) },
  });
}

/**
 * A runner-typed terminal failure (OpExit.failure_code — OP_OVERFLOW /
 * OP_SPOOL_IO / OP_PIPE_IO; never an exit-code sentinel). OP_OVERFLOW maps to
 * the PAYLOAD_TOO_LARGE taxonomy: the semantics differ (retention quota vs
 * reply size) but the model's correct next action is identical — bound the
 * output, redirect to a file, read it back in ranges — so it gets the same
 * actionable rendering, with the runner's exact counters in the detail.
 */
function runnerFailureToControlError(exit: OpExit): SelfhostedControlError {
  if (exit.failureCode === "OP_OVERFLOW") {
    return new SelfhostedControlError({
      message:
        "The command produced more output than the machine link can retain for delivery. " +
        "Redirect the command's output to a file (for example `<command> > /tmp/out.log 2>&1`) " +
        "and then read that file back in ranges or chunks instead of returning it all at once.",
      code: ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
      reason: null,
      retryable: false,
      payloadTooLarge: true,
      detail: exit.failureDetail,
    });
  }
  return new SelfhostedControlError({
    message:
      `The command failed on the machine's streaming transport (${exit.failureCode}). ` +
      "The machine kept running it, but its output could not be captured intact.",
    code: ErrorCode.ERROR_CODE_STREAM,
    reason: null,
    retryable: false,
    detail: { ...exit.failureDetail, failure_code: exit.failureCode },
  });
}
