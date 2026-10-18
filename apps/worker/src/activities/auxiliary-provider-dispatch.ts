import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Set while an auxiliary model request (a session title or a generated image)
 * runs the main context's provider dispatch checks. Such a request is a
 * separate provider call, so the main stream's dispatch observer (latency
 * metrics and per-call timing) ignores it while the checks themselves still
 * run in full.
 */
const auxiliaryProviderDispatch = new AsyncLocalStorage<true>();

/** Run the main context's dispatch checks on behalf of an auxiliary request. */
export function runAuxiliaryProviderDispatch<T>(fn: () => T): T {
  return auxiliaryProviderDispatch.run(true, fn);
}

/** Whether the current provider dispatch belongs to an auxiliary request. */
export function isAuxiliaryProviderDispatch(): boolean {
  return auxiliaryProviderDispatch.getStore() === true;
}
