/**
 * The console's private seam to the client-scoped read cache inside
 * `@opengeni/react` (account lists and usage readings shared by the session
 * account switcher and Settings > Models).
 *
 * Every export of a `@opengeni/react` entry point is permanent public API, and
 * hosts need none of these primitives: they get the cache through the hooks and
 * opt into keeping reads across mounts with `OpenGeniProvider`'s
 * `retainReadsAcrossMounts`. The console therefore imports the source modules
 * directly, as its fixtures already do, and keeps them out of the package surface.
 */
import { useEffect } from "react";

import {
  invalidateSharedQueries,
  retainSharedQueries,
} from "../../../../packages/react/src/hooks/shared-query";

export {
  clearSharedQueries,
  invalidateSharedQueries,
  isSharedQueryAccessRefusal,
  peekSharedQuery,
  retainSharedQueries,
  sharedQueryWriter,
  useSharedQuery,
  useSharedQueryValue,
  type SharedQueryKey,
  type SharedQueryWriter,
} from "../../../../packages/react/src/hooks/shared-query";
export {
  codexAccountsQueryKey,
  codexLiveUsageQueryKey,
  recordCodexLiveUsage,
  type CodexLiveUsageSnapshot,
} from "../../../../packages/react/src/hooks/use-codex-accounts";

/**
 * Every retained subscription account list for a client: Codex (workspace,
 * session and organization lists), the Claude/SuperGrok/xAI pools and the
 * SuperGrok switcher list. For changes that can alter which accounts a
 * workspace sees, such as an "Available in" save.
 */
export function invalidateSubscriptionAccountQueries(client: object): Promise<void> {
  return Promise.all(
    [["codex-accounts"], ["subscription-pool"], ["supergrok-accounts"]].map((prefix) =>
      invalidateSharedQueries(client, prefix),
    ),
  ).then(() => undefined);
}

/** The window event pages dispatch after a model connection or its availability changes. */
export const MODEL_CONNECTIONS_CHANGED = "model-connections-changed";

/**
 * The console's cache wiring for its API client (called once, at the root that
 * owns `client`):
 *
 * - Reads made through `client` are kept across navigation. The console
 *   creates a new client on every identity change, so they never outlive the
 *   person they were read for: switching clients releases (and clears) the
 *   previous one.
 * - A `model-connections-changed` event (an "Available in" or default change)
 *   re-reads every mounted subscription account list and drops the rest.
 */
export function useConsoleSharedQueries(client: object): void {
  useEffect(() => retainSharedQueries(client), [client]);
  useEffect(() => {
    const changed = () => void invalidateSubscriptionAccountQueries(client);
    window.addEventListener(MODEL_CONNECTIONS_CHANGED, changed);
    return () => window.removeEventListener(MODEL_CONNECTIONS_CHANGED, changed);
  }, [client]);
}
