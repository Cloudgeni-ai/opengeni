import { posix } from "node:path";
import { z } from "zod";
import { ModalBrokerProviderCommand } from "@opengeni/contracts";
import type { ChannelAExecArgs } from "../channel-a";
import {
  admittedCommandSupervisionProtocol,
  admittedProviderCommandHandle,
  markPendingCommandSupervised,
  requireSupervisedLaunchReservation,
  ProviderCommandStartOutcomeUnknownError,
} from "../provider-command-session";
import { modalCommandArgv } from "./modal-command-argv";
import { encodeNativeBrokerCommandDefinition } from "./native-command-broker-definition";
import { NATIVE_BROKER_PAYLOAD_MAX_BYTES } from "./native-command-broker-wire";
import { NativeBrokerInitialDiagnosticsError } from "./native-command-broker-diagnostics";
import type { NativeBrokerCoordinator } from "./native-command-broker-coordinator";
import type { DurableNativeBrokerTransport } from "./native-command-broker-transport";

const preparing = z.object({ state: z.literal("preparing") }).strict();
const launched = z
  .object({ state: z.literal("supervisor_started"), released: z.literal(false) })
  .strict();

/** Canonical route context and a committed process reservation precede every
 * command-specific broker input. This starts ONLY the sealed idle supervisor;
 * release remains the retained-command controller's independent operation.
 *
 * The supplied transport must already be qualified and bootstrap-bound. This
 * helper does not choose an image, enroll an old group, create a broker, bypass
 * routing admission or run setup commands through a weaker fallback. Partial
 * preparation retains its original locator and never starts a replacement.
 */
export async function startNativeBrokerCommand(
  transport: {
    journal: DurableNativeBrokerTransport;
    coordinator: Pick<NativeBrokerCoordinator, "claimWriter" | "send" | "reply">;
  },
  args: ChannelAExecArgs,
  options: { root: string; environment: Record<string, string> },
  signal?: AbortSignal,
): Promise<ModalBrokerProviderCommand> {
  signal?.throwIfAborted();
  const reservation = requireSupervisedLaunchReservation();
  const protocol = admittedCommandSupervisionProtocol();
  if (
    !admittedProviderCommandHandle() ||
    protocol !==
      (args.tty
        ? "native-subreaper-broker-channel-pty-v1"
        : "native-subreaper-broker-channel-v1") ||
    args.runAs
  )
    throw new Error(
      "Broker command requires its exact admitted native protocol, handle and supported shape",
    );
  if (!options.root.startsWith("/") || posix.normalize(options.root) !== options.root)
    throw new Error("Broker workspace root must be an absolute normalized path");
  const workdir = posix.resolve(options.root, args.workdir ?? options.root);
  if (workdir !== options.root && !workdir.startsWith(`${options.root.replace(/\/$/u, "")}/`))
    throw new Error("Broker command workdir is outside the sandbox workspace");
  const definition = encodeNativeBrokerCommandDefinition({
    mode: args.tty ? "pty" : "pipe",
    cwd: workdir,
    argv: modalCommandArgv(args),
    env: Object.entries(options.environment),
    rows: args.tty ? 24 : 0,
    columns: args.tty ? 80 : 0,
  });
  const fault = await transport.journal.diagnosticFault();
  if (fault) throw new NativeBrokerInitialDiagnosticsError(fault);
  markPendingCommandSupervised();
  const writer = await transport.coordinator.claimWriter(signal);
  const state = await transport.journal.read();
  if (
    state.input.writerEpoch !== writer.epoch ||
    state.input.acceptedWriterEpoch !== writer.epoch ||
    state.input.pending
  )
    throw new Error("Broker command writer is not natively fenced");
  const commandId = crypto.randomUUID();
  const command = ModalBrokerProviderCommand.parse({
    kind: "modal-broker-v1",
    sandboxId: state.output.sandboxId,
    taskId: state.output.taskId,
    execId: commandId,
    pty: args.tty === true,
    supervision: {
      protocol,
      invocationId: commandId,
      brokerId: state.input.brokerId,
      launchRequestId: crypto.randomUUID(),
      launchEpoch: writer.epoch,
    },
    capture: { sequence: state.output.lastSequence, receiptAckObserved: false },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  });
  // Reservation may commit and then throw; do not infer absence or erase the
  // chosen launch identity from an uncertain callback result.
  try {
    await reservation.reserve(structuredClone(command));
    const exchange = async (
      kind: "prepare" | "definition" | "launch",
      payload: Uint8Array,
      offset: number,
      expectedOffset: number,
    ) => {
      signal?.throwIfAborted();
      const requestId =
        kind === "launch" ? command.supervision.launchRequestId : crypto.randomUUID();
      await transport.coordinator.send(
        { requestId, commandId, kind, payload, offset },
        signal,
        writer.epoch,
      );
      const reply = await transport.coordinator.reply(requestId, signal);
      const original = await transport.journal.request(requestId);
      if (
        !original?.accepted ||
        original.frame.ownerEpoch !== writer.epoch ||
        original.frame.commandId !== commandId ||
        original.frame.kind !== kind ||
        original.frame.offset !== offset ||
        !Buffer.from(original.frame.payload).equals(Buffer.from(payload)) ||
        reply.requestId !== requestId ||
        reply.brokerId !== command.supervision.brokerId ||
        reply.commandId !== commandId ||
        reply.ownerEpoch !== writer.epoch ||
        reply.kind !== "status" ||
        reply.offset !== expectedOffset
      )
        throw new Error("Broker command preparation lacks its exact accepted operation reply");
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.payload));
      if (!(kind === "launch" ? launched : preparing).safeParse(body).success)
        throw new Error("Broker command preparation did not produce the expected native state");
    };
    const size = Buffer.alloc(4);
    size.writeUInt32BE(definition.length);
    await exchange("prepare", size, 0, 0);
    for (let offset = 0; offset < definition.length; offset += NATIVE_BROKER_PAYLOAD_MAX_BYTES) {
      const chunk = definition.slice(offset, offset + NATIVE_BROKER_PAYLOAD_MAX_BYTES);
      await exchange("definition", chunk, offset, offset + chunk.length);
    }
    await exchange("launch", new Uint8Array(), 0, 0);
    return command;
  } catch (cause) {
    // This is conservative retained custody, not a claim that user code ran.
    // Unknown prepare/definition/launch outcomes all keep the same descriptor.
    throw new ProviderCommandStartOutcomeUnknownError(command, cause);
  }
}
