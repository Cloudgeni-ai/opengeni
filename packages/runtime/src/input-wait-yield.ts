import {
  MaxTurnsExceededError,
  type Agent,
  type CallModelInputFilter,
  type RunErrorHandlers,
} from "@openai/agents";

/** Attempt-local control state, never reconstructed from model/tool output text.
 * The trusted transport records success; Runner observes it only after settling
 * the tool batch, preserving receipts and parallel siblings in normal history.
 */
export class InputWaitYield {
  private accepted = false;
  // Identity, not name/message/shape, authorizes the SDK boundary exit. Never
  // swallow a provider/tool failure just because a wait also succeeded.
  // The SDK's supported max-turn handler is its pre-inference graceful-stop
  // seam. Treat a committed wait as exhausting this attempt's inference budget,
  // but recognize this request by identity, never by its error name or text.
  private readonly boundaryExit = new MaxTurnsExceededError("Runtime input wait yield");

  get requested(): boolean {
    return this.accepted;
  }

  recordSuccess(): void {
    this.accepted = true;
  }

  readonly toolUseBehavior: Agent["toolUseBehavior"] = () =>
    this.accepted
      ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: "" }
      : { isFinalOutput: false, isInterrupted: undefined };

  /** Agents SDK 0.14.3 skips toolUseBehavior for native shell-only batches.
   * Stop those at the existing input-filter seam, before another inference or
   * host filter. The completed shell receipts already belong to SDK history.
   */
  readonly modelInputFilter: CallModelInputFilter = ({ modelData }) => {
    if (this.accepted) throw this.boundaryExit;
    return modelData;
  };

  /** Use SDK normal finalization, not abort EOF or a replacement stream/state.
   * Native shell receipts remain in history; the empty terminal output does not.
   * A genuine SDK turn cap can precede the input filter after the last allowed
   * shell batch, so a successful wait also takes precedence at that boundary.
   */
  runErrorHandlers(signal?: AbortSignal): RunErrorHandlers<any, any> {
    return {
      maxTurns: ({ error, runData }) => {
        if (!this.accepted || signal?.aborted) return;
        if (
          error !== this.boundaryExit &&
          (!runData.state ||
            error.state !== runData.state ||
            runData.state._maxTurns === null ||
            runData.state._currentTurn <= runData.state._maxTurns)
        )
          return;
        return { finalOutput: "", includeInHistory: false };
      },
    };
  }
}
