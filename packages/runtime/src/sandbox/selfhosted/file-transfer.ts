import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { ControlRequest, ControlResponse, OpState } from "@opengeni/agent-proto";
import { agentErrorToControlError } from "./control-rpc";

// Below the protocol's 512 KiB chunk maximum, leaving control-envelope headroom.
export const SELFHOSTED_FILE_CHUNK_BYTES = 256 * 1024;

export function fileContentDigest(content: Uint8Array): string {
  return bytesToHex(blake3(content));
}

export class FileTransferOutcomeError extends Error {
  readonly retryable = false;
  constructor(
    readonly operationId: string,
    readonly phase: "begin" | "upload" | "verify",
    cause: unknown,
    readonly observationError?: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : "unknown failure";
    const observation =
      observationError instanceof Error ? ` Outcome check: ${observationError.message}` : "";
    super(
      `File transfer ${operationId} ${phase} failed: ${detail}.${observation} No mutation was replayed; inspect the destination before another edit.`,
      { cause },
    );
    this.name = "FileTransferOutcomeError";
  }
}

/** The caller must reauthorize every request and keep the exact physical route.
 * No mutation is automatically replayed, including after an ambiguous reply. */
export async function transferEditorFile(input: {
  path: string;
  content: Uint8Array;
  baseContent?: Uint8Array;
  request: (requestId: string, op: NonNullable<ControlRequest["op"]>) => Promise<ControlResponse>;
}): Promise<{ recovered: boolean }> {
  const opId = `fsw-${crypto.randomUUID()}`;
  const digest = fileContentDigest(input.content);
  const checked = (reply: ControlResponse) => {
    if (reply.error) throw agentErrorToControlError(reply.error, reply.requestId);
    if (!reply.result) throw new Error("The machine omitted the file-transfer result.");
    return reply.result;
  };
  const send = async (requestId: string, op: NonNullable<ControlRequest["op"]>) => {
    const reply = await input.request(requestId, op);
    if (reply.requestId !== requestId)
      throw new Error("The machine returned a mismatched file-transfer response identity.");
    return checked(reply);
  };
  const isVerified = (observed: NonNullable<ControlResponse["result"]>): boolean =>
    !(
      observed.$case !== "opStatus" ||
      observed.opStatus.opId !== opId ||
      observed.opStatus.state !== OpState.OP_STATE_COMPLETE ||
      observed.opStatus.exit?.exitCode !== 0 ||
      observed.opStatus.exit.cancelled ||
      observed.opStatus.exit.timedOut ||
      observed.opStatus.exit.failureCode ||
      observed.opStatus.exit.digests.content !== digest ||
      observed.opStatus.exit.totals.content !== String(input.content.byteLength)
    );
  const verifyOutcome = async (cancelRunning = false): Promise<void> => {
    const observed = await send(crypto.randomUUID(), { $case: "opQuery", opQuery: { opId } });
    if (isVerified(observed)) return;
    if (
      cancelRunning &&
      observed.$case === "opStatus" &&
      observed.opStatus.opId === opId &&
      observed.opStatus.state === OpState.OP_STATE_RUNNING
    ) {
      // This explicit transfer is being abandoned. Cancel only its known live
      // identity through the same reauthorized callback; never sweep or expire
      // other work. A commit racing cancellation must retain its real receipt.
      const cancelled = await send(crypto.randomUUID(), { $case: "opCancel", opCancel: { opId } });
      if (isVerified(cancelled)) return;
      if (
        cancelled.$case === "opStatus" &&
        cancelled.opStatus.opId === opId &&
        cancelled.opStatus.state === OpState.OP_STATE_COMPLETE &&
        cancelled.opStatus.exit?.cancelled
      ) {
        throw new Error("Cancellation of the abandoned transfer's private staging was verified.");
      }
    }
    throw new Error(
      "The file-transfer outcome is not verified; the operation was not replayed. Inspect the destination before another edit.",
    );
  };
  let phase: "begin" | "upload" | "verify" = "begin";
  try {
    const begun = await send(opId, {
      $case: "opStart",
      opStart: {
        op: {
          $case: "fsWrite",
          fsWrite: {
            path: input.path,
            createParents: true,
            mode: 0,
            expectedBaseDigest:
              input.baseContent === undefined ? "" : fileContentDigest(input.baseContent),
            expectedAbsent: input.baseContent === undefined,
            contentDigest: digest,
            contentSize: String(input.content.byteLength),
          },
        },
        windowBytes: "0",
        deadlineMs: "0",
        originId: "",
      },
    });
    if (
      begun.$case !== "opStart" ||
      !begun.opStart.accepted ||
      begun.opStart.status?.opId !== opId
    ) {
      throw new Error("The machine did not accept the exact file-transfer operation.");
    }

    phase = "upload";
    let offset = 0;
    let seq = 0;
    do {
      const end = Math.min(input.content.byteLength, offset + SELFHOSTED_FILE_CHUNK_BYTES);
      const reply = await send(crypto.randomUUID(), {
        $case: "writeChunk",
        writeChunk: {
          opId,
          seq: String(seq),
          offset: String(offset),
          bytes: input.content.subarray(offset, end),
          last: end === input.content.byteLength,
        },
      });
      if (reply.$case !== "writeChunk" || reply.writeChunk.seq !== String(seq)) {
        throw new Error(
          "The machine returned a mismatched file-transfer acknowledgment; no chunk was replayed.",
        );
      }
      offset = end;
      seq += 1;
    } while (offset < input.content.byteLength);
    phase = "verify";
    await verifyOutcome();
  } catch (error) {
    if (phase === "verify") throw new FileTransferOutcomeError(opId, phase, error);
    // An acknowledgment can be lost after commit. Observe this exact operation
    // once under current authority; never restart it or resend a chunk.
    try {
      await verifyOutcome(true);
      return { recovered: true };
    } catch (observationError) {
      throw new FileTransferOutcomeError(opId, phase, error, observationError);
    }
  }
  return { recovered: false };
}
