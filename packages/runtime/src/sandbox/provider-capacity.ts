import { SandboxProviderError } from "@openai/agents/sandbox";
import { ServiceBusyError } from "e2b";

/**
 * A sandbox provider's own typed "no capacity to place a sandbox right now".
 * E2B raises ServiceBusyError (HTTP 503) for it; the agents SDK keeps it as the
 * `cause` of the SandboxProviderError it throws. Compute's equivalent is
 * ComputeControlError with kind `no_capacity`.
 */
export function isSandboxProviderCapacityError(error: unknown): boolean {
  return error instanceof ServiceBusyError;
}

/** The agents SDK's wrapper around a sandbox provider SDK's own failure. */
export function isSandboxProviderError(error: unknown): boolean {
  return error instanceof SandboxProviderError;
}
