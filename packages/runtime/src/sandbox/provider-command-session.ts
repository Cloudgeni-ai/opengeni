import { AsyncLocalStorage } from "node:async_hooks";
import type {
  SandboxProviderCommand,
  ModalRouterProviderCommand,
  CommandSupervisionReceipt,
} from "@opengeni/contracts";

export type ProviderCommandOutput = {
  command: SandboxProviderCommand;
  /** Exact read baseline for atomic byte-offset capture; absent for legacy pages. */
  expected?: ModalRouterProviderCommand;
  chunks: Array<{ stream: "stdout" | "stderr"; chunkId: string; text: string }>;
  exitCode: number | null;
  streamFidelity?: "separate" | "merged";
};

/** These callbacks are supplied by the control plane after exact-route
 * retention/adoption. They are never accepted as command arguments. */
export type ProviderCommandPersistence = {
  load(): Promise<SandboxProviderCommand | null>;
  acknowledge(command: SandboxProviderCommand): Promise<SandboxProviderCommand>;
  reserveInput(byteLength?: number): Promise<number>;
  recordSupervisionReceipt?(receipt: CommandSupervisionReceipt): Promise<void>;
  loadSupervisionReceipt?(): Promise<CommandSupervisionReceipt | null>;
  requestCancellation?(reason: "provider_deadline" | "explicit_stop"): Promise<void>;
  cancellationRequested?(): Promise<boolean>;
  captureRouterPage?(page: {
    expected: ModalRouterProviderCommand;
    command: ModalRouterProviderCommand;
    stdout: string;
    stderr: string;
  }): Promise<{ command: ModalRouterProviderCommand; captured: boolean }>;
};

export type ProviderCommandSession = {
  releaseSupervisedCommand?(handle: number): Promise<void>;
  cancelSupervisedCommand?(
    handle: number,
    reason: "provider_deadline" | "explicit_stop",
  ): Promise<boolean>;
  /** Abort only starts/initial observations still owned by this session call. */
  cancelPendingExecCommand?(): Promise<void>;
  getProviderCommand?(handle: number): SandboxProviderCommand | null;
  bindProviderCommand?(
    handle: number,
    command: SandboxProviderCommand,
    persistence: ProviderCommandPersistence,
  ): void;
  getProviderCommandOutput?(result: unknown): ProviderCommandOutput | null;
  acknowledgeCommandOutput?(result: string): Promise<void>;
  /** Returns false for a legacy receipt. True means bytes and offsets committed
   * together (or the page lost a cursor CAS and was safely discarded). */
  captureCommandOutput?(result: string): Promise<boolean>;
};

const admission = new AsyncLocalStorage<number>();
export type PendingCommandSupervision = { managed: boolean };
const pendingSupervision = new AsyncLocalStorage<PendingCommandSupervision>();
export function withPendingCommandSupervision<T>(
  state: PendingCommandSupervision | undefined,
  fn: () => T,
): T {
  return state ? pendingSupervision.run(state, fn) : fn();
}
/** Called only by the provider adapter before dispatching an idle supervisor. */
export function markPendingCommandSupervised(): void {
  const state = pendingSupervision.getStore();
  if (state) state.managed = true;
}
const supervisionReady = new AsyncLocalStorage<boolean>();
export function withCommandSupervisionReady<T>(ready: boolean, fn: () => T): T {
  return supervisionReady.run(ready, fn);
}
export function admittedCommandSupervisionReady(): boolean {
  return supervisionReady.getStore() === true;
}
export const MAX_PROVIDER_COMMAND_HANDLE = 2147483647;

/** The alias is allocated by serialized workspace mutation admission, not by
 * an SDK instance or a process-writable counter. It remains route-scoped. */
export function withProviderCommandHandle<T>(handle: number | undefined, fn: () => T): T {
  if (handle === undefined) return fn();
  if (!Number.isSafeInteger(handle) || handle <= 0 || handle > MAX_PROVIDER_COMMAND_HANDLE)
    throw new Error("Invalid admitted provider command handle");
  return admission.run(handle, fn);
}

export function admittedProviderCommandHandle(): number | undefined {
  return admission.getStore();
}
