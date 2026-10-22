// One tool call's view of the routed sandbox: whether any of its operations
// got past route resolution. A call whose first resolution is refused because
// the session's route moved (another workspace root, or a home this attempt
// cannot reach) has provably started nothing, so its tool can say exactly that
// instead of failing the whole attempt with siblings' outcomes unknown.
//
// Dependency-free (node:async_hooks only) so the routing proxy can mark the
// scope and the tool wrappers can read it without an import cycle.

import { AsyncLocalStorage } from "node:async_hooks";

type RoutedCallScope = { routeResolved: boolean };

const storage = new AsyncLocalStorage<RoutedCallScope>();

/** Record that the current tool call reached a resolved route. From here on,
 * a later refusal can no longer prove that the call started nothing. */
export function noteRoutedCallRouteResolved(): void {
  const scope = storage.getStore();
  if (scope) scope.routeResolved = true;
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
): Promise<T> {
  const scope: RoutedCallScope = { routeResolved: false };
  try {
    return await storage.run(scope, call);
  } catch (error) {
    if (!scope.routeResolved && isRefusal(error)) return notStarted();
    throw error;
  }
}
