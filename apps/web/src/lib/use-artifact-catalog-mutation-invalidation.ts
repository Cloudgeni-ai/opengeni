import { useCallback, useEffect, useRef } from "react";

/** A delayed save updates both clients' caches, but never another mounted workspace. */
export function useArtifactCatalogMutationInvalidation(
  client: object,
  workspaceId: string,
  invalidate: (client: object, workspaceId: string) => void,
) {
  const latest = useRef<{ client: object; workspaceId: string } | null>(null);
  useEffect(() => {
    const scope = { client, workspaceId };
    latest.current = scope;
    return () => {
      if (latest.current === scope) latest.current = null;
    };
  }, [client, workspaceId]);

  return useCallback(() => {
    invalidate(client, workspaceId);
    const current = latest.current;
    if (current?.workspaceId === workspaceId && current.client !== client)
      invalidate(current.client, workspaceId);
  }, [client, workspaceId, invalidate]);
}
