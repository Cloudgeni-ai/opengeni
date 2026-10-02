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
  /** The provider reports the process exited; only unread output may remain. */
  providerExited?: boolean;
  streamFidelity?: "separate" | "merged";
};

/** These callbacks are supplied by the control plane after exact-route
 * retention/adoption. They are never accepted as command arguments. */
export type ProviderCommandPersistence = {
  rejectSupervisedLaunch?(command: ModalRouterProviderCommand): Promise<void>;
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

export class ProviderCommandStartRejectedError extends Error {
  constructor(cause: unknown) {
    super("Provider rejected command before start", { cause });
    this.name = "ProviderCommandStartRejectedError";
  }
}

/** Start was attempted exactly once, but its acknowledgement is unavailable.
 * The client-chosen locator is reconciliation authority, never replay authority. */
export class ProviderCommandStartOutcomeUnknownError extends Error {
  constructor(
    readonly command: ModalRouterProviderCommand,
    cause: unknown,
  ) {
    super("Provider command Start outcome is unknown; the invocation was not replayed", { cause });
    this.name = "ProviderCommandStartOutcomeUnknownError";
  }
}

/** An already-dispatched invocation could not be observed within this read's
 * budget. The exact locator is read authority, never Start/input replay authority. */
export class ProviderCommandObservationUnavailableError extends Error {
  constructor(
    readonly command: SandboxProviderCommand,
    cause: unknown,
    /** Mixed or unreadable provider graphs can contain observation failure
     * without proving that an automatic read retry is safe. */
    readonly readRetryAllowed = true,
  ) {
    super("Provider command observation unavailable; do not replay the invocation", { cause });
    this.name = "ProviderCommandObservationUnavailableError";
  }
}

export function isProviderCommandObservationUnavailableError(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<object>();
  for (let count = 0; pending.length && count < 32; count++) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ProviderCommandObservationUnavailableError) return true;
    try {
      for (const key of ["cause", "error"] as const) {
        const property = Object.getOwnPropertyDescriptor(current, key);
        if (property && "value" in property) pending.push(property.value);
      }
      const errors = Object.getOwnPropertyDescriptor(current, "errors");
      if (errors && "value" in errors && Array.isArray(errors.value) && errors.value.length <= 16)
        for (let index = 0; index < errors.value.length; index++) {
          const item = Object.getOwnPropertyDescriptor(errors.value, String(index));
          if (item && "value" in item) pending.push(item.value);
        }
    } catch {
      /* Unknown error graphs do not acquire observation authority. */
    }
  }
  return false;
}

export type ProviderCommandSession = {
  verifyCommandSupervisionCapability?(): Promise<{ sandboxId: string; taskId: string }>;
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
type SupervisedLaunchReservation = {
  reserve(command: ModalRouterProviderCommand): Promise<void>;
};
const supervisedLaunch = new AsyncLocalStorage<SupervisedLaunchReservation>();
export function withSupervisedLaunchReservation<T>(
  reservation: SupervisedLaunchReservation,
  fn: () => T,
): T {
  return supervisedLaunch.run(reservation, fn);
}
export async function reserveSupervisedLaunch(command: ModalRouterProviderCommand): Promise<void> {
  const reservation = supervisedLaunch.getStore();
  if (!reservation) throw new Error("Supervised launch requires durable pre-dispatch reservation");
  await reservation.reserve(command);
}
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
