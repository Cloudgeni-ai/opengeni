// The app on screen or kept open behind another page (see app-page.tsx).
import { MessageSquareIcon } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";

import { SiteView } from "../../components/artifacts/site-view";
import { Button } from "../../ui/button";
import { useAppContext } from "../app-context";
import { useAppearance } from "../lib/appearance";
import { useConsoleSiteToolBridge, useConsoleSiteViewer } from "../lib/console-site";
import { useNavigate } from "../lib/navigation";
import { hasWorkspacePermission } from "../lib/permissions";
import { useSiteChatPanelLayout } from "../lib/site-chat-panel";
import { useRecordSiteOpened } from "../lib/site-opened";
import { useSiteLiveVersion } from "../lib/site-live-version";
import { cn } from "../lib/utils";
import { useWindowBarTitle } from "../../ui/window-bar-title";
import { APP_PAGE_ROUTE, splitAppSiteHref } from "./app-page";

// The Site view's chat, loaded the first time someone opens it here.
const AppPageChat = /* @__PURE__ */ lazy(() =>
  import("./site-view").then((module) => ({ default: module.AppPageChat })),
);

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
  const { client, accessContext } = useAppContext();
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
  // The app's chat, for people who can start one with a live app: one
  // button in the app's bottom corner opens it beside the app (under it on
  // a narrow screen), where it can be hidden again.
  const canChat =
    hasWorkspacePermission(accessContext, workspaceId, "sessions:create") &&
    artifact?.status === "active" &&
    Boolean(artifact.currentVersion);
  const { layout, update: updateLayout } = useSiteChatPanelLayout(accessContext.subjectId);
  const [chatOpen, setChatOpen] = useState(false);
  // Mounted on first open, then kept (hidden) so its conversation stays.
  const [chatMounted, setChatMounted] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<"show" | "hide" | null>(null);
  const openChat = useCallback(() => {
    setChatMounted(true);
    setChatOpen(true);
    setFocus("hide");
  }, []);
  const hideChat = useCallback(() => {
    setChatOpen(false);
    setFocus("show");
  }, []);
  const onChatOpen = useCallback((open: boolean) => setChatOpen(open), []);
  // Showing and hiding move focus to the control that undoes it, once it is there.
  useEffect(() => {
    if (!focus) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const target = page.current?.querySelector<HTMLElement>(
        focus === "show" ? "[data-app-page-chat-show]" : "[data-site-chat-hide]",
      );
      if (target) {
        target.focus();
        setFocus(null);
      } else if ((tries += 1) < 60) frame = requestAnimationFrame(attempt);
      else setFocus(null);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [focus]);
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
    <div
      ref={page}
      data-app-page-layout=""
      className={cn(
        "flex min-h-0 min-w-0 flex-1 max-lg:flex-col",
        layout.position === "left" && "lg:flex-row-reverse",
      )}
    >
      {/* Each time the app comes back on screen counts as opening it (Recent apps). */}
      {active ? <RecordAppOpened workspaceId={workspaceId} appId={appId} /> : null}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
          archivedMessage="This app is archived."
          loadingLabel="Opening app…"
          instant
        />
        {canChat && !chatOpen ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Open chat"
            title="Chat"
            aria-expanded={false}
            data-app-page-chat-show=""
            // In the corner, clear of the frame's scrollbar and a phone's home bar.
            className="absolute right-5 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-20 rounded-full bg-bg/90 text-fg-muted shadow-md backdrop-blur-sm hover:text-fg pointer-coarse:size-11"
            onClick={openChat}
          >
            <MessageSquareIcon aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
      </div>
      {canChat && chatMounted ? (
        <Suspense fallback={null}>
          <AppPageChat
            workspaceId={workspaceId}
            siteId={appId}
            live={live}
            layout={layout}
            updateLayout={updateLayout}
            open={chatOpen}
            onOpen={onChatOpen}
            onHide={hideChat}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function RecordAppOpened({ workspaceId, appId }: { workspaceId: string; appId: string }) {
  const { client } = useAppContext();
  useRecordSiteOpened(client, workspaceId, appId);
  return null;
}
