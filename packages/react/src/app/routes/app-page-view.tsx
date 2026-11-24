// The app on screen or kept open behind another page (see app-page.tsx).
import { MessageSquareIcon } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { SiteView } from "../../components/artifacts/site-view";
import { Button } from "../../ui/button";
import { useAppContext } from "../app-context";
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
  // The app's chat, for people who can start one with a live app: one icon
  // button opens it beside the app (under it on a narrow screen), where it
  // can be hidden again. The button is never drawn over the app, so it can't
  // cover the app's own controls: it sits in the macOS window bar, in the
  // phone's top strip, or else in a slim row above the app.
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
  // On a phone, the canvas's top strip (menu and brand) has room at its end.
  // It shows only in the phone layout, so it comes and goes as the window
  // is resized.
  const [stripEnd, setStripEnd] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      setStripEnd(null);
      return;
    }
    const find = () => setStripEnd(document.querySelector<HTMLElement>("[data-canvas-strip-end]"));
    find();
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(find);
    };
    window.addEventListener("resize", later);
    return () => {
      window.removeEventListener("resize", later);
      cancelAnimationFrame(frame);
    };
  }, [active]);
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
  // Only the app on screen places its button outside its own column.
  const placement = !active
    ? "row"
    : inWindowBar
      ? "window-bar"
      : stripEnd?.isConnected
        ? "strip"
        : "row";
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
        {chatButton && placement === "row" ? (
          <div
            data-app-page-chat-row=""
            className="flex h-10 shrink-0 items-center justify-end bg-canvas px-2"
          >
            {chatButton}
          </div>
        ) : null}
        {chatButton && placement === "window-bar" ? (
          <WindowBarEndControls>{chatButton}</WindowBarEndControls>
        ) : null}
        {chatButton && placement === "strip" && stripEnd
          ? createPortal(chatButton, stripEnd)
          : null}
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
