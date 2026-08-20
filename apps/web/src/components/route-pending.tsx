import { LoadingPanel } from "@/components/common";

export function RoutePending() {
  return <LoadingPanel label="Loading page" />;
}

/**
 * A pending component makes TanStack Router install a Suspense boundary at
 * every route match. In particular, a cold lazy workspace leaf is then caught
 * inside WorkspaceShell instead of bubbling to the root Outlet and hiding the
 * persistent rail.
 */
export const ROUTER_PENDING_OPTIONS = {
  defaultPendingComponent: RoutePending,
} as const;
