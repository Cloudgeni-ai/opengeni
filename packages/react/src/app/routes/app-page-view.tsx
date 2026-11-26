// The app on screen or kept open behind another page (see app-page.tsx).
import { MessageSquareIcon } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";

import { SiteView } from "../../components/artifacts/site-view";
import { Button } from "../../ui/button";
import { useAppContext } from "../app-context";
import { SiteActionsMenu, SiteTitleMenu } from "../components/artifacts/site-header-controls";
import {
  SitePublicationControl,
  useSitePublicationLink,
} from "../components/artifacts/site-public-link";
import { SiteVersionMenu } from "../components/artifacts/site-version-menu";
import { WindowBarEndControls } from "../components/window-bar";
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
  const archived = artifact?.status === "archived";
  const canPublish = hasWorkspacePermission(accessContext, workspaceId, "artifacts:publish");
  const publication = useSitePublicationLink({ client, workspaceId, siteId: appId });
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((value) => value + 1), []);
  const openPublishing = useCallback(() => {
    void navigate({
      to: "/workspaces/$workspaceId/sites/$siteId",
      params: { workspaceId, siteId: appId },
      search: { publishing: true },
    });
  }, [appId, navigate, workspaceId]);
  // The app's chat, for people who can start one with a live app: one icon
  // button opens it beside the app (under it on a narrow screen), where it
  // can be hidden again. The button is never drawn over the app, so it can't
  // cover the app's own controls: it sits in the app's header row (in the
  // macOS app, the window bar).
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
      const target =
        focus === "show"
          ? document.querySelector<HTMLElement>(`[data-app-page-chat-show="${appId}"]`)
          : page.current?.querySelector<HTMLElement>("[data-site-chat-hide]");
      if (target) {
        target.focus();
        setFocus(null);
      } else if ((tries += 1) < 60) frame = requestAnimationFrame(attempt);
      else setFocus(null);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [appId, focus]);
  // Only the app on screen names the window bar.
  const inWindowBar = useWindowBarTitle(active ? (artifact?.title ?? null) : null, !active, {
    copyable: true,
  });
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
  const chatButton =
    canChat && !chatOpen ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Open chat"
        title="Chat"
        aria-expanded={false}
        data-app-page-chat-show={appId}
        className="text-fg-muted hover:text-fg pointer-coarse:size-11"
        onClick={openChat}
      >
        <MessageSquareIcon aria-hidden="true" className="size-4" />
      </Button>
    ) : null;
  // The same header wherever the app is opened from: title, version,
  // publication and "…" (settings, pin, archive), then the chat button.
  const controls =
    artifact && !archived ? (
      <>
        {live.detail ? (
          <SiteVersionMenu
            workspaceId={workspaceId}
            siteId={appId}
            detail={live.detail}
            canPublish={canPublish}
            onRestored={live.check}
          />
        ) : null}
        <span data-site-publication-slot="" className="contents">
          <SitePublicationControl
            load={publication.load}
            canPublish={canPublish}
            onOpenPublishing={openPublishing}
          />
        </span>
        <SiteActionsMenu
          workspaceId={workspaceId}
          origin={{ siteId: appId, title: artifact.title }}
          hasVersion={Boolean(artifact.currentVersion)}
          onReload={reload}
        />
        {chatButton}
      </>
    ) : (
      chatButton
    );
  // Only the app on screen places its header in the window bar.
  const inBar = active && inWindowBar;
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Kept while the chat is open, so opening it doesn't resize the app. */}
        {!inBar && artifact ? (
          <div
            data-app-page-header=""
            className="flex h-10 shrink-0 items-center gap-1 bg-canvas px-3"
          >
            <SiteTitleMenu
              workspaceId={workspaceId}
              origin={{ siteId: appId, title: artifact.title }}
            >
              {/* Focusable, so the menu key or Shift+F10 opens its menu. */}
              <span
                tabIndex={0}
                className="min-w-0 truncate rounded-sm text-sm font-medium text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                title={artifact.title}
              >
                {artifact.title}
              </span>
            </SiteTitleMenu>
            <span className="ml-auto flex shrink-0 items-center gap-1">{controls}</span>
          </div>
        ) : null}
        {inBar && controls ? <WindowBarEndControls>{controls}</WindowBarEndControls> : null}
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
          reloadToken={reloadToken}
          versionId={artifact ? (artifact.currentVersion?.id ?? null) : undefined}
          watch={live.watch}
          archivedMessage="This app is archived."
          loadingLabel="Opening app…"
          instant
        />
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
