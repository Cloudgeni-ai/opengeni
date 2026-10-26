// One tool call's view of the routed sandbox: whether any of its operations
// got past route resolution. A call whose first resolution is refused because
// the session's route moved (another workspace root, or a home this attempt
// cannot reach) has provably started nothing, so its tool can say exactly that
// instead of failing the whole attempt with siblings' outcomes unknown.
//
// The same view lets an attempt that ends settle a command call as not
// started when every one of its operations was still waiting for, or had
// failed in, route resolution (for example while its sandbox was being
// created): settling it closes the call, so none of its operations gets past
// resolution afterward.
//
// Dependency-free (node:async_hooks only) so the routing proxy can mark the
// scope and the tool wrappers can read it without an import cycle.

import { AsyncLocalStorage } from "node:async_hooks";

export type RoutedCallScope = {
  /** An operation of this call got past route resolution. */
  routeResolved: boolean;
  /** Route resolutions of this call still under way. */
  resolving: number;
  /** A route resolution of this call failed. */
  resolutionFailed: boolean;
  /** Settled as not started: no operation of it may get past resolution. */
  settledNotStarted: boolean;
};

const storage = new AsyncLocalStorage<RoutedCallScope>();

/** Thrown where an operation of a call already settled as not started would
 * have got past route resolution, so it never reaches the sandbox. */
export class RoutedCallSettledNotStartedError extends Error {
  constructor() {
    super("This call was already settled as not started; its operation was not sent");
    this.name = "RoutedCallSettledNotStartedError";
  }
}

export function newRoutedCallScope(): RoutedCallScope {
  return { routeResolved: false, resolving: 0, resolutionFailed: false, settledNotStarted: false };
}

/** Record that the current tool call reached a resolved route. From here on,
 * a later refusal can no longer prove that the call started nothing. A call
 * already settled as not started is refused here instead, before its
 * operation is sent. */
export function noteRoutedCallRouteResolved(): void {
  const scope = storage.getStore();
  if (!scope) return;
  if (scope.settledNotStarted) throw new RoutedCallSettledNotStartedError();
  scope.routeResolved = true;
}

/** Run one route resolution of the current tool call, recording that it is
 * under way and whether it failed. */
export async function resolveRoutedCallRoute<T>(resolve: () => Promise<T>): Promise<T> {
  const scope = storage.getStore();
  if (!scope) return await resolve();
  scope.resolving += 1;
  try {
    return await resolve();
  } catch (error) {
    scope.resolutionFailed = true;
    throw error;
  } finally {
    scope.resolving -= 1;
  }
}

/**
 * Settle a call as not started if none of its operations got past route
 * resolution and one is waiting for or failed in it: nothing it asked of the
 * sandbox was sent. From then on its operations are refused at resolution.
 * A call with no resolution under way or failed proves nothing (it may run
 * without the routed sandbox) and is left alone.
 */
export function settleRoutedCallNotStarted(scope: RoutedCallScope): boolean {
  if (scope.settledNotStarted) return true;
  if (scope.routeResolved || (scope.resolving === 0 && !scope.resolutionFailed)) return false;
  scope.settledNotStarted = true;
  return true;
}

/**
 * Run one tool call in its own routed-call scope. When it fails with an error
 * `isRefusal` accepts and none of its operations had resolved a route,
 * `notStarted` supplies the call's result instead of the failure.
 */
export async function runRoutedToolCall<T>(
  call: () => Promise<T>,
  isRefusal: (error: unknown) => boolean,
  notStarted: () => T,
  scope: RoutedCallScope = newRoutedCallScope(),
): Promise<T> {
  try {
    return await storage.run(scope, call);
  } catch (error) {
    if (!scope.routeResolved && isRefusal(error)) return notStarted();
    throw error;
  }
}
