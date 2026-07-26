// Test doubles for the op-stream exec client (op-stream.ts): an in-memory
// transport and a scripted FAKE RUNNER that emulates the Rust runner's
// protocol behavior faithfully enough to exercise every client path —
// idempotent OpStart (dedup by op id, never re-runs), attach replay from
// retention, live-emission fault injection (drops / duplicates / reordering),
// OpQuery status, typed lost states, and DRAINING admission. The runner's own
// half is proven by its Rust harness (the E-scenarios); this double exists so
// the CLIENT's reassembly/heal/ack logic is unit-testable with no broker and
// no binary, deterministically.
//
// Emission model (mirrors the real runner): frames live in RETENTION the
// moment they exist. With `live: false` (the default) the op is already
// COMPLETE at start — the client's initial attach replays everything (the
// completed-op collection path, incl. re-dispatch attach-not-rerun). With
// `live: true` the first attach replays nothing and triggers the LIVE
// emission with the fault filters applied (drops/dups/reordering); any LATER
// attach is a heal and replays from retention unfiltered — exactly how the
// runner's ring/spool heals what the wire mangled.

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import {
  ControlRequest,
  ControlResponse,
  ErrorCode,
  OpAck,
  OpChannel,
  OpFrame,
  OpLostReason,
  OpState,
  type AgentError,
  type OpExit,
  type OpStatus,
} from "@opengeni/agent-proto";
import type { ControlRpc } from "./control-rpc";
import {
  opFrameSubject,
  OpStreamUnavailableError,
  type OpStreamSubscription,
  type OpStreamTransport,
} from "./op-transport";

/**
 * An in-memory `OpStreamTransport`: subscriptions are a subject→handler map,
 * and everything the CLIENT publishes (its acks) is recorded for assertions
 * and mirrored to `onPublish` (the fake runner's ack intake). `available =
 * false` makes both primitives throw `OpStreamUnavailableError` — the
 * legacy-fallback path.
 */
export class InMemoryOpStreamTransport implements OpStreamTransport {
  available = true;
  readonly published: Array<{ subject: string; payload: Uint8Array }> = [];
  onPublish: ((subject: string, payload: Uint8Array) => void) | undefined;
  private readonly handlers = new Map<string, Set<(payload: Uint8Array) => void>>();

  async subscribe(
    subject: string,
    onMessage: (payload: Uint8Array) => void,
  ): Promise<OpStreamSubscription> {
    if (!this.available) {
      throw new OpStreamUnavailableError("in-memory transport marked unavailable");
    }
    let set = this.handlers.get(subject);
    if (!set) {
      set = new Set();
      this.handlers.set(subject, set);
    }
    set.add(onMessage);
    return {
      unsubscribe: () => {
        set.delete(onMessage);
      },
    };
  }

  async publish(subject: string, payload: Uint8Array): Promise<void> {
    if (!this.available) {
      throw new OpStreamUnavailableError("in-memory transport marked unavailable");
    }
    this.published.push({ subject, payload });
    this.onPublish?.(subject, payload);
  }

  /** Deliver a payload to the subject's subscribers (the runner→client leg). */
  deliver(subject: string, payload: Uint8Array): void {
    for (const handler of this.handlers.get(subject) ?? []) {
      handler(payload);
    }
  }

  /** Every OpAck the client published, decoded, in publish order. */
  decodedAcks(): OpAck[] {
    return this.published.map(({ payload }) => OpAck.decode(payload));
  }
}

/** One scripted data frame (the exit frame is synthesized from `exit`). */
export interface FakeOpDataFrame {
  channel: "stdout" | "stderr";
  bytes: Uint8Array | string;
}

export interface FakeOpScript {
  /** Data/progress frames in emission order (seq 1..N; the exit takes N+1). */
  frames: Array<FakeOpDataFrame | "progress">;
  /** Exit overrides (exitCode/timedOut/failureCode/…). Digests and totals are
   *  computed from the scripted data frames unless overridden. */
  exit?: Partial<OpExit>;
  /** LIVE mode: the first attach replays nothing and triggers the (faulty)
   *  live emission; later attaches replay from retention unfiltered. Default
   *  false = the op is COMPLETE at start (pure collection). */
  live?: boolean;
  /** Keep a live op RUNNING with no frames until OpCancel is received. */
  holdUntilCancel?: boolean;
  /** Seqs whose LIVE emission is dropped (retention keeps them). */
  dropLiveSeqs?: ReadonlySet<number>;
  /** Seqs whose LIVE emission is duplicated (delivered twice back-to-back). */
  duplicateLiveSeqs?: ReadonlySet<number>;
  /** Swap each adjacent live pair (1,2 → 2,1) to exercise the stash path. */
  reorderLivePairs?: boolean;
  /** The first N OpStarts answer a DRAINING AgentError (admission pressure). */
  drainingStarts?: number;
  /** Refuse every OpStart with this error (e.g. a PROTOCOL refusal from a
   *  runner that does not speak op-stream — the legacy-fallback race). */
  startError?: AgentError;
}

interface FakeOpRun {
  script: FakeOpScript;
  frames: OpFrame[];
  exitSeq: bigint;
  exit: OpExit;
  startCount: number;
  attachCount: number;
  drainingRemaining: number;
  liveEmitted: boolean;
  finalAcked: boolean;
  acks: OpAck[];
  highestGeneration: bigint;
}

const encoder = new TextEncoder();

/**
 * The scripted fake runner: a `ControlRpc` that answers the op-stream control
 * ops and emits frames through an `InMemoryOpStreamTransport`. Non-op-stream
 * requests are delegated to `fallback` (a `MockAgentResponder`) so the
 * legacy-fallback path is testable through the same instance.
 */
export class FakeOpRunner implements ControlRpc {
  private readonly transport: InMemoryOpStreamTransport;
  private readonly fallback: ControlRpc | undefined;
  private readonly workspaceId: string;
  private readonly agentId: string;
  private readonly scripts = new Map<string, FakeOpScript>();
  readonly runs = new Map<string, FakeOpRun>();
  /** Op ids that answer LOST (evicted) on query/attach — bounded-retention
   *  collateral. */
  readonly lostOps = new Set<string>();
  private readonly cancelledBeforeStart = new Set<string>();

  constructor(opts: {
    transport: InMemoryOpStreamTransport;
    workspaceId: string;
    agentId: string;
    /** Handles every non-op-stream ControlRequest (the legacy ops). */
    fallback?: ControlRpc;
  }) {
    this.transport = opts.transport;
    this.workspaceId = opts.workspaceId;
    this.agentId = opts.agentId;
    this.fallback = opts.fallback;
    this.transport.onPublish = (_subject, payload) => this.onAck(payload);
  }

  /** Script the op the NEXT OpStart with this id will run. */
  script(opId: string, script: FakeOpScript): void {
    this.scripts.set(opId, script);
  }

  private onAck(payload: Uint8Array): void {
    let ack: OpAck;
    try {
      ack = OpAck.decode(payload);
    } catch {
      return;
    }
    const run = this.runs.get(ack.opId);
    if (!run) {
      return;
    }
    // Generation fencing exactly like the runner: only the highest generation
    // seen has any effect; `final` is honored only when it covers the exit.
    const generation = BigInt(ack.attachGeneration);
    if (generation < run.highestGeneration) {
      return;
    }
    run.acks.push(ack);
    if (ack.final && BigInt(ack.ackedSeq) >= run.exitSeq) {
      run.finalAcked = true;
    }
  }

  async request(
    subject: string,
    req: ControlRequest,
    opts: { timeoutMs: number },
  ): Promise<ControlResponse> {
    const op = req.op;
    if (!op) {
      return errorResponse(req.requestId, ErrorCode.ERROR_CODE_PROTOCOL, "no op");
    }
    switch (op.$case) {
      case "opStart":
        return this.handleStart(req.requestId);
      case "opAttach":
        return this.handleAttach(
          req.requestId,
          op.opAttach.opId,
          BigInt(op.opAttach.fromSeq),
          op.opAttach.attachGeneration,
        );
      case "opQuery":
        return this.handleQuery(req.requestId, op.opQuery.opId);
      case "opCancel":
        return this.handleCancel(req.requestId, op.opCancel.opId);
      default: {
        if (this.fallback) {
          return this.fallback.request(subject, req, opts);
        }
        return errorResponse(
          req.requestId,
          ErrorCode.ERROR_CODE_UNSUPPORTED,
          `fake runner: unscripted op ${op.$case}`,
        );
      }
    }
  }

  private handleStart(opId: string): ControlResponse {
    if (this.cancelledBeforeStart.has(opId)) {
      return startResponse(opId, cancelledStatus(opId), false);
    }
    const existing = this.runs.get(opId);
    if (existing) {
      // IDEMPOTENT BY OP ID: a known op answers its current status and NEVER
      // re-runs (the whole point of B1).
      existing.startCount += 1;
      return startResponse(opId, this.statusOf(opId, existing));
    }
    const script = this.scripts.get(opId);
    if (!script) {
      return errorResponse(
        opId,
        ErrorCode.ERROR_CODE_PROTOCOL,
        `fake runner: no script for op ${opId}`,
      );
    }
    if (script.startError) {
      return { requestId: opId, error: script.startError, result: undefined };
    }
    const pending = this.scripts.get(opId) as FakeOpScript;
    if ((pending.drainingStarts ?? 0) > 0) {
      // Admission pressure: count down across retries of the un-admitted op.
      this.scripts.set(opId, { ...pending, drainingStarts: (pending.drainingStarts ?? 0) - 1 });
      return {
        requestId: opId,
        error: {
          code: ErrorCode.ERROR_CODE_DRAINING,
          message: "fake runner: admission pool full",
          retryable: true,
          detail: {},
        },
        result: undefined,
      };
    }
    const run = this.buildRun(opId, this.scripts.get(opId) as FakeOpScript);
    run.startCount = 1;
    this.runs.set(opId, run);
    return startResponse(opId, this.statusOf(opId, run));
  }

  private handleAttach(
    requestId: string,
    opId: string,
    fromSeq: bigint,
    generation: string,
  ): ControlResponse {
    if (this.lostOps.has(opId)) {
      return statusOnly(requestId, lostStatus(opId));
    }
    const run = this.runs.get(opId);
    if (!run) {
      return statusOnly(requestId, lostStatus(opId));
    }
    run.attachCount += 1;
    const attachGeneration = BigInt(generation);
    if (attachGeneration > run.highestGeneration) {
      run.highestGeneration = attachGeneration;
    }
    const subject = opFrameSubject(this.workspaceId, this.agentId, opId);
    if (run.script.live && !run.liveEmitted) {
      // First attach on a live op: nothing retained yet worth replaying — the
      // child "runs now" and the (faulty) live flow begins.
      if (!run.script.holdUntilCancel) this.emitLive(opId, run, subject);
      return statusOnly(requestId, this.statusOf(opId, run));
    }
    // A heal (or completed-op collection): replay from RETENTION — every frame
    // > fromSeq, in order, NO fault injection (the runner's ring/spool holds
    // them all under the credit-only ack policy).
    const replay = run.frames.filter((frame) => BigInt(frame.seq) > fromSeq);
    queueMicrotask(() => {
      for (const frame of replay) {
        this.transport.deliver(subject, OpFrame.encode(frame).finish());
      }
    });
    return statusOnly(requestId, this.statusOf(opId, run));
  }

  private handleQuery(requestId: string, opId: string): ControlResponse {
    if (this.lostOps.has(opId)) {
      return statusOnly(requestId, lostStatus(opId));
    }
    const run = this.runs.get(opId);
    if (!run) {
      return statusOnly(requestId, lostStatus(opId));
    }
    return statusOnly(requestId, this.statusOf(opId, run));
  }

  private handleCancel(requestId: string, opId: string): ControlResponse {
    const run = this.runs.get(opId);
    if (!run) {
      this.cancelledBeforeStart.add(opId);
      return statusOnly(requestId, cancelledStatus(opId));
    }
    if (!run.liveEmitted && run.script.holdUntilCancel) {
      run.exit.exitCode = -1;
      run.exit.cancelled = true;
      run.liveEmitted = true;
      const subject = opFrameSubject(this.workspaceId, this.agentId, opId);
      queueMicrotask(() => {
        for (const frame of run.frames) {
          this.transport.deliver(subject, OpFrame.encode(frame).finish());
        }
      });
    }
    return statusOnly(requestId, this.statusOf(opId, run));
  }

  /** The LIVE flow: fault filters applied (drops, duplicates, adjacent
   *  reordering); retention still holds every frame for the heal replay. */
  private emitLive(opId: string, run: FakeOpRun, subject: string): void {
    run.liveEmitted = true;
    const { dropLiveSeqs, duplicateLiveSeqs, reorderLivePairs } = run.script;
    let sequence = [...run.frames];
    if (reorderLivePairs) {
      for (let i = 0; i + 1 < sequence.length; i += 2) {
        const a = sequence[i] as OpFrame;
        sequence[i] = sequence[i + 1] as OpFrame;
        sequence[i + 1] = a;
      }
    }
    sequence = sequence.filter((frame) => !dropLiveSeqs?.has(Number(frame.seq)));
    queueMicrotask(() => {
      for (const frame of sequence) {
        const payload = OpFrame.encode(frame).finish();
        this.transport.deliver(subject, payload);
        if (duplicateLiveSeqs?.has(Number(frame.seq))) {
          this.transport.deliver(subject, payload);
        }
      }
    });
  }

  private statusOf(opId: string, run: FakeOpRun): OpStatus {
    // The fake's ops are instant: COMPLETE the moment their frames exist. A
    // live op that has not yet emitted reads RUNNING with nothing produced;
    // once emission ran (even if the wire dropped frames), the runner-side
    // truth is COMPLETE with the full high watermark — exactly what a silence
    // probe needs to see to detect "the runner is ahead of us".
    const complete = !run.script.live || run.liveEmitted;
    return {
      opId,
      state: complete ? OpState.OP_STATE_COMPLETE : OpState.OP_STATE_RUNNING,
      nextSeq: complete ? (run.exitSeq + 1n).toString() : "1",
      exit: complete ? run.exit : undefined,
      lostReason: OpLostReason.OP_LOST_REASON_UNSPECIFIED,
    };
  }

  private buildRun(opId: string, script: FakeOpScript): FakeOpRun {
    const frames: OpFrame[] = [];
    const channelBytes: Record<"stdout" | "stderr", Uint8Array[]> = { stdout: [], stderr: [] };
    let seq = 0n;
    for (const spec of script.frames) {
      seq += 1n;
      if (spec === "progress") {
        frames.push({ opId, seq: seq.toString(), body: { $case: "progress", progress: {} } });
        continue;
      }
      const bytes = typeof spec.bytes === "string" ? encoder.encode(spec.bytes) : spec.bytes;
      channelBytes[spec.channel].push(bytes);
      frames.push({
        opId,
        seq: seq.toString(),
        body: {
          $case: "data",
          data: {
            channel:
              spec.channel === "stdout" ? OpChannel.OP_CHANNEL_STDOUT : OpChannel.OP_CHANNEL_STDERR,
            bytes,
          },
        },
      });
    }
    seq += 1n;
    const digests: Record<string, string> = {};
    const totals: Record<string, string> = {};
    for (const channel of ["stdout", "stderr"] as const) {
      const joined = concat(channelBytes[channel]);
      digests[channel] = bytesToHex(blake3(joined));
      totals[channel] = String(joined.byteLength);
    }
    const exit: OpExit = {
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      durationMs: "5",
      digests,
      totals,
      failureCode: "",
      failureDetail: {},
      ...script.exit,
    };
    frames.push({ opId, seq: seq.toString(), body: { $case: "exit", exit } });
    return {
      script,
      frames,
      exitSeq: seq,
      exit,
      startCount: 0,
      attachCount: 0,
      drainingRemaining: script.drainingStarts ?? 0,
      liveEmitted: false,
      finalAcked: false,
      acks: [],
      highestGeneration: 0n,
    };
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function errorResponse(requestId: string, code: ErrorCode, message: string): ControlResponse {
  return {
    requestId,
    error: { code, message, retryable: false, detail: {} },
    result: undefined,
  };
}

function startResponse(requestId: string, status: OpStatus, accepted = true): ControlResponse {
  return {
    requestId,
    error: undefined,
    result: { $case: "opStart", opStart: { accepted, status } },
  };
}

function statusOnly(requestId: string, status: OpStatus): ControlResponse {
  return {
    requestId,
    error: undefined,
    result: { $case: "opStatus", opStatus: status },
  };
}

function lostStatus(opId: string): OpStatus {
  return {
    opId,
    state: OpState.OP_STATE_LOST,
    nextSeq: "0",
    exit: undefined,
    lostReason: OpLostReason.OP_LOST_REASON_EVICTED,
  };
}

function cancelledStatus(opId: string): OpStatus {
  return {
    opId,
    state: OpState.OP_STATE_COMPLETE,
    nextSeq: "1",
    exit: {
      exitCode: -1,
      timedOut: false,
      cancelled: true,
      durationMs: "0",
      digests: {},
      totals: {},
      failureCode: "",
      failureDetail: {},
    },
    lostReason: OpLostReason.OP_LOST_REASON_UNSPECIFIED,
  };
}
