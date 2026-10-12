import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ModalBrokerProviderCommand, CommandSupervisionReceipt } from "@opengeni/contracts";
import type {
  ProviderCommandOutput,
  ProviderCommandPersistence,
} from "../provider-command-session";
import {
  nativeBrokerCommandFromSnapshot,
  projectNativeBrokerCommand,
  retainedNativeBrokerCommandSnapshot,
} from "./native-command-broker-command";
import type { NativeBrokerDriver } from "./native-command-broker-driver";
import type { DurableNativeBrokerTransport } from "./native-command-broker-transport";

/** Stable private operation identity, not a bearer or an authorization. A
 * reconnect finds the same durable release/cancel/receipt-ACK request. Status
 * includes the captured prefix so a later observation can obtain a new reply.
 * A successor is permitted only after a committed, explicitly non-dispatched
 * busy/pressure rejection. The journal compares complete bodies on replay. */
function operationId(command: ModalBrokerProviderCommand, operation: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["native-broker-retained-control-v1", command.supervision, operation]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x80;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function immutable(command: ModalBrokerProviderCommand) {
  const { capture: _capture, streams: _streams, ...identity } = command;
  return identity;
}

/** Canonical retained-command bridge. This class cannot start a command,
 * establish a bootstrap, elect/fence a writer or choose an execution protocol.
 * The caller supplies the already bound initial-process transport and exact
 * protected process persistence. A transport pending write remains explicit;
 * none of these methods calls replayPending or retries physical dispatch.
 *
 * Shared provider-output observation is deliberately outside this per-command
 * object. A single collector can commit frames for many commands without a
 * slow command observer holding input, cancellation or another reader hostage. */
export class NativeBrokerRetainedCommand {
  private readonly identity: ModalBrokerProviderCommand;
  private readonly recordReceipt: (receipt: CommandSupervisionReceipt) => Promise<void>;
  private readonly loadReceipt: () => Promise<CommandSupervisionReceipt | null>;
  private readonly capturePage: NonNullable<ProviderCommandPersistence["captureBrokerPage"]>;
  private readonly requestCancellation: NonNullable<
    ProviderCommandPersistence["requestCancellation"]
  >;
  private readonly cancellationRequested: NonNullable<
    ProviderCommandPersistence["cancellationRequested"]
  >;

  constructor(
    command: ModalBrokerProviderCommand,
    private readonly persistence: ProviderCommandPersistence,
    private readonly journal: DurableNativeBrokerTransport,
    private readonly driver: Pick<NativeBrokerDriver, "send">,
  ) {
    this.identity = ModalBrokerProviderCommand.parse(command);
    if (
      !persistence.recordSupervisionReceipt ||
      !persistence.loadSupervisionReceipt ||
      !persistence.captureBrokerPage ||
      !persistence.requestCancellation ||
      !persistence.cancellationRequested
    )
      throw new Error(
        "Broker command requires canonical receipt, output and cancellation persistence",
      );
    this.recordReceipt = persistence.recordSupervisionReceipt.bind(persistence);
    this.loadReceipt = persistence.loadSupervisionReceipt.bind(persistence);
    this.capturePage = persistence.captureBrokerPage.bind(persistence);
    this.requestCancellation = persistence.requestCancellation.bind(persistence);
    this.cancellationRequested = persistence.cancellationRequested.bind(persistence);
  }

  private async current() {
    const command = ModalBrokerProviderCommand.parse(await this.persistence.load());
    if (!isDeepStrictEqual(immutable(command), immutable(this.identity)))
      throw new Error("Retained broker command identity changed");
    const physical = await this.journal.read();
    if (
      physical.input.brokerId !== command.supervision.brokerId ||
      physical.output.sandboxId !== command.sandboxId ||
      physical.output.taskId !== command.taskId
    )
      throw new Error("Retained command does not own this initial-process transport");
    const receipt = await this.loadReceipt();
    // Validates the receipt's mode/identity and all terminal descriptor facts.
    const snapshot = retainedNativeBrokerCommandSnapshot(command, receipt);
    return { command, receipt, snapshot };
  }

  /** Commit one bounded projection before exposing it. A losing CAS discards
   * its text and reprojects from canonical state; it never emits duplicate or
   * uncommitted tail bytes. A native receipt commits before either ACK or the
   * output projection can acquire receipt-ACK/exit evidence. */
  async capture(limit = 64): Promise<ProviderCommandOutput & { hasMore: boolean }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { command, snapshot } = await this.current();
      const projected = await projectNativeBrokerCommand(this.journal, snapshot, limit);
      for (const receipt of projected.receipts) await this.recordReceipt(receipt);
      const next = nativeBrokerCommandFromSnapshot(command, projected.snapshot);
      const saved = await this.capturePage({
        expected: command,
        command: next,
        stdout: projected.chunks
          .filter((chunk) => chunk.stream === "stdout")
          .map((chunk) => chunk.text)
          .join(""),
        stderr: projected.chunks
          .filter((chunk) => chunk.stream === "stderr")
          .map((chunk) => chunk.text)
          .join(""),
      });
      if (!isDeepStrictEqual(immutable(saved.command), immutable(this.identity)))
        throw new Error("Broker output capture changed execution identity");
      if (!saved.captured) continue;
      if (!isDeepStrictEqual(saved.command, next))
        throw new Error("Broker output capture did not commit the exact projection");
      return {
        expected: command,
        command: next,
        chunks: projected.chunks.map((chunk, index) => ({
          stream: chunk.stream,
          chunkId: `broker:${command.execId}:${command.capture.sequence}:${next.capture.sequence}:${index}`,
          text: chunk.text,
        })),
        exitCode: projected.exitCode,
        providerExited: projected.exitCode !== null,
        streamFidelity: command.pty ? "merged" : "separate",
        hasMore: projected.hasMore,
      };
    }
    throw new Error("Broker command output cursor changed during bounded capture");
  }

  private async control(action: "release" | "cancel" | "status" | "ack", signal?: AbortSignal) {
    const wantsStatus = action === "status";
    signal?.throwIfAborted();
    const { command, receipt } = await this.current();
    if (command.streams.stdout.exitCode === 0) return { state: "already_settled" as const };
    if (action !== "ack" && (await this.cancellationRequested())) action = "cancel";
    // A persisted receipt is terminal native evidence, not permission to send
    // a new release or cancel. Only its exact ACK can still be dispatched.
    if (receipt) action = "ack";
    if (action === "ack" && !receipt)
      throw new Error("Broker receipt ACK requires the exact durable native receipt");
    const payload = action === "ack" ? `ack\t${receipt!.receiptId}` : action;
    const operation = action === "status" ? `status:${command.capture.sequence}` : payload;
    const result = await this.dispatchControl(command, payload, operation, signal);
    if (
      wantsStatus &&
      action === "cancel" &&
      result.state === "control_applied" &&
      ["running", "idle"].includes(result.nativeState)
    )
      return this.dispatchControl(command, "status", `status:${command.capture.sequence}`, signal);
    return result;
  }

  private async dispatchControl(
    command: ModalBrokerProviderCommand,
    payload: string,
    operation: string,
    signal?: AbortSignal,
  ) {
    const bytes = Buffer.from(payload, "ascii");
    let requestId = operationId(command, operation);
    for (let attempt = 0; attempt < 32; attempt++) {
      signal?.throwIfAborted();
      const reply = await this.journal.controlReply(requestId);
      if (!reply)
        return this.driver.send(
          { requestId, commandId: command.execId, kind: "control", offset: 0, payload: bytes },
          signal,
        );
      const original = await this.journal.request(requestId);
      if (
        !original?.accepted ||
        original.frame.commandId !== command.execId ||
        original.frame.kind !== "control" ||
        original.frame.offset !== 0 ||
        !Buffer.from(original.frame.payload).equals(bytes)
      )
        throw new Error("Broker control reply belongs to another immutable request");
      if (reply.kind === "status") {
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.payload));
        } catch {
          throw new Error("Malformed native broker control response");
        }
        const parsed = z
          .union([
            z.object({ state: z.enum(["running", "idle"]) }).strict(),
            z.object({ state: z.literal("not_started"), launchClosed: z.literal(true) }).strict(),
            z
              .object({ state: z.literal("quiescent"), receipt: CommandSupervisionReceipt })
              .strict(),
          ])
          .safeParse(body);
        if (!parsed.success) throw new Error("Invalid native broker control response");
        if (parsed.data.state === "quiescent")
          retainedNativeBrokerCommandSnapshot(command, parsed.data.receipt);
        return {
          state: "control_applied" as const,
          nativeState: parsed.data.state,
          responseSequence: reply.sequence,
        };
      }
      // These exact native errors precede send() to the private supervisor
      // channel. Never infer non-dispatch from unknown, timeout or disappearance.
      let rejection: unknown;
      try {
        rejection = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.payload));
      } catch {
        throw new Error("Malformed native broker control rejection");
      }
      if (
        !rejection ||
        typeof rejection !== "object" ||
        Object.keys(rejection).length !== 1 ||
        !("error" in rejection) ||
        !["control_unavailable", "control_pressure"].includes(String(rejection.error))
      )
        throw new Error(
          "Native broker control failed without safe retry proof; collect original command evidence",
        );
      if (command.capture.sequence < reply.sequence)
        return { state: "capture_required" as const, responseSequence: reply.sequence };
      requestId = operationId(command, `${operation}:after:${reply.sequence}`);
    }
    throw new Error("Native broker control rejection chain exceeded its reconciliation bound");
  }

  release(signal?: AbortSignal) {
    return this.control("release", signal);
  }

  async cancel(reason: "provider_deadline" | "explicit_stop", signal?: AbortSignal) {
    // Even when physical dispatch is blocked or uncertain, the canonical
    // cancellation intent must win a later release/reconnect.
    await this.current();
    await this.requestCancellation(reason);
    return this.control("cancel", signal);
  }

  status(signal?: AbortSignal) {
    return this.control("status", signal);
  }

  acknowledgeReceipt(signal?: AbortSignal) {
    return this.control("ack", signal);
  }
}
