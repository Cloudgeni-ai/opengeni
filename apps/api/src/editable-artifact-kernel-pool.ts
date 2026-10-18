import { Worker } from "node:worker_threads";
import type {
  ApplyAuthoritativeEditableArtifactKernelRequest,
  ApplyAuthoritativeEditableArtifactKernelResult,
  AuthoritativeEditableArtifactCompactionKernelPort,
  AuthoritativeEditableArtifactCompactionKernelResult,
  AuthoritativeEditableArtifactGenesisKernelPort,
  AuthoritativeEditableArtifactGenesisKernelResult,
  AuthoritativeEditableArtifactKernelPort,
  EditableArtifactAgentInspectionKernelPort,
  EditableArtifactKernelState,
  IsolatedEditableArtifactSnapshotKernelPort,
  IsolatedEditableArtifactSnapshotKernelResult,
} from "@opengeni/core";
import type { BoundedObjectReadPort } from "@opengeni/storage";
import type {
  EditableArtifactKernelThreadCompactionResult,
  EditableArtifactKernelThreadGenesisResult,
  EditableArtifactKernelThreadOperation,
  EditableArtifactKernelThreadReplayPlan,
  EditableArtifactKernelThreadRequest,
  EditableArtifactKernelThreadResponse,
} from "./editable-artifact-kernel-thread";
import {
  collectExact,
  fixedChunks,
  readSnapshotObjectBytes,
} from "./editable-artifact-native-kernel";

export const DEFAULT_EDITABLE_ARTIFACT_KERNEL_THREADS = 2;
const DEFAULT_IDLE_MS = 5 * 60_000;

type Job = {
  id: number;
  operation: EditableArtifactKernelThreadOperation;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
};

type Slot = {
  worker: Worker;
  job: Job | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
};

export type OffThreadEditableArtifactKernelOptions = Readonly<{
  objects: BoundedObjectReadPort;
  /** Worker module that calls serveEditableArtifactKernelThread. */
  threadUrl?: URL;
  threads?: number;
  idleMs?: number;
}>;

/**
 * Runs the synchronous native artifact kernel on worker threads so snapshot
 * replay and large document operations never block the API event loop. The
 * calling thread does all storage I/O and posts plain bytes; each kernel thread
 * runs the same NativeEditableArtifactKernelAdapter over those bytes. Threads
 * start lazily, are reused, and exit after an idle period.
 */
export class OffThreadEditableArtifactKernel
  implements
    AuthoritativeEditableArtifactKernelPort,
    AuthoritativeEditableArtifactGenesisKernelPort,
    AuthoritativeEditableArtifactCompactionKernelPort,
    IsolatedEditableArtifactSnapshotKernelPort,
    EditableArtifactAgentInspectionKernelPort
{
  readonly #objects: BoundedObjectReadPort;
  readonly #threadUrl: URL;
  readonly #threads: number;
  readonly #idleMs: number;
  readonly #slots: Slot[] = [];
  readonly #queue: Job[] = [];
  #nextId = 1;
  #closed = false;

  constructor(options: OffThreadEditableArtifactKernelOptions) {
    const threads = options.threads ?? DEFAULT_EDITABLE_ARTIFACT_KERNEL_THREADS;
    if (!Number.isSafeInteger(threads) || threads < 1) {
      throw new Error("Editable artifact kernel thread count must be a positive integer");
    }
    this.#objects = options.objects;
    this.#threadUrl = options.threadUrl ?? defaultThreadUrl();
    this.#threads = threads;
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  }

  async applyTransaction(
    request: ApplyAuthoritativeEditableArtifactKernelRequest,
  ): Promise<ApplyAuthoritativeEditableArtifactKernelResult> {
    const snapshotBytes = await this.#snapshotBytes(request.state);
    return (await this.#run({
      op: "apply",
      request: {
        modality: request.modality,
        state: request.state,
        intentBytes: request.intentBytes,
        intent: { commandBytes: request.intent.commandBytes },
        ...(request.modality === "spreadsheet"
          ? { resolvedCausalBase: request.resolvedCausalBase }
          : {}),
      },
      snapshotBytes,
    })) as ApplyAuthoritativeEditableArtifactKernelResult;
  }

  async query(
    input: Parameters<EditableArtifactAgentInspectionKernelPort["query"]>[0],
  ): ReturnType<EditableArtifactAgentInspectionKernelPort["query"]> {
    const snapshotBytes = await this.#snapshotBytes(input.state);
    return (await this.#run({
      op: "query",
      state: input.state,
      queryBytes: input.queryBytes,
      snapshotBytes,
    })) as Uint8Array;
  }

  async createCanonicalEmptySnapshot(
    input: Parameters<
      AuthoritativeEditableArtifactGenesisKernelPort["createCanonicalEmptySnapshot"]
    >[0],
  ): Promise<AuthoritativeEditableArtifactGenesisKernelResult> {
    const result = (await this.#run(
      {
        op: "genesis",
        input: { scope: input.scope, artifactId: input.artifactId, modality: input.modality },
      },
      input.signal,
    )) as EditableArtifactKernelThreadGenesisResult;
    return withCanonicalChunks(
      result,
      input.signal,
    ) as AuthoritativeEditableArtifactGenesisKernelResult;
  }

  async createCanonicalSnapshot(input: {
    state: EditableArtifactKernelState;
    signal?: AbortSignal;
  }): Promise<AuthoritativeEditableArtifactCompactionKernelResult> {
    const snapshotBytes = await this.#snapshotBytes(input.state, input.signal);
    const result = (await this.#run(
      { op: "compact", state: input.state, snapshotBytes },
      input.signal,
    )) as EditableArtifactKernelThreadCompactionResult;
    return withCanonicalChunks(
      result,
      input.signal,
    ) as AuthoritativeEditableArtifactCompactionKernelResult;
  }

  async verifyAndReconstruct(
    input: Parameters<IsolatedEditableArtifactSnapshotKernelPort["verifyAndReconstruct"]>[0],
  ): Promise<IsolatedEditableArtifactSnapshotKernelResult> {
    throwIfAborted(input.signal);
    const { snapshotChunks, replayPlan, signal, ...rest } = input;
    const snapshotBytes = await collectExact(
      snapshotChunks,
      input.expectedSnapshotByteSize,
      signal,
    );
    let threadReplayPlan: EditableArtifactKernelThreadReplayPlan | undefined;
    if (replayPlan) {
      const segments: EditableArtifactKernelThreadReplayPlan["segments"][number][] = [];
      for await (const segment of replayPlan.segments) {
        throwIfAborted(signal);
        segments.push(segment);
      }
      threadReplayPlan = { ...replayPlan, segments } as EditableArtifactKernelThreadReplayPlan;
    }
    return (await this.#run(
      {
        op: "verify",
        input: rest,
        snapshotBytes,
        ...(threadReplayPlan ? { replayPlan: threadReplayPlan } : {}),
      },
      signal,
    )) as IsolatedEditableArtifactSnapshotKernelResult;
  }

  /** Terminates every kernel thread and rejects queued work. */
  close(): void {
    this.#closed = true;
    for (const job of this.#queue.splice(0)) settle(job, closedError());
    for (const slot of this.#slots.splice(0)) {
      if (slot.idleTimer) clearTimeout(slot.idleTimer);
      if (slot.job) settle(slot.job, closedError());
      void slot.worker.terminate();
    }
  }

  async #snapshotBytes(state: EditableArtifactKernelState, signal?: AbortSignal) {
    const snapshot = state.snapshot;
    if (!snapshot) throw new Error("Editable artifact has no verified replay snapshot");
    return await readSnapshotObjectBytes(this.#objects, snapshot, signal);
  }

  async #run(
    operation: EditableArtifactKernelThreadOperation,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(signal);
    if (this.#closed) throw closedError();
    const result = await new Promise<unknown>((resolve, reject) => {
      const job: Job = {
        id: this.#nextId++,
        operation,
        resolve,
        reject,
        signal,
        onAbort: undefined,
      };
      if (signal) {
        // Queued work is dropped on cancellation; running native work cannot be
        // interrupted, so its result is discarded by the check below.
        job.onAbort = () => {
          const index = this.#queue.indexOf(job);
          if (index !== -1) {
            this.#queue.splice(index, 1);
            settle(job, cancelledError());
          }
        };
        signal.addEventListener("abort", job.onAbort, { once: true });
      }
      this.#queue.push(job);
      this.#pump();
    });
    throwIfAborted(signal);
    return result;
  }

  #pump(): void {
    while (this.#queue.length > 0) {
      let slot = this.#slots.find((candidate) => candidate.job === undefined);
      if (!slot) {
        if (this.#slots.length >= this.#threads) return;
        slot = this.#spawn();
      }
      const job = this.#queue.shift()!;
      if (slot.idleTimer) {
        clearTimeout(slot.idleTimer);
        slot.idleTimer = undefined;
      }
      slot.job = job;
      const message: EditableArtifactKernelThreadRequest = {
        id: job.id,
        operation: job.operation,
      };
      try {
        slot.worker.postMessage(message);
      } catch (error) {
        slot.job = undefined;
        settle(job, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #spawn(): Slot {
    const worker = new Worker(this.#threadUrl);
    worker.unref();
    const slot: Slot = { worker, job: undefined, idleTimer: undefined };
    this.#slots.push(slot);
    worker.on("message", (response: EditableArtifactKernelThreadResponse) => {
      const job = slot.job;
      if (!job || job.id !== response.id) return;
      slot.job = undefined;
      if (response.ok) settle(job, undefined, response.result);
      else {
        const error = new Error(response.error.message);
        error.name = response.error.name;
        settle(job, error);
      }
      this.#scheduleIdle(slot);
      this.#pump();
    });
    const fail = (cause: unknown) => {
      const index = this.#slots.indexOf(slot);
      if (index === -1) return;
      this.#slots.splice(index, 1);
      if (slot.idleTimer) clearTimeout(slot.idleTimer);
      if (slot.job) {
        const job = slot.job;
        slot.job = undefined;
        settle(
          job,
          new Error(
            `Editable artifact kernel thread stopped: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          ),
        );
      }
      void worker.terminate();
      this.#pump();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(`exit code ${code}`));
    return slot;
  }

  #scheduleIdle(slot: Slot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => {
      if (slot.job) return;
      const index = this.#slots.indexOf(slot);
      if (index !== -1) this.#slots.splice(index, 1);
      void slot.worker.terminate();
    }, this.#idleMs);
    slot.idleTimer.unref?.();
  }
}

function defaultThreadUrl(): URL {
  // Source runs load the TypeScript module; the API bundle emits the same
  // entrypoint as a sibling JavaScript file.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./editable-artifact-kernel-thread-entry.${extension}`, import.meta.url);
}

function withCanonicalChunks<Result extends { canonicalBytes: Uint8Array }>(
  result: Result,
  signal: AbortSignal | undefined,
) {
  const { canonicalBytes, ...rest } = result;
  return Object.freeze({ ...rest, canonicalChunks: fixedChunks(canonicalBytes, signal) });
}

function settle(job: Job, error: Error | undefined, value?: unknown): void {
  if (job.signal && job.onAbort) job.signal.removeEventListener("abort", job.onAbort);
  if (error) job.reject(error);
  else job.resolve(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError(): Error {
  return new Error("Editable artifact native operation was cancelled");
}

function closedError(): Error {
  return new Error("Editable artifact kernel threads are closed");
}
