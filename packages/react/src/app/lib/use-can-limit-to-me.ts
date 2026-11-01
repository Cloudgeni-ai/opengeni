import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useEffect, useState } from "react";

/**
 * Whether this person may make something Only me here, from the same answer
 * the chat composer uses. Unknown fails closed: Only me is never offered on a
 * guess, because the server refuses it when Only me is off.
 */
export function useCanLimitToMe(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  enabled: boolean,
): boolean {
  const [canLimit, setCanLimit] = useState(false);
  useEffect(() => {
    setCanLimit(false);
    if (!enabled) return;
    let current = true;
    void client
      .getSessionTenancyCreateCapabilities(workspaceId)
      .then((capabilities) => {
        if (current) setCanLimit(capabilities.canCreatePrivate === true);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, enabled, workspaceId]);
  return canLimit;
}
