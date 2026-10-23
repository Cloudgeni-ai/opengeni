// Only data and navigation state are fixtures; the entire RailBody is production UI.
import { useSyncExternalStore } from "react";
import { client, useAppContext as baseContext, workspaceId } from "./session-sidebar-context";
export { client, workspaceId };
export const RAIL_DEFAULT_WIDTH = 288;
export const RAIL_MIN_WIDTH = 220;
export const RAIL_MAX_WIDTH = 480;
const workspace = {
  id: workspaceId,
  accountId: "preview-org",
  name: "cloudgeni",
  status: "active",
};
const context = {
  ...baseContext(),
  clientConfig: { auth: { mode: "deploymentKey" }, connectedMachines: false },
  workspaces: [workspace],
  workspace,
  managedSelfContext: null,
  authSession: null,
  accessContext: {
    subjectId: "preview-user",
    subjectLabel: "Alex Morgan",
    workspaceGrants: [],
    accountGrants: [
      { accountId: "preview-org", permissions: [], metadata: { accountName: "Cloudgeni" } },
    ],
  },
};
export const useAppContext = () => context;
export const useOptionalAppContext = useAppContext;
let collapsed = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const setCollapsed = (value: boolean) => {
  collapsed = value;
  listeners.forEach((listener) => listener());
};
export function useRail() {
  return {
    workspaceId,
    collapsed: useSyncExternalStore(subscribe, () => collapsed),
    isMobile: false,
    drawerOpen: false,
    width: 288,
    setCollapsed,
    toggleCollapsed: () => setCollapsed(!collapsed),
    setDrawerOpen: () => {},
    openWorkspace: () => {},
    openOrg: () => {},
    startNewSession: () => {},
  };
}
