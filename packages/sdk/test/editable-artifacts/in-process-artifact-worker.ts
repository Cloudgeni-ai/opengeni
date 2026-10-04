import type {
  ArtifactWorkerClientEndpoint,
  ArtifactWorkerClientErrorEvent,
  ArtifactWorkerClientMessageEvent,
} from "../../src/editable-artifacts/worker/browser-client";
import type { ArtifactWorkerKernelAdapter } from "../../src/editable-artifacts/worker/kernel-adapter";
import type { ArtifactWorkerRpcMessage } from "../../src/editable-artifacts/worker/rpc-protocol";
import {
  ArtifactWorkerRuntime,
  type ArtifactWorkerMessageEvent,
  type ArtifactWorkerRuntimeEndpoint,
} from "../../src/editable-artifacts/worker/runtime";

export class InProcessArtifactWorker implements ArtifactWorkerClientEndpoint {
  private readonly mainMessageListeners = new Set<
    (event: ArtifactWorkerClientMessageEvent) => void
  >();
  private readonly mainErrorListeners = new Set<(event: ArtifactWorkerClientErrorEvent) => void>();
  private readonly workerMessageListeners = new Set<(event: ArtifactWorkerMessageEvent) => void>();
  private readonly runtime: ArtifactWorkerRuntime;
  private terminated = false;

  constructor(adapter: ArtifactWorkerKernelAdapter) {
    const endpoint: ArtifactWorkerRuntimeEndpoint = {
      addEventListener: (_type, listener) => this.workerMessageListeners.add(listener),
      removeEventListener: (_type, listener) => this.workerMessageListeners.delete(listener),
      postMessage: (message, transfer) => this.deliverToMain(message, transfer),
    };
    this.runtime = new ArtifactWorkerRuntime({ endpoint, loadAdapter: async () => adapter });
  }

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: ArtifactWorkerClientMessageEvent) => void)
      | ((event: ArtifactWorkerClientErrorEvent) => void),
  ): void {
    if (type === "message") {
      this.mainMessageListeners.add(listener as (event: ArtifactWorkerClientMessageEvent) => void);
    } else {
      this.mainErrorListeners.add(listener as (event: ArtifactWorkerClientErrorEvent) => void);
    }
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: ArtifactWorkerClientMessageEvent) => void)
      | ((event: ArtifactWorkerClientErrorEvent) => void),
  ): void {
    if (type === "message") {
      this.mainMessageListeners.delete(
        listener as (event: ArtifactWorkerClientMessageEvent) => void,
      );
    } else {
      this.mainErrorListeners.delete(listener as (event: ArtifactWorkerClientErrorEvent) => void);
    }
  }

  postMessage(message: ArtifactWorkerRpcMessage, transfer: Transferable[]): void {
    if (this.terminated) throw new Error("worker terminated");
    const cloned = structuredClone(message, { transfer });
    queueMicrotask(() => {
      if (this.terminated) return;
      for (const listener of this.workerMessageListeners) listener({ data: cloned });
    });
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    void this.runtime.dispose();
  }

  private deliverToMain(message: ArtifactWorkerRpcMessage, transfer: Transferable[]): void {
    const cloned = structuredClone(message, { transfer });
    queueMicrotask(() => {
      for (const listener of this.mainMessageListeners) listener({ data: cloned });
    });
  }
}
