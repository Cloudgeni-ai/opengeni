import type { ModalClient } from "modal";
import { createModalSingleDispatchClient } from "./modal-legacy-command-control";
import type { NativeBrokerChannel } from "./native-command-broker-driver";
import type { NativeBrokerOutputPage } from "./native-command-broker-output";
import { NATIVE_BROKER_FRAME_MAX_BYTES } from "./native-command-broker-wire";
import {
  NativeBrokerInitialDiagnosticsError,
  type NativeBrokerDiagnosticsPage,
} from "./native-command-broker-diagnostics";

type Port = Pick<
  ModalClient["cpClient"],
  "sandboxGetTaskId" | "sandboxGetLogs" | "sandboxStdinWrite"
>;
type Binding = { sandboxId: string; taskId: string };
const locator = /^[A-Za-z0-9_-]{1,200}$/;

/** Version-specific RPC adapter, with no provider TaskExec or guest filesystem
 * access. Construction is internal and does not certify creation/bootstrap.
 * The injected port must be the single-dispatch client (unit tests inject it). */
export class ModalNativeBrokerChannel implements NativeBrokerChannel {
  readonly sandboxId: string;
  readonly taskId: string;
  private closed = false;

  constructor(
    private readonly port: Port,
    binding: Binding,
    private readonly closeClient: () => void,
  ) {
    if (
      !locator.test(binding.sandboxId) ||
      !binding.sandboxId.startsWith("sb-") ||
      !locator.test(binding.taskId)
    )
      throw new Error("Invalid native broker physical binding");
    this.sandboxId = binding.sandboxId;
    this.taskId = binding.taskId;
  }

  static fromClient(client: ModalClient, binding: Binding) {
    const controlled = createModalSingleDispatchClient(client);
    try {
      return new ModalNativeBrokerChannel(controlled.cpClient, binding, () => controlled.close());
    } catch (error) {
      controlled.close();
      throw error;
    }
  }

  private signal(signal?: AbortSignal) {
    if (this.closed) throw new Error("Native broker channel is closed");
    signal?.throwIfAborted();
    // Observation containment, never a command run-length deadline.
    const timeout = AbortSignal.timeout(60_000);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  async write(input: { index: number; input: Uint8Array; eof: false }, signal?: AbortSignal) {
    if (
      !Number.isInteger(input.index) ||
      input.index < 1 ||
      input.index > 0xffffffff ||
      input.eof !== false ||
      !(input.input instanceof Uint8Array) ||
      input.input.length < 1 ||
      input.input.length > NATIVE_BROKER_FRAME_MAX_BYTES
    )
      throw new Error("Invalid native broker indexed input");
    const bounded = this.signal(signal);
    const task = await this.port.sandboxGetTaskId(
      { sandboxId: this.sandboxId, timeout: 10, waitUntilReady: true },
      { signal: bounded },
    );
    if (task.taskId !== this.taskId || task.taskResult)
      throw new Error("Native broker initial task no longer matches");
    bounded.throwIfAborted();
    if (this.closed) throw new Error("Native broker channel is closed");
    await this.port.sandboxStdinWrite({ sandboxId: this.sandboxId, ...input }, { signal: bounded });
  }

  async *output(cursor: string, signal?: AbortSignal): AsyncGenerator<NativeBrokerOutputPage> {
    if (typeof cursor !== "string" || !cursor.length || cursor.length > 200)
      throw new Error("Invalid native broker output cursor");
    const bounded = this.signal(signal);
    const task = await this.port.sandboxGetTaskId(
      { sandboxId: this.sandboxId, timeout: 10, waitUntilReady: true },
      { signal: bounded },
    );
    // Page responses identify the sandbox, not its task. Do not relabel them
    // with a caller-supplied task without checking the authenticated provider.
    // A terminal exact task may still have retained output; it is not a new
    // input target and this read does not certify command settlement.
    if (task.taskId !== this.taskId)
      throw new Error("Native broker initial task no longer matches");
    bounded.throwIfAborted();
    if (this.closed) throw new Error("Native broker channel is closed");
    for await (const page of this.port.sandboxGetLogs(
      {
        sandboxId: this.sandboxId,
        fileDescriptor: 1,
        timeout: 55,
        lastEntryId: cursor,
      },
      { signal: bounded },
    )) {
      bounded.throwIfAborted();
      if (this.closed) throw new Error("Native broker channel is closed");
      const items: NativeBrokerOutputPage["items"] = page.items.map((item) => {
        if (item.fileDescriptor !== 1)
          throw new Error("Native broker stdout contains a foreign stream");
        return { fileDescriptor: 1, data: item.data };
      });
      yield {
        sandboxId: this.sandboxId,
        taskId: this.taskId,
        requestedFileDescriptor: 1,
        entryId: page.entryId,
        items,
        eof: page.eof,
      };
    }
  }

  /** Disposes only the host RPC connection. Does not close initial stdin,
   * terminate the sandbox, ACK output, or claim any command is settled. */
  close() {
    if (!this.closed) {
      this.closed = true;
      this.closeClient();
    }
  }

  /** Separate bounded initial-stderr query. Unlike a command stream, any
   * nonempty data is a broker diagnostic. A normal one-second server-query
   * completion is observable; abort/error is never converted into clean EOF.
   * Check task liveness on both sides, without launching an exec or retrying. */
  async *diagnostics(
    cursor: string,
    signal?: AbortSignal,
  ): AsyncGenerator<NativeBrokerDiagnosticsPage> {
    if (typeof cursor !== "string" || !cursor.length || cursor.length > 200)
      throw new Error("Invalid native broker diagnostic cursor");
    const bounded = this.signal(signal);
    const checkTask = async () => {
      bounded.throwIfAborted();
      if (this.closed) throw new Error("Native broker channel is closed");
      const task = await this.port.sandboxGetTaskId(
        { sandboxId: this.sandboxId, timeout: 1, waitUntilReady: false },
        { signal: bounded },
      );
      if (task.taskId !== this.taskId || task.taskResult)
        throw new Error("Native broker diagnostic task is not the live initial process");
      bounded.throwIfAborted();
      if (this.closed) throw new Error("Native broker channel is closed");
    };
    await checkTask();
    for await (const page of this.port.sandboxGetLogs(
      { sandboxId: this.sandboxId, fileDescriptor: 2, timeout: 1, lastEntryId: cursor },
      { signal: bounded },
    )) {
      bounded.throwIfAborted();
      if (this.closed) throw new Error("Native broker channel is closed");
      yield {
        sandboxId: this.sandboxId,
        taskId: this.taskId,
        requestedFileDescriptor: 2,
        entryId: page.entryId,
        eof: page.eof,
        items: page.items.map((item) => {
          if (item.fileDescriptor !== 2)
            throw new NativeBrokerInitialDiagnosticsError(
              Object.freeze({
                version: 1,
                sandboxId: this.sandboxId,
                taskId: this.taskId,
                reason: "invalid_page",
                page: null,
              }),
            );
          return { fileDescriptor: 2 as const, data: item.data };
        }),
      };
    }
    await checkTask();
  }
}
