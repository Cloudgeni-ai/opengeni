import { useEffect, useMemo, useState } from "react";
import type { SidebarLayoutResponse } from "@opengeni/sdk";
import { useAccount } from "@/account";
import {
  cachedSidebarLayout,
  refreshSidebarLayout,
  sidebarHiddenEntries,
  sidebarLayoutKey,
  subscribeSidebarLayout,
} from "@/sidebar-layout";

/**
 * The sidebar layout of the account's current workspace, as the side menu
 * last read it; read once here when nothing is kept yet.
 */
export function useSidebarLayout(): SidebarLayoutResponse | null {
  const { client, account, workspaceId } = useAccount();
  const key = account && workspaceId ? sidebarLayoutKey(account.id, workspaceId) : null;
  const [layout, setLayout] = useState(() => (key ? cachedSidebarLayout(key) : null));
  useEffect(() => {
    setLayout(key ? cachedSidebarLayout(key) : null);
    if (!key || !workspaceId) return;
    const stop = subscribeSidebarLayout(key, setLayout);
    if (!cachedSidebarLayout(key)) void refreshSidebarLayout(client, key, workspaceId);
    return stop;
  }, [client, key, workspaceId]);
  return layout;
}

/** The built-in entries this person (or the workspace default) hides. */
export function useSidebarHiddenEntries(): string[] {
  const layout = useSidebarLayout();
  return useMemo(() => sidebarHiddenEntries(layout), [layout]);
}
