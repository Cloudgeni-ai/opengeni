import { SandboxProviderError } from "@openai/agents/sandbox";

type ErrorClass = abstract new (...args: never[]) => Error;

// The agents SDK loads the E2B SDK only when an E2B sandbox is used, so this
// module must not import it eagerly. A ServiceBusyError can only exist once
// the SDK is loaded; the E2B provider registers the class before first use.
let e2bServiceBusyError: ErrorClass | null = null;
let e2bLoad: Promise<ErrorClass | null> | null = null;

/** Resolve (once) E2B's typed no-capacity error class, the one its SDK throws. */
export function loadE2BServiceBusyError(): Promise<ErrorClass | null> {
  e2bLoad ??= import("e2b").then(
    (module) => (e2bServiceBusyError = module.ServiceBusyError),
    () => null,
  );
  return e2bLoad;
}

/**
 * A sandbox provider's own typed "no capacity to place a sandbox right now".
 * E2B raises ServiceBusyError (HTTP 503) for it; the agents SDK keeps it as the
 * `cause` of the SandboxProviderError it throws. Compute's equivalent is
 * ComputeControlError with kind `no_capacity`.
 */
export function isSandboxProviderCapacityError(error: unknown): boolean {
  return e2bServiceBusyError !== null && error instanceof e2bServiceBusyError;
}

/** The agents SDK's wrapper around a sandbox provider SDK's own failure. */
export function isSandboxProviderError(error: unknown): boolean {
  return error instanceof SandboxProviderError;
}
