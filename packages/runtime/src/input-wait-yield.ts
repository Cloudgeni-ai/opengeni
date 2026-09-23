import {
  MaxTurnsExceededError,
  type Agent,
  type CallModelInputFilter,
  type RunErrorHandlers,
} from "@openai/agents";

type StreamScope = {
  generation: number;
  phase: "open" | "dispatch" | "settled";
  ended: boolean;
  finished: boolean;
  signal: AbortSignal | undefined;
};

/** Attempt-wide trusted receipts, with separately fenced SDK stream generations.
 * Recovery may start a new stream, never erase an accepted/pending wait. Only
 * SDK yield selection sets yielded; receipt acceptance alone cannot hide output.
 */
export class InputWaitYield {
  private accepted = false;
  private didYield = false;
  private terminal = false;
  private readonly pending = new Set<Promise<void>>();
  private scope: StreamScope = {
    generation: 0,
    phase: "open",
    ended: false,
    finished: false,
    signal: undefined,
  };
  // Recognize our SDK boundary exit by identity, not a provider/tool error's text.
  private readonly boundaryExit = new MaxTurnsExceededError("Runtime input wait yield");

  get requested(): boolean {
    return this.accepted;
  }
  get yielded(): boolean {
    return this.didYield;
  }

  /** Explicit SDK invocation boundary. A prior stream must have settled first.
   * Returned callbacks capture this generation, including across async drains.
   * Parent terminal closure and an actual yield can never be reopened by retry.
   */
  beginStream(signal?: AbortSignal) {
    if (this.terminal || this.didYield) throw new Error("Input wait attempt is terminal");
    if (this.scope.signal?.aborted) {
      this.closeAdmission();
      throw this.scope.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    if (this.scope.generation > 0 && !this.scope.finished) {
      throw new Error("Input wait stream is still active");
    }
    const scope: StreamScope = {
      generation: this.scope.generation + 1,
      phase: "open",
      ended: false,
      finished: false,
      signal,
    };
    this.scope = scope;
    return {
      modelInputFilter: ((args) => this.filterInput(scope, args)) as CallModelInputFilter,
      modelDispatchFilter: ((args) => this.dispatch(scope, args)) as CallModelInputFilter,
      toolUseBehavior: (() => this.finishTools(scope)) as Agent["toolUseBehavior"],
      errorHandlers: this.errorHandlers(scope),
      beginToolExecution: () => this.openTools(scope),
      closeStream: () => this.endStream(scope),
      endStream: (cancelled = false) => {
        // SDK iterator cancellation can be independent of the host signal.
        // A late completion from an older scope cannot cancel its successor.
        if (cancelled && scope === this.scope) this.closeAdmission();
        this.endStream(scope);
        scope.finished = true;
      },
    };
  }

  /** Acquire synchronously BEFORE invoking the trusted remote mutation. Failed
   * acquisition must not execute it. Completion only changes receipt truth; it
   * cannot reopen a stream or retrospectively select successful finalization.
   */
  beginWait(): (success: boolean) => void {
    if (this.scope.signal?.aborted) this.endStream(this.scope);
    if (this.terminal || this.scope.ended || this.scope.phase !== "open") {
      throw new Error("Input wait was not executed: model dispatch or settlement is sealed");
    }
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.add(pending);
    let completed = false;
    return (success) => {
      if (completed) return;
      completed = true;
      if (success) this.accepted = true;
      this.pending.delete(pending);
      release();
    };
  }

  /** Irreversible, synchronous attempt-terminal fence. Failure paths call this
   * before asynchronous persistence without joining remote work or replacing
   * the original failure. Runtime stream closure uses its narrower scope instead.
   */
  readonly closeAdmission = (): void => {
    this.terminal = true;
    this.endStream(this.scope);
  };

  /** Worker event-processing errors may precede SDK settlement. Capture once
   * for that stream; invoking this later cannot close a recovery successor.
   */
  captureStreamClose(): () => void {
    const scope = this.scope;
    return () => this.endStream(scope);
  }

  /** Close the attempt and drain receipts before parent terminal persistence.
   * Cancellation rejects promptly with the existing abort reason; it neither
   * rolls back the remote mutation nor replaces its durable attempt authority.
   */
  async sealForSettlement(signal = this.scope.signal): Promise<void> {
    this.closeAdmission();
    await this.drain(this.scope, signal);
  }

  private endStream(scope: StreamScope): void {
    scope.phase = "settled";
    scope.ended = true;
  }

  private assertCurrent(scope: StreamScope): void {
    if (this.terminal || scope !== this.scope || scope.ended) {
      throw new Error("Model dispatch was not executed: input wait gate is settled or superseded");
    }
  }

  private openTools(scope: StreamScope): void {
    if (scope.signal?.aborted) this.endStream(scope);
    if (!this.terminal && scope === this.scope && !scope.ended && scope.phase === "dispatch") {
      scope.phase = "open";
    }
  }

  private async drain(scope: StreamScope, signal = scope.signal): Promise<void> {
    if (!signal) {
      await Promise.all(this.pending);
      return;
    }
    const onAborted = () => {
      this.endStream(scope);
      return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    };
    if (signal.aborted) throw onAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(onAborted());
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([Promise.all(this.pending), cancelled]);
      if (signal.aborted) throw onAborted();
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private filterInput(scope: StreamScope, { modelData }: Parameters<CallModelInputFilter>[0]) {
    if (scope.signal?.aborted) {
      this.closeCancelledDispatch(scope);
      return modelData;
    }
    this.assertCurrent(scope);
    if (this.accepted) throw this.boundaryExit;
    return modelData;
  }

  private async dispatch(scope: StreamScope, { modelData }: Parameters<CallModelInputFilter>[0]) {
    if (scope.signal?.aborted) {
      this.closeCancelledDispatch(scope);
      return modelData;
    }
    this.assertCurrent(scope);
    scope.phase = "dispatch";
    try {
      await this.drain(scope);
    } catch (error) {
      // Filter exceptions become SDK stream failures, not cancelled EOF. Keep
      // admission sealed. Native initial-adapter cancellation is safe only if
      // no wait has committed and no reserved mutation can still commit.
      if (!scope.signal?.aborted) throw error;
      this.closeCancelledDispatch(scope);
      return modelData;
    }
    this.assertCurrent(scope);
    if (this.accepted) throw this.boundaryExit;
    return modelData;
  }

  private closeCancelledDispatch(scope: StreamScope): void {
    this.endStream(scope);
    if (this.accepted || this.pending.size > 0) {
      // Never permit even an aborted adapter dispatch after wait acceptance,
      // or race a pending mutation that may accept before the adapter starts.
      // Preserve cancellation authority without claiming a successful yield.
      throw scope.signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    // SDK 0.14.3 deliberately enters its initial adapter with an aborted signal.
    // With no accepted/pending wait, preserve that native cancelled-EOF path;
    // physical cancellation remains the transport's responsibility.
  }

  private async finishTools(scope: StreamScope) {
    this.assertCurrent(scope);
    scope.phase = "dispatch";
    try {
      await this.drain(scope);
    } catch (error) {
      // Let the SDK retain its cancelled-stream path, not a new tool failure.
      if (!scope.signal?.aborted) throw error;
      return { isFinalOutput: false as const, isInterrupted: undefined };
    }
    this.assertCurrent(scope);
    if (!this.accepted) {
      this.openTools(scope);
      return { isFinalOutput: false as const, isInterrupted: undefined };
    }
    scope.phase = "settled";
    this.didYield = true;
    return { isFinalOutput: true as const, isInterrupted: undefined, finalOutput: "" };
  }

  private errorHandlers(scope: StreamScope): RunErrorHandlers<any, any> {
    return {
      maxTurns: async ({ error, runData }) => {
        if (scope.signal?.aborted || scope !== this.scope || scope.ended || this.terminal) return;
        if (
          error !== this.boundaryExit &&
          (!runData.state ||
            error.state !== runData.state ||
            runData.state._maxTurns === null ||
            runData.state._currentTurn <= runData.state._maxTurns)
        )
          return;
        // Native-shell caps precede the input filter. Seal this stream, not the
        // attempt: a real cap/failure may lead to an explicitly invoked retry.
        scope.phase = "settled";
        try {
          await this.drain(scope);
        } catch (drainError) {
          if (!scope.signal?.aborted) throw drainError;
          return;
        }
        if (
          scope !== this.scope ||
          scope.ended ||
          this.terminal ||
          !this.accepted ||
          scope.signal?.aborted
        )
          return;
        this.didYield = true;
        return { finalOutput: "", includeInHistory: false };
      },
    };
  }

  // Pre-run/embedding seams also capture the scope when the callback is read.
  // Keeping one of these callbacks never grants authority over a successor.
  get beginToolExecution(): () => void {
    const scope = this.scope;
    return () => this.openTools(scope);
  }
  get modelInputFilter(): CallModelInputFilter {
    const scope = this.scope;
    return (args) => this.filterInput(scope, args);
  }
  get modelDispatchFilter(): CallModelInputFilter {
    const scope = this.scope;
    return (args) => this.dispatch(scope, args);
  }
  get toolUseBehavior(): Agent["toolUseBehavior"] {
    const scope = this.scope;
    return () => this.finishTools(scope);
  }
  runErrorHandlers(signal?: AbortSignal): RunErrorHandlers<any, any> {
    this.scope.signal = signal;
    return this.errorHandlers(this.scope);
  }
}

export type InputWaitYieldStream = ReturnType<InputWaitYield["beginStream"]>;
