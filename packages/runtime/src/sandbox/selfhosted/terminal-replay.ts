import type { OpStreamExecClient } from "./op-stream";
import type { OpExit } from "@opengeni/agent-proto";

/** Identical terminal reason projection for pushed and reconciled exits. */
export function connectedCommandExitProof(exit: OpExit, observedAt: Date) {
  const code = exit.failureCode.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return {
    outcome: "exited" as const,
    exitCode: exit.exitCode,
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

/** A finite terminal drain: settlement is forbidden until the verified exit
 * frontier has been captured. A fresh collector always replays retained truth. */
export async function replayConnectedCommandOutput(
  client: Pick<OpStreamExecClient, "readExisting">,
  opId: string,
  terminalKnown: boolean,
  capture: Parameters<OpStreamExecClient["readExisting"]>[2],
  deadlineAt?: number,
): Promise<Awaited<ReturnType<OpStreamExecClient["readExisting"]>>> {
  const checkDeadline = () => {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt)
      throw new Error("Connected command output collector reached its claim deadline");
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
    const replay = await client.readExisting(opId, terminalKnown ? 5_000 : 250, boundedCapture);
    checkDeadline();
    if (!terminalKnown || replay.status === "completed" || replay.terminal) return replay;
    // Heartbeats and partial UTF-8 advance the contiguous protocol frontier
    // even when no decoded output chunk is produced.
    capturedThrough = BigInt(replay.replaySequence);
    if (capturedThrough === before)
      throw new Error("Connected command terminal output replay has not reached its exit frontier");
  }
}
