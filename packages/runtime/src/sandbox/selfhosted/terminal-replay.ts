import { ErrorCode, type OpExit } from "@opengeni/agent-proto";
import { SelfhostedControlError } from "./control-rpc";
import type { OpStreamExecClient } from "./op-stream";
import { OpStreamUnavailableError } from "./op-transport";

/** Why a connected command's output collection did not reach its exit. */
export type ConnectedCommandCollectionFailure =
  /** The collector's claim budget ended before the exit frame arrived. */
  | "claim_deadline"
  /** The replay ended without the exit frame and without progress. */
  | "exit_frontier_not_reached"
  /** The replayed exit disagrees with the completion or provider proof. */
  | "exit_frontier_mismatch"
  /** No output transport is available to replay retained output. */
  | "output_transport_unavailable";

export class ConnectedCommandCollectionError extends Error {
  readonly name = "ConnectedCommandCollectionError";
  constructor(
    readonly reason: ConnectedCommandCollectionFailure,
    message: string,
  ) {
    super(message);
  }
}

/** A closed, telemetry-safe code for why collecting or settling a connected
 * command failed: a collection failure, the runner's control error code, a
 * database SQLSTATE, or `unclassified`. Never error text, which telemetry
 * does not export. */
export function connectedCommandFailureReason(error: unknown): string {
  let cause = error;
  for (let depth = 0; cause && depth < 8; depth++) {
    if (cause instanceof ConnectedCommandCollectionError) return cause.reason;
    if (cause instanceof OpStreamUnavailableError) return "output_transport_unavailable";
    if (cause instanceof SelfhostedControlError) {
      const name = ErrorCode[cause.code] as string | undefined;
      return `control_${name ? name.replace(/^ERROR_CODE_/, "").toLowerCase() : "unknown"}`;
    }
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code))
      return `database_${code.toLowerCase()}`;
    cause = (cause as { cause?: unknown }).cause;
  }
  return "unclassified";
}

/** Identical terminal reason projection for pushed and reconciled exits. */
export function connectedCommandExitProof(exit: OpExit, observedAt: Date) {
  const code = exit.failureCode.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return {
    outcome: "exited" as const,
    exitCode: exit.exitCode,
    ...(exit.backgroundChildrenStopped ? { backgroundChildrenStopped: true } : {}),
    reason: code
      ? `op_failure_${code}`
      : exit.cancelled
        ? "op_cancelled"
        : exit.timedOut
          ? "op_timed_out"
          : "op_exit",
    ...(code ? { failure: { code, detail: exit.failureDetail, retryable: false as const } } : {}),
    observedAt,
  };
}

type ReplayResult = Awaited<ReturnType<OpStreamExecClient["readExisting"]>>;
type ReplayCapture = Parameters<OpStreamExecClient["readExisting"]>[2];

/** When a collector holding a claim taken at `claimedAtMs` must stop
 * replaying: its last read may run one control timeout past this, and five
 * seconds remain to settle the command before the claim can be taken over. */
export function connectedCommandReplayDeadline(
  claimedAtMs: number,
  claimTtlMs: number,
  controlTimeoutMs: number,
): number {
  return claimedAtMs + claimTtlMs - controlTimeoutMs - 5_000;
}

/** A finite terminal drain: settlement is forbidden until the verified exit
 * frontier has been captured. A fresh collector always replays retained truth.
 *
 * A terminal replay follows ONE attachment until the exit frame or its
 * deadline. Its frames share the runner's output connection with every other
 * command's, so on a slow link they can take minutes to arrive; giving up
 * early and attaching again would only queue the same frames once more behind
 * the ones already in flight. A running command's read stays a short look. */
export async function replayConnectedCommandOutput(
  client: Pick<OpStreamExecClient, "readExisting">,
  opId: string,
  terminalKnown: false,
  capture: ReplayCapture,
  deadlineAt?: number,
): Promise<ReplayResult>;
export async function replayConnectedCommandOutput(
  client: Pick<OpStreamExecClient, "readExisting">,
  opId: string,
  terminalKnown: boolean,
  capture: ReplayCapture,
  deadlineAt: number,
): Promise<ReplayResult>;
export async function replayConnectedCommandOutput(
  client: Pick<OpStreamExecClient, "readExisting">,
  opId: string,
  terminalKnown: boolean,
  capture: ReplayCapture,
  deadlineAt?: number,
): Promise<ReplayResult> {
  if (terminalKnown && deadlineAt === undefined)
    throw new TypeError("A terminal output replay requires its collector's deadline");
  const checkDeadline = () => {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt)
      throw new ConnectedCommandCollectionError(
        "claim_deadline",
        "Connected command output collector reached its claim deadline",
      );
  };
  const boundedCapture: typeof capture =
    deadlineAt === undefined
      ? capture
      : async (frames) => {
          for (const frame of frames) {
            checkDeadline();
            await capture([frame]);
          }
          checkDeadline();
        };
  let capturedThrough = 0n;
  while (true) {
    // Only collector ownership is bounded, never the native command. The push
    // caller reserves an in-flight read window before its existing claim expires.
    checkDeadline();
    const before = capturedThrough;
    const replay = await client.readExisting(
      opId,
      terminalKnown ? Math.max(1, deadlineAt! - Date.now()) : 250,
      boundedCapture,
    );
    checkDeadline();
    if (!terminalKnown || replay.status === "completed" || replay.terminal) return replay;
    // Heartbeats and partial UTF-8 advance the contiguous protocol frontier
    // even when no decoded output chunk is produced.
    capturedThrough = BigInt(replay.replaySequence);
    if (capturedThrough === before)
      throw new ConnectedCommandCollectionError(
        "exit_frontier_not_reached",
        "Connected command terminal output replay has not reached its exit frontier",
      );
  }
}
