// The app on screen or kept open behind another page (see app-page.tsx).
import { useCallback, useRef } from "react";

import { SiteView } from "../../components/artifacts/site-view";
import { useAppContext } from "../app-context";
import { useAppearance } from "../lib/appearance";
import { useConsoleSiteToolBridge, useConsoleSiteViewer } from "../lib/console-site";
import { useNavigate } from "../lib/navigation";
import { useRecordSiteOpened } from "../lib/site-opened";
import { useSiteLiveVersion } from "../lib/site-live-version";
import { useWindowBarTitle } from "../../ui/window-bar-title";
import { APP_PAGE_ROUTE, splitAppSiteHref } from "./app-page";

export function AppPage({
  workspaceId,
  appId,
  siteHref,
  active,
}: {
  workspaceId: string;
  appId: string;
  siteHref: string;
  active: boolean;
}) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const viewer = useConsoleSiteViewer();
  const { resolvedTheme } = useAppearance();
  const consoleToolBridge = useConsoleSiteToolBridge(workspaceId);
  const live = useSiteLiveVersion(client, workspaceId, appId);
  const subscribeDataChanges = live.subscribeDataChanges;
  const toolBridge = useCallback<typeof consoleToolBridge>(
    (site) => {
      const bridge = consoleToolBridge(site);
      return bridge && site?.artifactId === appId ? { ...bridge, subscribeDataChanges } : bridge;
    },
    [appId, consoleToolBridge, subscribeDataChanges],
  );
  const artifact = live.detail?.artifact;
  // Only the app on screen names the window bar.
  useWindowBarTitle(active ? (artifact?.title ?? null) : null, !active, { copyable: true });
  const activeRef = useRef(active);
  activeRef.current = active;
  const onSiteLocationChange = useCallback(
    (href: string, options: { replace: boolean }) => {
      // An app kept open behind another page never moves the page.
      if (!activeRef.current) return;
      const { splat, at } = splitAppSiteHref(href);
      void navigate({
        to: APP_PAGE_ROUTE,
        params: { workspaceId, appId, _splat: splat },
        search: at ? { at } : {},
        ...(options.replace ? { replace: true } : {}),
      });
    },
    [appId, navigate, workspaceId],
  );
  return (
    <>
      {/* Each time the app comes back on screen counts as opening it (Recent apps). */}
      {active ? <RecordAppOpened workspaceId={workspaceId} appId={appId} /> : null}
      <SiteView
        client={client}
        workspaceId={workspaceId}
        siteId={appId}
        toolBridge={toolBridge}
        viewer={viewer}
        siteLocation={siteHref}
        onSiteLocationChange={onSiteLocationChange}
        theme={resolvedTheme}
        showToolbar={false}
        versionId={artifact ? (artifact.currentVersion?.id ?? null) : undefined}
        watch={live.watch}
        archivedMessage="This App is archived."
        loadingLabel="Opening App…"
        instant
      />
    </>
  );
}

function RecordAppOpened({ workspaceId, appId }: { workspaceId: string; appId: string }) {
  const { client } = useAppContext();
  useRecordSiteOpened(client, workspaceId, appId);
  return null;
}
