import { isDeepStrictEqual } from "node:util";
import { truncateOutput } from "@openai/agents-core/sandbox/internal";
import {
  ModalBrokerProviderCommand,
  NativeBrokerCommandProtocol,
  type SandboxProviderCommand,
} from "@opengeni/contracts";
import type { ChannelAExecArgs, ChannelASession } from "../channel-a";
import {
  admittedCommandSupervisionProtocol,
  admittedProviderCommandHandle,
  admittedProviderCommandInput,
  MAX_PROVIDER_COMMAND_HANDLE,
  ProviderCommandStartOutcomeUnknownError,
  ProviderCommandStartRejectedError,
  ProviderCommandObservationUnavailableError,
  type ProviderCommandOutput,
  type ProviderCommandPersistence,
  type ProviderCommandSession,
  type AdmittedCommandSupervisionProtocol,
} from "../provider-command-session";
import { ModalProcessObservationUnavailableError } from "../errors";
import { markTypedExecHandleLoss } from "../exec-banner";
import { NativeBrokerRetainedCommand } from "./native-command-broker-retained-command";
import { startNativeBrokerCommand } from "./native-command-broker-start";
import {
  NativeBrokerReconciliationRequiredError,
  type NativeBrokerCoordinator,
} from "./native-command-broker-coordinator";
import { NativeBrokerDispatchUnknownError } from "./native-command-broker-driver";
import type { DurableNativeBrokerTransport } from "./native-command-broker-transport";
import { NATIVE_BROKER_PAYLOAD_MAX_BYTES } from "./native-command-broker-wire";

type Entry = {
  command: ModalBrokerProviderCommand;
  persistence?: ProviderCommandPersistence;
};

function sameCommand(a: ModalBrokerProviderCommand, b: ModalBrokerProviderCommand) {
  return (
    a.sandboxId === b.sandboxId &&
    a.taskId === b.taskId &&
    a.execId === b.execId &&
    a.pty === b.pty &&
    isDeepStrictEqual(a.supervision, b.supervision)
  );
}

/** Session surface for one already qualified physical broker. The supplied
 * verifier owns live canonical qualification; construction is not admission.
 * This object provides no legacy SDK fallback and no unretained setup lane.
 * One physical instance must share its coordinator with all session surfaces.
 * Closing this surface never terminates the broker or another session's work. */
export class NativeBrokerCommandSession implements ProviderCommandSession {
  private readonly entries = new Map<number, Entry>();
  private readonly receipts = new Map<string, ProviderCommandOutput>();
  private readonly starts = new Set<AbortController>();
  private readonly stopped = new AbortController();

  constructor(
    private readonly options: {
      journal: DurableNativeBrokerTransport;
      coordinator: NativeBrokerCoordinator;
      root: string;
      environment: () => Record<string, string>;
      verify: (
        protocol: NativeBrokerCommandProtocol,
      ) => Promise<{ sandboxId: string; taskId: string }>;
      identity: { sandboxId: string; taskId: string; brokerId: string };
    },
  ) {
    this.options = Object.freeze({ ...options, identity: Object.freeze({ ...options.identity }) });
    markTypedExecHandleLoss(this);
  }

  private requireIdentity(command: ModalBrokerProviderCommand) {
    const identity = this.options.identity;
    if (
      command.sandboxId !== identity.sandboxId ||
      command.taskId !== identity.taskId ||
      command.supervision.brokerId !== identity.brokerId
    )
      throw new Error("Retained broker command belongs to another physical session");
  }

  async verifyCommandSupervisionCapability(protocol?: AdmittedCommandSupervisionProtocol) {
    this.stopped.signal.throwIfAborted();
    const selected = NativeBrokerCommandProtocol.parse(protocol);
    const verified = await this.options.verify(selected);
    const state = await this.options.journal.read();
    const expected = this.options.identity;
    if (
      verified.sandboxId !== expected.sandboxId ||
      verified.taskId !== expected.taskId ||
      state.output.sandboxId !== expected.sandboxId ||
      state.output.taskId !== expected.taskId ||
      state.input.brokerId !== expected.brokerId
    )
      throw new Error("Broker session qualification changed its physical identity");
    this.stopped.signal.throwIfAborted();
    return { sandboxId: verified.sandboxId, taskId: verified.taskId };
  }

  bindProviderCommand(
    handle: number,
    value: SandboxProviderCommand,
    persistence: ProviderCommandPersistence,
  ) {
    this.stopped.signal.throwIfAborted();
    if (!Number.isSafeInteger(handle) || handle <= 0 || handle > MAX_PROVIDER_COMMAND_HANDLE)
      throw new Error("Invalid retained broker command handle");
    const command = ModalBrokerProviderCommand.parse(value);
    this.requireIdentity(command);
    const current = this.entries.get(handle);
    if (current && !sameCommand(current.command, command))
      throw new Error("Broker handle cannot be rebound to another execution");
    this.entries.set(handle, { command, persistence });
  }

  getProviderCommand(handle: number): ModalBrokerProviderCommand | null {
    const entry = this.entries.get(handle);
    return entry ? structuredClone(entry.command) : null;
  }

  private entry(handle: number) {
    this.stopped.signal.throwIfAborted();
    const entry = this.entries.get(handle);
    if (!entry?.persistence)
      throw new ModalProcessObservationUnavailableError(handle, { reason: "missing_handle" });
    return { ...entry, persistence: entry.persistence };
  }

  private controller(entry: Entry & { persistence: ProviderCommandPersistence }) {
    return new NativeBrokerRetainedCommand(
      entry.command,
      entry.persistence,
      this.options.journal,
      this.options.coordinator,
    );
  }

  private format(handle: number, page: ProviderCommandOutput, tokens?: number) {
    // Receipt identities are generated by the host, not parsed from guest text.
    // Bound abandoned presentation receipts; durable output is not in this map.
    if (this.receipts.size >= 256)
      throw new Error("Broker session has too many unconsumed presentation receipts");
    const text = [
      `Provider output receipt: ${crypto.randomUUID()}`,
      page.exitCode === null
        ? `Process running with session ID ${handle}`
        : `Process exited with code ${page.exitCode}`,
      "Output:",
      truncateOutput(page.chunks.map((chunk) => chunk.text).join(""), tokens).text,
    ].join("\n");
    this.receipts.set(text, structuredClone(page));
    return text;
  }

  async execCommand(args: ChannelAExecArgs): Promise<string> {
    this.stopped.signal.throwIfAborted();
    const handle = admittedProviderCommandHandle();
    const protocol = NativeBrokerCommandProtocol.parse(admittedCommandSupervisionProtocol());
    if (handle === undefined)
      throw new Error("Broker commands require canonical mutation admission");
    if (this.entries.has(handle)) throw new Error("Broker command handle is already bound");
    const input = { ...args };
    const environment = { ...this.options.environment() };
    const pending = new AbortController();
    const signal = AbortSignal.any([pending.signal, this.stopped.signal]);
    this.starts.add(pending);
    try {
      await this.verifyCommandSupervisionCapability(protocol);
      signal.throwIfAborted();
      const command = await startNativeBrokerCommand(
        this.options,
        input,
        {
          root: this.options.root,
          environment,
        },
        signal,
      );
      const entry = this.entries.get(handle);
      if (entry && !sameCommand(entry.command, command))
        throw new ProviderCommandStartOutcomeUnknownError(
          command,
          new Error("Broker reservation binding changed"),
        );
      this.entries.set(handle, entry ?? { command });
      // No user-code release before the routing layer confirms its reservation.
      return this.format(handle, { command, chunks: [], exitCode: null }, input.maxOutputTokens);
    } catch (cause) {
      if (
        cause instanceof ProviderCommandStartOutcomeUnknownError &&
        cause.command.kind === "modal-broker-v1"
      ) {
        this.requireIdentity(cause.command);
        const entry = this.entries.get(handle);
        if (entry && !sameCommand(entry.command, cause.command))
          throw new Error("Original broker reservation changed after uncertain start", { cause });
        this.entries.set(handle, entry ?? { command: structuredClone(cause.command) });
      }
      throw cause;
    } finally {
      this.starts.delete(pending);
    }
  }

  async releaseSupervisedCommand(handle: number) {
    await this.controller(this.entry(handle)).release(this.stopped.signal);
  }

  async cancelSupervisedCommand(handle: number, reason: "provider_deadline" | "explicit_stop") {
    await this.controller(this.entry(handle)).cancel(reason, this.stopped.signal);
    return true;
  }

  async cancelPendingExecCommand() {
    for (const start of this.starts)
      start.abort(new Error("Original broker start observation cancelled"));
  }

  getProviderCommandOutput(result: unknown) {
    const page = typeof result === "string" ? this.receipts.get(result) : undefined;
    return page ? structuredClone(page) : null;
  }

  async captureCommandOutput(result: string) {
    // Every nonempty page was committed by NativeBrokerRetainedCommand.capture
    // before presentation. The empty idle-launch receipt has no bytes to commit.
    return this.receipts.delete(result);
  }

  private async read(
    handle: number,
    args: NonNullable<Parameters<NonNullable<ChannelASession["writeStdin"]>>[0]>,
  ) {
    const requestedBudget = args.yieldTimeMs ?? 250;
    const entry = this.entry(handle);
    const control = this.controller(entry);
    const signal = args.signal
      ? AbortSignal.any([args.signal, this.stopped.signal])
      : this.stopped.signal;
    signal.throwIfAborted();
    const capture = async () => {
      const page = await control.capture(64);
      signal.throwIfAborted();
      entry.command = ModalBrokerProviderCommand.parse(page.command);
      this.entries.set(handle, entry);
      return page;
    };
    try {
      let page = await capture();
      if (page.exitCode === null && !page.chunks.length && !page.hasMore) {
        const status = await control.status(signal);
        if (status.state === "never_started")
          throw new ProviderCommandStartRejectedError(
            new Error("Native cancellation closed the original command before launch"),
          );
        page = await capture();
        const budget = Math.min(50_000, requestedBudget);
        if (budget && page.exitCode === null && !page.chunks.length && !page.hasMore) {
          const deadline = AbortSignal.timeout(budget);
          const wait = AbortSignal.any([signal, deadline]);
          try {
            await this.options.coordinator.observeAfter(entry.command.capture.sequence, wait);
          } catch (cause) {
            signal.throwIfAborted();
            if (!deadline.aborted) throw cause;
          }
          page = await capture();
        }
      }
      if (
        (page.chunks.some((chunk) => chunk.text.length) || page.exitCode !== null) &&
        !(await this.options.journal.read()).output.providerEof
      ) {
        try {
          await this.options.coordinator.acknowledgeOutput(signal);
        } catch (cause) {
          // The page is already durable. An uncertain global window ACK must
          // not discard its presentation. Its original pending journal request
          // still fences later input; this never retries or claims that ACK.
          if (
            !(cause instanceof NativeBrokerDispatchUnknownError) &&
            !(cause instanceof NativeBrokerReconciliationRequiredError)
          )
            throw cause;
        }
      }
      signal.throwIfAborted();
      return this.format(handle, page, args.maxOutputTokens);
    } catch (cause) {
      if (cause instanceof ProviderCommandStartRejectedError) throw cause;
      throw new ProviderCommandObservationUnavailableError(entry.command, cause);
    }
  }

  async writeStdin(args: Parameters<NonNullable<ChannelASession["writeStdin"]>>[0]) {
    if (
      args.yieldTimeMs !== undefined &&
      (!Number.isSafeInteger(args.yieldTimeMs) || args.yieldTimeMs < 0)
    )
      throw new Error("Invalid broker command observation budget");
    const entry = this.entry(args.sessionId);
    if (args.chars) {
      const input = admittedProviderCommandInput();
      const bytes = Buffer.from(args.chars, "utf8");
      if (!input || input.commandId !== entry.command.execId)
        throw new Error("Broker stdin requires its exact canonical child admission");
      if (bytes.length > NATIVE_BROKER_PAYLOAD_MAX_BYTES || bytes.toString("utf8") !== args.chars)
        throw new Error("Broker stdin exceeds one admission's exact UTF-8 payload bound");
      const signal = args.signal
        ? AbortSignal.any([args.signal, this.stopped.signal])
        : this.stopped.signal;
      await this.options.coordinator.sendRetainedStdin(input, bytes, signal);
    }
    return this.read(args.sessionId, args);
  }

  async close() {
    this.stopped.abort(new Error("Broker command session is closed"));
    await this.cancelPendingExecCommand();
    this.receipts.clear();
    this.entries.clear();
  }
}
