import { AsyncLocalStorage } from "node:async_hooks";
import type { SandboxProviderCommand } from "@opengeni/contracts";

export type ProviderCommandOutput = {
  command: SandboxProviderCommand;
  chunks: Array<{ stream: "stdout" | "stderr"; chunkId: string; text: string }>;
  exitCode: number | null;
  streamFidelity?: "separate" | "merged";
};

/** These callbacks are supplied by the control plane after exact-route
 * retention/adoption. They are never accepted as command arguments. */
export type ProviderCommandPersistence = {
  load(): Promise<SandboxProviderCommand | null>;
  acknowledge(command: SandboxProviderCommand): Promise<SandboxProviderCommand>;
  reserveInput(): Promise<number>;
};

export type ProviderCommandSession = {
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
};

const admission = new AsyncLocalStorage<number>();
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
