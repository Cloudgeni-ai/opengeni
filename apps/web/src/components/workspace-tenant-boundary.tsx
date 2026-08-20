import { useLayoutEffect, type ReactNode } from "react";

import { LoadingPanel } from "@/components/common";

/**
 * A display-only fence between the routed workspace and mutable console state.
 * Server grants remain the authority. This boundary only prevents a newly
 * routed workspace from rendering with the previous workspace's cached UI
 * state while the provider clears that state.
 */
export function WorkspaceTenantBoundary(props: {
  workspaceId: string;
  stateOwnerWorkspaceId: string | null;
  prepareTransition: (workspaceId: string) => void;
  children: ReactNode;
}) {
  const { children, prepareTransition, stateOwnerWorkspaceId, workspaceId } = props;
  const ready = stateOwnerWorkspaceId === workspaceId;

  useLayoutEffect(() => {
    if (!ready) {
      prepareTransition(workspaceId);
    }
  }, [prepareTransition, ready, workspaceId]);

  if (!ready) {
    return <LoadingPanel label="Switching workspace" />;
  }

  return children;
}
