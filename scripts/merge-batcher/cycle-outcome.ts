import { AsyncLocalStorage } from "node:async_hooks";
import { ReadUnavailable } from "./read-retry";

// Process-local proof for the *current* child cycle, not a replacement for the
// durable effect journal or the supervisor's prior unknown-outcome checkpoint.
const cycles = new AsyncLocalStorage<{ writes: Set<string>; durable: Set<string> }>();
const deferred = new WeakSet<object>();
function deferrable(error: unknown): error is Error {
  return error instanceof ReadUnavailable;
}
export const OBSERVATION_DEFERRED_EXIT = 75;
export function writeAttempted(key: string): void {
  cycles.getStore()?.writes.add(key);
}
export function writeResolved(key: string): void {
  cycles.getStore()?.writes.delete(key);
}
export function observeDurableUncertainty(ids: string[]): void {
  const cycle = cycles.getStore();
  if (cycle) cycle.durable = new Set(ids);
}
export function observationDeferred(error: unknown): boolean {
  return deferrable(error) && deferred.has(error);
}
export async function observeCycle<T>(step: () => Promise<T>): Promise<T> {
  return cycles.run({ writes: new Set(), durable: new Set() }, async () => {
    try {
      return await step();
    } catch (error) {
      const state = cycles.getStore()!;
      if (deferrable(error)) deferred.delete(error);
      if (deferrable(error) && state.writes.size === 0 && state.durable.size === 0)
        deferred.add(error);
      throw error;
    }
  });
}
