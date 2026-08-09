import { loadBrowserWasmKernelAdapter } from "./kernel-adapter";
import {
  ArtifactWorkerRuntime,
  type ArtifactWorkerMessageEvent,
  type ArtifactWorkerRuntimeEndpoint,
} from "./runtime";
import type { ArtifactWorkerRpcMessage } from "./rpc-protocol";

type WorkerScopeCandidate = {
  document?: unknown;
  addEventListener?: unknown;
  removeEventListener?: unknown;
  postMessage?: unknown;
};

/**
 * Dedicated module-Worker entry. Hosts bundle and self-host this file under
 * their CSP, then pass its URL to `createBrowserEditableArtifactWorkerKernel`.
 */
export function installBrowserArtifactWorkerEntry(
  scope: ArtifactWorkerRuntimeEndpoint,
): ArtifactWorkerRuntime {
  return new ArtifactWorkerRuntime({ endpoint: scope, loadAdapter: loadBrowserWasmKernelAdapter });
}

const candidate = globalThis as WorkerScopeCandidate;
if (
  candidate.document === undefined &&
  typeof candidate.addEventListener === "function" &&
  typeof candidate.removeEventListener === "function" &&
  typeof candidate.postMessage === "function"
) {
  installBrowserArtifactWorkerEntry({
    addEventListener(type, listener) {
      (
        candidate.addEventListener as (
          event: string,
          callback: (event: ArtifactWorkerMessageEvent) => void,
        ) => void
      )(type, listener);
    },
    removeEventListener(type, listener) {
      (
        candidate.removeEventListener as (
          event: string,
          callback: (event: ArtifactWorkerMessageEvent) => void,
        ) => void
      )(type, listener);
    },
    postMessage(message: ArtifactWorkerRpcMessage, transfer: Transferable[]) {
      (candidate.postMessage as (message: unknown, transfer: Transferable[]) => void)(
        message,
        transfer,
      );
    },
  });
}
