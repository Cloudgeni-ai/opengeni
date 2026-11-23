import {
  SITE_ID_HEADER,
  SITE_VERSION_HEADER,
  siteConversationContext,
} from "@opengeni/contracts/site-session-http";
import type {
  ChatSession as Session,
  SessionEvent,
  ChatSessionListResponse as SessionListResponse,
} from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import {
  ArchiveIcon,
  ArrowLeftRightIcon,
  ArrowLeftIcon,
  CopyIcon,
  LinkIcon,
  Maximize2Icon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PanelLeftCloseIcon,
  PanelRightCloseIcon,
  PinIcon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { SiteView } from "../../artifacts";
import { useArtifactLabels } from "../../components/artifacts/artifact-chrome";
import type { SiteLiveState } from "../../components/artifacts/artifact-sandbox";
import { AppServerStatusLine } from "../components/artifacts/app-server-status";
import { SiteVersionMenu } from "../components/artifacts/site-version-menu";
import { useArtifactsBackLink } from "../components/artifacts/artifact-page-chrome";
import type {
  CreatedConversation,
  NewConversationCreateOptions,
} from "../../hooks/use-new-conversation";
import { Button } from "../../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { useSiteActions } from "../components/artifacts/site-actions";
import { useSiteSidebarActions } from "../lib/site-sidebar-bridge";
import { ResizeHandle } from "../../ui/resize-handle";
import { Skeleton } from "../../ui/skeleton";
import { useAppContext, type SessionCreationHandoff } from "../app-context";
import {
  ChatFileDropCover,
  ChatFileDropRelay,
  ChatFileDropRelayProvider,
} from "../components/session/chat-viewport-file-drop-target";
import { ConsoleNewConversation } from "../components/session/console-new-conversation";
import {
  SitePublicationControl,
  useSitePublicationLink,
} from "../components/artifacts/site-public-link";
import { useAppApi } from "../lib/app-api";
import { useChatOperations } from "../lib/actions/chat-operations";
import { useConsoleSiteToolBridge, useConsoleSiteViewer } from "../lib/console-site";
import { Link, useNavigate, usePage, useRouter } from "../lib/navigation";
import { hasWorkspacePermission } from "../lib/permissions";
import type { SiteViewArtifactsReturn } from "../lib/routes";
import { sessionDisplayTitle } from "../lib/session-rename";
import { sessionSiteOrigin } from "../lib/session-site-origin";
import { SessionUiFeaturesOff } from "../lib/session-ui-features";
import {
  SITE_CHAT_DEFAULT_WIDTH,
  SITE_CHAT_MAX_WIDTH,
  SITE_CHAT_MIN_WIDTH,
  SITE_MIN_WIDTH,
  newlyWaitingConversation,
  useSiteChatOpen,
  useSiteChatPanelLayout,
  type SiteChatPanelLayout,
} from "../lib/site-chat-panel";
import { useRecordSiteOpened } from "../lib/site-opened";
import { AppConnectCard } from "../lib/app-connect-card";
import { AppSyncJoinCard, AppSyncOptInHost } from "../lib/app-sync-opt-in";
import { siteMayHaveChanged, useSiteLiveVersion } from "../lib/site-live-version";
import { useSessionListHintRefresh } from "../lib/use-session-list-hint-refresh";
import { cn } from "../lib/utils";
import { useWindowBarCarriesBack, useWindowBarTitle } from "../../ui/window-bar-title";
import { WindowBarEndControls } from "../components/window-bar";

// Loaded when someone opens it, from the Artifacts route that already holds
// the publish form and the Site's management (a separate lazy entry would
// regroup the shared code-split chunks).
const SitePublishingPage = lazy(() =>
  import("./artifacts").then((module) => ({
    default: module.SitePublishingPage,
  })),
);
// The regular chat route, loaded as the chat page loads it: a static import
// would make the Site view share the chat's chunks and regroup them.
const loadSessionRoute = () => import("./session");
const SessionRoute = lazy(() =>
  loadSessionRoute().then((module) => ({ default: module.SessionRoute })),
);

const SITE_ROUTE = "/workspaces/$workspaceId/sites/$siteId";
/** The panel's width while it sits beside the Site, set live while dragging. */
const WIDTH_VARIABLE = "--og-site-chat-width";

type SiteState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      title: string;
      versionId: string | null;
      revision: number | null;
      archived: boolean;
    };

/** A conversation this panel just created, for its first open. */
type SiteHandoff = CreatedConversation & {
  creation: SessionCreationHandoff | null;
};

/**
 * A Site with its chat beside it. The Site fills the page; the panel shows
 * one conversation (the newest when the Site opens, unless one is chosen) as
 * the regular chat (the same chat as on its own page, without the session
 * panel), narrower, and starts a new one with the regular composer. The
 * sidebar lists the Site's conversations, so the panel doesn't repeat them.
 * The panel can be resized, hidden and moved to the left; all three are
 * remembered per person, and choosing a conversation brings a hidden panel
 * back. Files dragged over the Site go to the chat, since the Site's frame
 * would otherwise take them.
 *
 * Edits go live: the Site is watched for new versions (its conversation's
 * tool calls, and a check every few seconds for anyone else's), the preview
 * reloads in place when one is published or restored, and the version chip
 * in its header offers the history and one-click Undo.
 *
 * Its header is one slim row on the page itself, without a frame: the way
 * back, the title and version, whether the Site is on the web ("Published"
 * opens or copies the address, or Publish for people who can), its "…" and
 * full screen. In the macOS app the title is the window bar's, and the
 * controls join it there, so the Site starts right under the bar. Publishing
 * and its settings open the Site's own publish form in place of the Site,
 * with the chat still beside it; it is in the address (`?publishing`), so
 * going back closes it.
 */
export function SiteViewRoute({
  workspaceId,
  siteId,
  conversation,
  startNew = false,
  page,
  artifactsReturn,
  connect,
  publishing: publishingRequested = false,
  embedded = false,
}: {
  workspaceId: string;
  siteId: string;
  /**
   * The Site alone, without its toolbar or chat: for a host that draws its
   * own header around it (the phone app's viewer). Its own moves stay inside.
   */
  embedded?: boolean | undefined;
  /** The conversation open in the panel; the newest when omitted. */
  conversation?: string | undefined;
  /** Open with a new conversation in the panel, its composer focused (Edit with Opengeni). */
  startNew?: boolean | undefined;
  /** The Site's own address (`?page=/admin`), answered to its `site.location`; its root when omitted. */
  page?: string | undefined;
  /**
   * The Artifacts page the Site was opened from: the Site's toolbar starts
   * with a Back to it, and the Site's own moves keep it.
   */
  artifactsReturn?: SiteViewArtifactsReturn | undefined;
  /** Open this connect card item's dialog once (`?connect=`, from a published App). */
  connect?: string | undefined;
  /** Show the publish form in place of the Site (`?publishing`). */
  publishing?: boolean | undefined;
}) {
  const { client, accessContext } = useAppContext();
  const navigate = useNavigate();
  const router = useRouter();
  const pageHost = usePage();
  const viewer = useConsoleSiteViewer();
  // By value: a host may pass a new object on every render.
  const backKey = artifactsReturn?.browse ? JSON.stringify(artifactsReturn) : "";
  const back = useMemo<SiteViewArtifactsReturn | undefined>(
    () => (backKey ? (JSON.parse(backKey) as SiteViewArtifactsReturn) : undefined),
    [backKey],
  );
  // The Site's address lives in this page's URL, so Back/Forward, reloads
  // and copied links keep the Site where it was.
  const onSiteLocationChange = useCallback(
    (href: string, options: { replace: boolean }) =>
      void navigate({
        to: SITE_ROUTE,
        params: { workspaceId, siteId },
        search: {
          ...back,
          ...(conversation ? { conversation } : {}),
          ...(href === "/" ? {} : { page: href }),
          ...(publishingRequested ? { publishing: true } : {}),
        },
        ...(options.replace ? { replace: true } : {}),
      }),
    [back, conversation, navigate, publishingRequested, siteId, workspaceId],
  );
  // Anyone who can open the Site sees whether it is published and its
  // address; Publish and the publish form are for people who can publish.
  const canPublish = hasWorkspacePermission(accessContext, workspaceId, "artifacts:publish");
  const publication = useSitePublicationLink({ client, workspaceId, siteId });
  const consoleToolBridge = useConsoleSiteToolBridge(workspaceId);
  useRecordSiteOpened(client, workspaceId, siteId);
  const live = useSiteLiveVersion(client, workspaceId, siteId);
  // The Site's frame hears its data change hints from this view's live connection.
  const subscribeDataChanges = live.subscribeDataChanges;
  const toolBridge = useCallback<typeof consoleToolBridge>(
    (site) => {
      const bridge = consoleToolBridge(site);
      return bridge && site?.artifactId === siteId ? { ...bridge, subscribeDataChanges } : bridge;
    },
    [consoleToolBridge, siteId, subscribeDataChanges],
  );
  const artifact = live.detail?.artifact;
  // The connect card's `?connect=` is used once, then dropped from the address.
  const connectHandled = useCallback(
    () =>
      void navigate({
        to: SITE_ROUTE,
        params: { workspaceId, siteId },
        search: {
          ...back,
          ...(conversation ? { conversation } : {}),
          ...(page ? { page } : {}),
          ...(publishingRequested ? { publishing: true } : {}),
        },
        replace: true,
      }),
    [back, conversation, navigate, page, publishingRequested, siteId, workspaceId],
  );
  const connectCard =
    artifact?.status === "active" ? (
      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex flex-col items-end gap-2">
        <AppSyncJoinCard workspaceId={workspaceId} siteId={siteId} />
        <AppConnectCard
          workspaceId={workspaceId}
          siteId={siteId}
          versionId={artifact.currentVersion?.id ?? null}
          connectKey={connect}
          onConnectKeyHandled={connectHandled}
        />
        <AppSyncOptInHost workspaceId={workspaceId} siteId={siteId} />
      </div>
    ) : null;
  // The publish form, open for this Site while the address says so.
  const siteKey = `${workspaceId}/${siteId}`;
  // Only for people who may publish: for others a shared `?publishing` link
  // just opens the app.
  const publishingSite =
    publishingRequested && canPublish && artifact?.status === "active" ? artifact : null;
  const publishing = publishingSite !== null;
  // In the macOS app the Site's name is the window bar's title, as a page's
  // is, instead of in its toolbar (which shows it again in full screen, where
  // the bar's row is hidden). The publish form, opened in front of the Site,
  // names the bar once it has loaded; the Site's claim mounted first, so it
  // yields while the form is open.
  // Opened from Artifacts: the bar's trail ("Artifacts › name") is the one way
  // back, so the toolbar drops its own back link while the bar shows it.
  const artifactsBack = useArtifactsBackLink(workspaceId, back?.fromSession, back ?? undefined);
  const artifactsBackHref = artifactsBack.href;
  const artifactsBackClick = useRef(artifactsBack.onClick);
  artifactsBackClick.current = artifactsBack.onClick;
  const backPlace = useMemo(() => {
    if (!back) return null;
    const crumb = {
      label: "Artifacts",
      href: artifactsBackHref,
      onClick: () => artifactsBackClick.current?.(),
    };
    return { section: crumb, parent: crumb };
  }, [back, artifactsBackHref]);
  const titleInWindowBar = useWindowBarTitle(artifact?.title ?? null, publishing, {
    copyable: true,
    place: backPlace,
  });
  const barCarriesBack = useWindowBarCarriesBack(titleInWindowBar);
  // Full screen is the route's so opening the form can leave it first.
  const [fullScreen, setFullScreen] = useState(false);
  const publishingSearch = useCallback(
    (open: boolean) => ({
      ...back,
      ...(conversation ? { conversation } : {}),
      ...(page ? { page } : {}),
      ...(open ? { publishing: true } : {}),
    }),
    [back, conversation, page],
  );
  const openPublishing = useCallback(() => {
    setFullScreen(false);
    void navigate({
      to: SITE_ROUTE,
      params: { workspaceId, siteId },
      search: publishingSearch(true),
      state: { sitePublishingFromSite: siteKey },
    });
  }, [navigate, publishingSearch, siteId, siteKey, workspaceId]);
  // Back from the form returns focus to the control that opened it.
  const siteColumn = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  // Opened from this Site in this tab: going back is the browser's Back, so
  // the history doesn't keep the form. Opened by link: back replaces it.
  const closePublishing = useCallback(() => {
    returnFocus.current = true;
    const openedHere =
      router.state.location.state?.sitePublishingFromSite === siteKey && !pageHost.opensBeside;
    if (openedHere) window.history.back();
    else
      void navigate({
        to: SITE_ROUTE,
        params: { workspaceId, siteId },
        search: publishingSearch(false),
        replace: true,
      });
  }, [navigate, pageHost, publishingSearch, router, siteId, siteKey, workspaceId]);
  // However the form closes (its back link or the browser's Back), focus
  // returns to the control that opens it.
  const wasPublishing = useRef(publishing);
  useEffect(() => {
    const closed = wasPublishing.current && !publishing;
    wasPublishing.current = publishing;
    if (!closed && !returnFocus.current) return;
    if (publishing) return;
    returnFocus.current = false;
    document.querySelector<HTMLElement>("[data-site-header] [data-site-publication]")?.focus();
  }, [publishing]);
  // Leaving full screen returns focus to the "…" it was opened from.
  const wasFullScreen = useRef(fullScreen);
  useEffect(() => {
    const left = wasFullScreen.current && !fullScreen;
    wasFullScreen.current = fullScreen;
    if (left) document.querySelector<HTMLElement>("[data-site-actions-menu]")?.focus();
  }, [fullScreen]);
  const site = useMemo<SiteState>(
    () =>
      artifact
        ? {
            status: "ready",
            title: artifact.title,
            versionId: artifact.currentVersion?.id ?? null,
            revision: artifact.currentVersion?.revision ?? null,
            archived: artifact.status === "archived",
          }
        : live.failed
          ? { status: "error" }
          : { status: "loading" },
    [artifact, live.failed],
  );
  const { check } = live;
  // Embedded (the phone app's viewer) there is no page URL to keep the Site's
  // address in, so it lives here, starting at `page`.
  const [embeddedLocation, setEmbeddedLocation] = useState(page ?? "/");
  const onEmbeddedLocationChange = useCallback((href: string) => setEmbeddedLocation(href), []);
  const backControl =
    back && !(barCarriesBack && !fullScreen) ? (
      <ArtifactsBackLink workspaceId={workspaceId} artifactsReturn={back} />
    ) : undefined;
  const { layout, update: updateLayout } = useSiteChatPanelLayout(accessContext.subjectId);
  // Open or closed per person and app. Until the person chooses, every app
  // offers its chat beside it where there is room for both (a wide window);
  // a narrower one, where the chat stacks under the app, opens it only for
  // an app they have chatted with (`useSiteChatOpen`).
  const chat = useSiteChatOpen(accessContext.subjectId, siteId);
  const wide = useWideWindow();
  const chatOpen = chat.chosen ? chat.open : chat.open || wide;
  const setChatOpen = chat.setOpen;
  // Hiding and showing move focus to the control that undoes it.
  const [chatFocus, setChatFocus] = useState<"show" | "hide" | null>(null);
  useEffect(() => {
    if (!chatFocus) return;
    document
      .querySelector<HTMLElement>(
        chatFocus === "show" ? "[data-site-chat-show]" : "[data-site-chat-hide]",
      )
      ?.focus();
    setChatFocus(null);
  }, [chatFocus]);
  const hideChat = useCallback(() => {
    setChatOpen(false);
    setChatFocus("show");
  }, [setChatOpen]);
  const showChat = useCallback(() => {
    setChatOpen(true);
    setChatFocus("hide");
  }, [setChatOpen]);
  const [relay] = useState(() => new ChatFileDropRelay());
  const [liveState, setLiveState] = useState<SiteLiveState | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((value) => value + 1), []);
  if (embedded) {
    return (
      <div
        className="relative flex h-full min-h-0 min-w-0 flex-col"
        data-workspace-scroll-owner="self-managed"
      >
        {connectCard}
        <SiteView
          client={client}
          workspaceId={workspaceId}
          siteId={siteId}
          toolBridge={toolBridge}
          viewer={viewer}
          siteLocation={embeddedLocation}
          onSiteLocationChange={onEmbeddedLocationChange}
          showToolbar={false}
          versionId={artifact ? (artifact.currentVersion?.id ?? null) : undefined}
          watch={live.watch}
          archivedMessage="This app is archived."
        />
      </div>
    );
  }
  const archived = artifact?.status === "archived";
  const titleNode = artifact ? (
    <SiteTitleMenu workspaceId={workspaceId} origin={{ siteId, title: artifact.title }}>
      {/* Focusable, so the menu key or Shift+F10 opens its menu. */}
      <span
        tabIndex={0}
        className="min-w-0 truncate rounded-sm text-sm font-medium text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        title={artifact.title}
      >
        {artifact.title}
      </span>
    </SiteTitleMenu>
  ) : null;
  const versionMenu =
    live.detail && !archived ? (
      <SiteVersionMenu
        workspaceId={workspaceId}
        siteId={siteId}
        detail={live.detail}
        canPublish={canPublish}
        onRestored={check}
      />
    ) : null;
  // The one publication control and the Site's "…" (with full screen in it).
  // The Site view never says "Live": it stays current, and says so only
  // while Updating or Reconnecting.
  const siteControls =
    artifact && !archived ? (
      <>
        <span data-site-publication-slot="" className="contents">
          <SitePublicationControl
            load={publication.load}
            canPublish={canPublish}
            onOpenPublishing={openPublishing}
          />
        </span>
        <SiteActionsMenu
          workspaceId={workspaceId}
          origin={{ siteId, title: artifact.title }}
          hasVersion={Boolean(artifact.currentVersion)}
          onReload={reload}
          onFullScreen={fullScreen ? undefined : () => setFullScreen(true)}
        />
      </>
    ) : null;
  // While the chat is closed the app has the whole width; this brings it back.
  const showChatButton = artifact && !chatOpen ? <ShowChatButton onClick={showChat} /> : null;
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 max-lg:flex-col",
        // The chat on the left: the Site keeps its place in the page, so
        // moving the chat neither reloads the Site nor restarts the chat.
        layout.position === "left" && "lg:flex-row-reverse",
      )}
      data-workspace-scroll-owner="self-managed"
      data-site-chat-position={layout.position}
    >
      {/* The Site's column, not its chat: the Site's header is this page's
          top row (in the macOS app, the window bar). */}
      <div
        ref={siteColumn}
        data-site-column
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {publishing || fullScreen ? null : (
          <SiteHeader inWindowBar={titleInWindowBar} column={siteColumn} side={layout.position}>
            {/* In the macOS app these sit on the bar's right; the back link
                stays (it keeps the list's filters, or the chat it came from)
                until the bar's own crumb carries them. */}
            {titleInWindowBar ? (
              backControl
            ) : (
              <>
                {layout.position === "left" ? showChatButton : null}
                {backControl}
                {titleNode}
              </>
            )}
            {versionMenu}
            <span className="min-w-2 flex-1" />
            <SiteLiveStateLabel state={liveState} />
            {canPublish && artifact && !archived ? (
              <AppServerStatusLine
                workspaceId={workspaceId}
                siteId={siteId}
                versionId={artifact.currentVersion?.id ?? null}
                onOpenChat={showChat}
              />
            ) : null}
            {siteControls}
            {layout.position === "left" && !titleInWindowBar ? null : showChatButton}
          </SiteHeader>
        )}
        {publishingSite ? (
          <Suspense fallback={<div className="min-h-0 flex-1 bg-bg" />}>
            <SitePublishingPage
              key={siteKey}
              workspaceId={workspaceId}
              siteId={siteId}
              artifact={publishingSite}
              onPublication={publication.update}
              onBack={closePublishing}
            />
          </Suspense>
        ) : null}
        {archived ? (
          <p className="p-4 text-sm text-fg-muted">
            This app is archived.{" "}
            <Link
              to="/workspaces/$workspaceId/artifacts/$artifactId"
              params={{ workspaceId, artifactId: siteId }}
              search={{ tab: "settings" }}
              state={{ artifactDetailFromSite: siteId }}
              className="font-medium text-fg underline underline-offset-2"
            >
              {canPublish ? "Restore it from its settings" : "View its settings"}
            </Link>
          </p>
        ) : (
          // Hidden, not unmounted, behind the form: the Site keeps its page.
          <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", publishing && "hidden")}>
            <SiteView
              client={client}
              workspaceId={workspaceId}
              siteId={siteId}
              toolBridge={toolBridge}
              viewer={viewer}
              siteLocation={page ?? "/"}
              onSiteLocationChange={onSiteLocationChange}
              // The header above draws the controls; the frame's own toolbar
              // shows only in full screen.
              showToolbar={false}
              onLiveStateChange={setLiveState}
              reloadToken={reloadToken}
              renderTitle={
                artifact
                  ? (title) => (
                      <SiteTitleMenu
                        workspaceId={workspaceId}
                        origin={{ siteId, title: artifact.title }}
                      >
                        {title}
                      </SiteTitleMenu>
                    )
                  : undefined
              }
              // In full screen the frame's toolbar carries the same controls
              // (mounted only there, so there is one of each).
              liveStatus={fullScreen ? siteControls : null}
              versionId={artifact ? (artifact.currentVersion?.id ?? null) : undefined}
              watch={live.watch}
              versionControl={fullScreen ? versionMenu : null}
              fullScreen={fullScreen}
              onFullScreenChange={setFullScreen}
              archivedMessage={
                canPublish
                  ? "This app is archived. Restore it from its settings."
                  : "This app is archived."
              }
            />
          </div>
        )}
        {publishing ? null : connectCard}
        <ChatFileDropCover relay={relay} enabled={chatOpen} />
      </div>
      <ChatFileDropRelayProvider relay={relay}>
        <SiteChatPanel
          key={`${workspaceId}:${siteId}`}
          workspaceId={workspaceId}
          siteId={siteId}
          site={site}
          retrySite={live.retry}
          canPublish={canPublish}
          conversation={conversation}
          startNew={startNew}
          page={page}
          publishing={publishingRequested}
          artifactsReturn={back}
          layout={layout}
          updateLayout={updateLayout}
          open={chatOpen}
          onOpen={setChatOpen}
          onHide={hideChat}
          onHasConversations={chat.setFallback}
          agentModel={
            publication.load.state === "ready" ? (publication.load.link.agentModel ?? null) : null
          }
          onEvent={(event) => {
            // A publish or restore from this conversation shows at once.
            if (siteMayHaveChanged(event)) check();
          }}
        />
      </ChatFileDropRelayProvider>
    </div>
  );
}

/** Right-click the Site's title: copy it or the Site's address. */
function SiteTitleMenu({
  workspaceId,
  origin,
  children,
}: {
  workspaceId: string;
  origin: { siteId: string; title: string };
  children: ReactNode;
}) {
  const site = useSiteActions(workspaceId, origin);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-40" data-site-title-menu="">
        <ContextMenuItem onSelect={site.copyTitle}>
          <CopyIcon className="size-4" />
          Copy title
        </ContextMenuItem>
        <ContextMenuItem onSelect={site.copyLink}>
          <LinkIcon className="size-4" />
          Copy app link
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The Site's header row. On the page it is a slim row with no frame of its
 * own, so the Site reads as part of the page. In the macOS app, where the
 * window bar already names the Site, its controls join the bar instead (on
 * the right of the Site's column, so they stay above the Site wherever the
 * chat sits) and the Site starts right under it.
 */
function SiteHeader({
  inWindowBar,
  column,
  side,
  children,
}: {
  inWindowBar: boolean;
  column: RefObject<HTMLElement | null>;
  /** The chat's side: moving it moves the column without resizing it. */
  side: SiteChatPanelLayout["position"];
  children: ReactNode;
}) {
  const [right, setRight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = column.current;
    if (!inWindowBar || !element) return;
    const update = () =>
      setRight(Math.max(0, window.innerWidth - element.getBoundingClientRect().right));
    update();
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [column, inWindowBar, side]);
  if (inWindowBar) {
    return (
      <WindowBarEndControls right={right === null ? null : right + 8}>
        <div data-site-header="" className="contents">
          {children}
        </div>
      </WindowBarEndControls>
    );
  }
  return (
    <div
      data-site-header=""
      className="flex h-11 shrink-0 items-center gap-1.5 bg-canvas pr-2 pl-3 sm:pl-4"
    >
      {children}
    </div>
  );
}

/** Only while the Site isn't current: Updating or Reconnecting, announced politely. */
function SiteLiveStateLabel({ state }: { state: SiteLiveState | undefined }) {
  const labels = useArtifactLabels();
  const busy = state === "updating" || state === "reconnecting";
  return (
    <span
      role="status"
      aria-live="polite"
      data-live-status={busy ? state : undefined}
      className={
        busy
          ? "mr-1 inline-flex items-center gap-1.5 text-2xs font-medium text-fg-muted"
          : "sr-only"
      }
    >
      {busy ? (
        <>
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              state === "updating"
                ? "bg-status-running ring-4 ring-status-running/15 motion-safe:animate-pulse"
                : "bg-status-waiting ring-4 ring-status-waiting/15",
            )}
          />
          <span className="max-sm:sr-only">
            {state === "updating" ? labels.liveUpdating : labels.liveReconnecting}
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * Whether the window is wide enough for the chat to sit beside the app (the
 * layout's `lg` breakpoint); without media queries (tests, old hosts) it is.
 */
function useWideWindow(): boolean {
  const query = "(min-width: 1024px)";
  const [wide, setWide] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? true
      : window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setWide(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, []);
  return wide;
}

/**
 * Brings back a closed chat: a labelled button in the app's header (or the
 * macOS window bar), so the chat is always one visible click away.
 */
function ShowChatButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label="Show chat"
      title="Show chat"
      aria-expanded={false}
      data-site-chat-show=""
      className="h-7 gap-1.5 rounded-full px-2.5 text-xs pointer-coarse:h-11"
      onClick={onClick}
    >
      <MessageSquareIcon aria-hidden="true" className="size-3.5" />
      Chat
    </Button>
  );
}

/**
 * The Site's "…", as a chat's header has one, with the few actions people use
 * often: full screen, reload, the sidebar's Pin and Archive (while the
 * sidebar lists Sites) and Settings. Rarer ones (duplicate, export, allowed
 * actions) are in Settings; copying the address is in "Published".
 */
function SiteActionsMenu({
  workspaceId,
  origin,
  hasVersion,
  onReload,
  onFullScreen,
}: {
  workspaceId: string;
  origin: { siteId: string; title: string };
  hasVersion: boolean;
  onReload: () => void;
  /** Absent while the app is already full screen. */
  onFullScreen?: (() => void) | undefined;
}) {
  const site = useSiteActions(workspaceId, origin, { hasVersion });
  const sidebar = useSiteSidebarActions(workspaceId, origin);
  const labels = useArtifactLabels();
  return (
    <span data-site-actions-root="" className="contents">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="More app actions"
            title="More"
            data-site-actions-menu=""
            className="size-8 rounded-md text-fg-muted hover:text-fg pointer-coarse:size-11"
          >
            <MoreHorizontalIcon aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {onFullScreen ? (
            <DropdownMenuItem onSelect={onFullScreen}>
              <Maximize2Icon aria-hidden="true" />
              {labels.openFullScreen}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onReload}>
            <RefreshCwIcon aria-hidden="true" />
            {labels.reloadSite}
          </DropdownMenuItem>
          {sidebar ? (
            <DropdownMenuItem onSelect={sidebar.togglePin}>
              <PinIcon aria-hidden="true" className={sidebar.pinned ? "fill-current" : undefined} />
              {sidebar.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem asChild>
            <Link {...site.details} state={{ artifactDetailFromSite: origin.siteId }}>
              <Settings2Icon aria-hidden="true" />
              Settings
            </Link>
          </DropdownMenuItem>
          {sidebar ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={sidebar.archive}>
                <ArchiveIcon aria-hidden="true" />
                Archive
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

const PAGE_SIZE = 30;

/**
 * "← Artifacts" at the start of the Site's toolbar, when the Site was opened
 * from the Artifacts page: back to that page with its tab, search and sort
 * (and its scroll, which the page keeps). A real link, so it also opens in a
 * new tab.
 */
function ArtifactsBackLink({
  workspaceId,
  artifactsReturn,
}: {
  workspaceId: string;
  artifactsReturn: SiteViewArtifactsReturn;
}) {
  const back = useArtifactsBackLink(workspaceId, artifactsReturn.fromSession, artifactsReturn);
  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className="-ml-1.5 h-8 shrink-0 gap-1.5 px-2 text-fg-muted hover:text-fg pointer-coarse:min-h-11"
    >
      <a
        href={back.href}
        onClick={back.onClick}
        aria-label="Back to Artifacts"
        title="Back to Artifacts"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        {back.label}
      </a>
    </Button>
  );
}

/**
 * The Site's newest conversations for this viewer, newest activity first.
 * The panel needs the newest to open by default and the titles to name the
 * one open; the sidebar is where all of them are listed.
 */
function useSiteConversations(workspaceId: string, siteId: string) {
  const { client } = useAppContext();
  const [page, setPage] = useState<SessionListResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    try {
      const next = await client.listSessionPage(workspaceId, {
        originSiteId: siteId,
        parentSessionId: null,
        sortBy: "updatedAt",
        limit: PAGE_SIZE,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      setPage(next);
      setError(null);
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure : new Error(String(failure)));
    }
  }, [client, siteId, workspaceId]);
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);
  // Only Site conversations matter here, which ordinary hints never name.
  useSessionListHintRefresh(refresh, error, { siteConversations: true });
  const sessions = useMemo(
    () =>
      page
        ? [...new Map([...page.pinned, ...page.sessions].map((session) => [session.id, session]))]
            .map(([, session]) => session)
            .filter((session) => !session.archived)
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        : [],
    [page],
  );
  return { sessions, loaded: page !== null, error, refresh };
}

/**
 * How wide the panel may be: its own limit, less what the Site needs beside
 * it. Measured through the panel's own element, since a parent's ref isn't
 * attached yet when a child's layout effect first runs.
 */
function useAvailableWidth(panel: RefObject<HTMLElement | null>) {
  const [max, setMax] = useState(SITE_CHAT_MAX_WIDTH);
  useLayoutEffect(() => {
    const element = panel.current?.parentElement;
    if (!element) return;
    const measure = () => {
      const { width } = element.getBoundingClientRect();
      // An unmeasured frame (no layout yet) keeps the panel's own limit; a
      // narrow one still lets the panel be its minimum.
      setMax(
        width === 0
          ? SITE_CHAT_MAX_WIDTH
          : Math.max(
              SITE_CHAT_MIN_WIDTH,
              Math.min(SITE_CHAT_MAX_WIDTH, Math.floor(width - SITE_MIN_WIDTH)),
            ),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [panel]);
  return max;
}

function SiteChatPanel({
  workspaceId,
  siteId,
  site,
  retrySite,
  canPublish,
  conversation,
  startNew: startNewRequested,
  page,
  publishing,
  artifactsReturn,
  layout,
  updateLayout,
  open,
  onOpen,
  onHide,
  onHasConversations,
  agentModel,
  onEvent,
}: {
  workspaceId: string;
  siteId: string;
  site: SiteState;
  retrySite: () => void;
  /** Whether this person may publish the Site, and so edit it from here. */
  canPublish: boolean;
  conversation?: string | undefined;
  startNew: boolean;
  /** The Site's own address, kept when another conversation is chosen. */
  page?: string | undefined;
  /** Whether the publish form is open, kept when another conversation is chosen. */
  publishing: boolean;
  /** The Artifacts page the Site was opened from, kept when another conversation is chosen. */
  artifactsReturn?: SiteViewArtifactsReturn | undefined;
  /** Width and side, remembered per person; shared with the Site beside it. */
  layout: SiteChatPanelLayout;
  updateLayout: (patch: Partial<SiteChatPanelLayout>) => void;
  /** Whether the chat shows; closed, it stays mounted and the Site has the width. */
  open: boolean;
  onOpen: (open: boolean) => void;
  onHide: () => void;
  /** Whether this person has chatted with the Site, which opens it by default. */
  onHasConversations: (has: boolean) => void;
  /** The model the app's chat is set to start with, preselected when allowed. */
  agentModel: string | null;
  /** Each new event in the open conversation, so the Site can follow its edits. */
  onEvent: (event: SessionEvent) => void;
}) {
  const context = useAppContext();
  const api = useAppApi();
  const chatOps = useChatOperations();
  const navigate = useNavigate();
  const panelId = useId();
  const panel = useRef<HTMLElement>(null);
  const list = useSiteConversations(workspaceId, siteId);
  // Opened from one of its chats, or one it has: open unless the person
  // closed it. Known at once for a chat in the address, so it doesn't open late.
  const chatted = Boolean(conversation) || (list.loaded && list.sessions.length > 0);
  useEffect(() => {
    if (list.loaded || chatted) onHasConversations(chatted);
  }, [chatted, list.loaded, onHasConversations]);
  const left = layout.position === "left";
  const maxWidth = useAvailableWidth(panel);
  const width = Math.min(layout.width, maxWidth);
  const [composing, setComposing] = useState(false);
  const [handoff, setHandoff] = useState<SiteHandoff | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  // A conversation opened by link that isn't among the newest is named once read.
  const [linked, setLinked] = useState<Session | null>(null);

  // The conversation open without a choice is fixed when the Site opens, so
  // activity elsewhere never swaps it out from under the person reading it.
  const [defaultId, setDefaultId] = useState<string | null | undefined>(undefined);
  const newest = list.sessions[0]?.id ?? null;
  const pinned =
    defaultId === null ||
    (defaultId !== undefined && list.sessions.some((session) => session.id === defaultId))
      ? defaultId
      : newest;
  useEffect(() => {
    if (list.loaded && pinned !== defaultId) setDefaultId(pinned);
  }, [defaultId, list.loaded, pinned]);

  // Choosing a conversation anywhere (the rail, a link, arriving from a chat)
  // ends composing and shows a hidden panel: the sidebar is where
  // conversations are chosen, so choosing one must show it. Returning to the
  // Site itself, as its rail row does, opens its newest.
  // Arriving with one (a link, Back, a reload) is the default above, not a
  // choice, so a chat the person closed stays closed.
  const previousConversation = useRef(conversation);
  const startingNew = useRef(false);
  useEffect(() => {
    const previous = previousConversation.current;
    previousConversation.current = conversation;
    if (conversation) {
      setComposing(false);
      if (conversation !== previous) onOpen(true);
    } else if (previous && !startingNew.current) setDefaultId(undefined);
    startingNew.current = false;
  }, [conversation, onOpen]);

  const toSite = useCallback(
    (search: { conversation?: string }, replace = false) =>
      void navigate({
        to: SITE_ROUTE,
        params: { workspaceId, siteId },
        // Choosing a conversation keeps the Site where it is.
        search: {
          ...artifactsReturn,
          ...search,
          ...(page ? { page } : {}),
          ...(publishing ? { publishing: true as const } : {}),
        },
        ...(replace ? { replace: true } : {}),
      }),
    [artifactsReturn, navigate, page, publishing, siteId, workspaceId],
  );

  // A link may name a conversation that isn't this Site's, or one since
  // archived or deleted; fall back to the Site's own.
  const listed = !conversation || list.sessions.some((session) => session.id === conversation);
  // Through a ref: a host's navigate may change identity on every render.
  const fallBack = useRef(() => {});
  useEffect(() => {
    fallBack.current = () => toSite({}, true);
  }, [toSite]);
  useEffect(() => {
    if (!conversation || !list.loaded || listed) return;
    const abort = new AbortController();
    context.client.getSession(workspaceId, conversation, { signal: abort.signal }).then(
      (session) => {
        if (abort.signal.aborted) return;
        if (
          sessionSiteOrigin(session)?.siteId !== siteId ||
          session.parentSessionId !== null ||
          session.archived
        )
          fallBack.current();
        else setLinked(session);
      },
      (failure: unknown) => {
        if (
          !abort.signal.aborted &&
          failure instanceof OpenGeniApiError &&
          [403, 404].includes(failure.status)
        )
          fallBack.current();
      },
    );
    return () => abort.abort();
  }, [context.client, conversation, list.loaded, listed, siteId, workspaceId]);

  // Load the chat route with the panel, so a chat created here opens (and
  // takes focus below) without waiting for it. A failed load shows when the
  // route renders.
  useEffect(() => {
    void loadSessionRoute().catch(() => {});
  }, []);

  // Move focus to the composer New opened, or to the new conversation's.
  useEffect(() => {
    if (focusRequest === 0) return;
    let animation = 0;
    let tries = 0;
    const attempt = () => {
      const input = panel.current?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])");
      if (input) input.focus();
      else if ((tries += 1) < 60) animation = requestAnimationFrame(attempt);
    };
    animation = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(animation);
  }, [focusRequest]);

  const ready = site.status === "ready" ? site : null;
  const canCreate =
    hasWorkspacePermission(context.accessContext, workspaceId, "sessions:create") &&
    ready !== null &&
    ready.versionId !== null &&
    !ready.archived;
  // The composer mounts once the Site has loaded; focus it then too.
  useEffect(() => {
    if (composing && canCreate) setFocusRequest((request) => request + 1);
  }, [canCreate, composing]);
  const selectedId = composing ? null : (conversation ?? pinned);
  const showComposer = composing || (list.loaded && selectedId === null);
  // A Site conversation that starts waiting for the person (an approval its
  // own ai.run hit) opens here, so they can answer it without hunting for
  // it. Waits already there when the Site opened, or while they write a new
  // message, don't move the panel.
  const waitsSeen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!list.loaded) return;
    const { next, seen } = newlyWaitingConversation(
      list.sessions,
      waitsSeen.current ?? new Set(),
      selectedId,
    );
    const opening = waitsSeen.current === null;
    waitsSeen.current = seen;
    if (!opening && next && !composing) toSite({ conversation: next });
  }, [composing, list.loaded, list.sessions, selectedId, toSite]);
  const startNew = () => {
    setComposing(true);
    setFocusRequest((request) => request + 1);
    // Nothing is selected while composing, so the rail marks the Site.
    if (conversation) {
      startingNew.current = true;
      toSite({});
    }
  };
  // Edit with Opengeni opens the Site this way: a new conversation, shown
  // even if the panel was hidden, its composer focused once it can be used.
  // The address drops the request so going back or reloading doesn't repeat it.
  // Once per request, also when the Site is already open: the host's
  // navigate (and so `toSite`) may change identity on every render.
  const startNewHandled = useRef(false);
  useEffect(() => {
    if (!startNewRequested) {
      startNewHandled.current = false;
      return;
    }
    if (startNewHandled.current) return;
    startNewHandled.current = true;
    setComposing(true);
    onOpen(true);
    if (conversation) startingNew.current = true;
    toSite({}, true);
  }, [conversation, onOpen, startNewRequested, toSite]);
  // Created like the Site's own chats: private to this person and listed
  // under the Site. The API refuses anything else a Site may not set; files
  // are the person's own, attached here in the console as in any chat.
  const versionId = ready?.versionId ?? null;
  // A retry of the same create keeps its first message's identity, so the
  // chat shows that message at once and recognizes it when it arrives.
  const clientEventIds = useRef(new Map<string, string>());
  const createdSessions = useRef(new Map<string, SessionCreationHandoff>());
  const createSession = useCallback(
    async (
      initialMessage: string,
      idempotencyKey: string,
      options: NewConversationCreateOptions,
    ): Promise<string> => {
      if (!versionId) throw new Error("This app has no published version yet.");
      const voice = options.startMode === "realtime";
      let clientEventId = clientEventIds.current.get(idempotencyKey);
      if (!voice && !clientEventId) {
        clientEventId = crypto.randomUUID();
        clientEventIds.current.set(idempotencyKey, clientEventId);
      }
      const created = await api.request<Session>(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
        {
          method: "POST",
          headers: { [SITE_ID_HEADER]: siteId, [SITE_VERSION_HEADER]: versionId },
          body: JSON.stringify({
            ...(voice ? { startMode: "realtime" } : { initialMessage, clientEventId }),
            idempotencyKey,
            ...(options.resources?.length ? { resources: options.resources } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
            ...(options.latencyMode ? { latencyMode: options.latencyMode } : {}),
          }),
        },
      );
      if (clientEventId)
        createdSessions.current.set(created.id, { session: created, clientEventId });
      return created.id;
    },
    [api, siteId, versionId, workspaceId],
  );
  const handedOff = handoff !== null && handoff.sessionId === selectedId ? handoff : null;
  // For someone who may publish the Site, every message says which Site and
  // version "the Site" is; the API names it on the first one when it creates
  // the conversation. Others get no editing context, as from the API.
  const siteContext = useRef<string | null>(null);
  siteContext.current =
    canPublish && ready?.versionId && ready.revision !== null
      ? siteConversationContext({
          siteId,
          title: ready.title,
          versionId: ready.versionId,
          revision: ready.revision,
        })
      : null;
  const messageContext = useCallback(() => siteContext.current ?? undefined, []);
  // The handoff is for the conversation's first open only.
  useEffect(() => {
    if (handoff && selectedId !== null && selectedId !== handoff.sessionId) setHandoff(null);
  }, [handoff, selectedId]);
  // Focus follows a new conversation once it, not the composer, is mounted.
  const handoffId = handoff?.sessionId ?? null;
  useEffect(() => {
    if (handoffId !== null && selectedId === handoffId) setFocusRequest((request) => request + 1);
  }, [handoffId, selectedId]);

  const selected =
    list.sessions.find((session) => session.id === selectedId) ??
    (linked?.id === selectedId ? linked : null);
  // While composing, the composer's own headline names what to do.
  const title = showComposer
    ? null
    : selected
      ? sessionDisplayTitle(selected)
      : handedOff?.initialMessage
        ? handedOff.initialMessage
        : "Conversation";

  return (
    <aside
      ref={panel}
      id={panelId}
      aria-label="Chat"
      hidden={!open}
      style={{ [WIDTH_VARIABLE]: `${width}px` } as CSSProperties}
      data-position={layout.position}
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col border-border bg-bg lg:w-(--og-site-chat-width) max-lg:h-[55%] max-lg:w-full max-lg:border-t",
        left ? "lg:border-r" : "lg:border-l",
        // Hidden, not unmounted: the conversation keeps its place and stream.
        !open && "hidden",
      )}
    >
      <ResizeHandle
        label="Resize chat"
        controls={panelId}
        value={width}
        min={SITE_CHAT_MIN_WIDTH}
        max={maxWidth}
        // The edge toward the Site: dragging toward it widens the chat.
        edge={left ? "end" : "start"}
        // Live while dragging without re-rendering the conversation.
        onResize={(next) => panel.current?.style.setProperty(WIDTH_VARIABLE, `${next}px`)}
        onResizeEnd={(next) => {
          panel.current?.style.setProperty(WIDTH_VARIABLE, `${next}px`);
          updateLayout({ width: next });
        }}
        onReset={() => updateLayout({ width: SITE_CHAT_DEFAULT_WIDTH })}
        onCollapse={onHide}
        className="max-lg:hidden"
      />
      <div className="flex h-11 shrink-0 items-center gap-0.5 pr-2 pl-4">
        <h2
          className="min-w-0 flex-1 truncate text-sm font-medium text-fg"
          title={title ?? undefined}
        >
          {title ?? <span className="sr-only">New conversation</span>}
        </h2>
        {canCreate ? (
          <Button
            type="button"
            variant={showComposer ? "secondary" : "ghost"}
            size="sm"
            className="mr-0.5 pointer-coarse:h-11"
            onClick={startNew}
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
            New
          </Button>
        ) : null}
        {selectedId ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Copy link to this chat"
            title="Copy link"
            data-site-chat-copy-link=""
            className="text-fg-muted hover:text-fg pointer-coarse:size-11"
            onClick={() => void chatOps.copyLink({ id: selectedId, workspaceId })}
          >
            <LinkIcon aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
        {selectedId ? (
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className="text-fg-muted hover:text-fg pointer-coarse:size-11"
          >
            <Link
              to="/workspaces/$workspaceId/sessions/$sessionId"
              params={{ workspaceId, sessionId: selectedId }}
              aria-label="Open as a full chat"
              title="Open as a full chat"
            >
              <SquareArrowOutUpRightIcon aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        ) : null}
        {/* Beside the Site only on wide screens; narrower ones stack the chat below. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={left ? "Move chat to right" : "Move chat to left"}
          title={left ? "Move chat to right" : "Move chat to left"}
          className="text-fg-muted hover:text-fg pointer-coarse:size-11 max-lg:hidden"
          onClick={() => updateLayout({ position: left ? "right" : "left" })}
        >
          <ArrowLeftRightIcon aria-hidden="true" className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Hide chat"
          title="Hide chat"
          aria-controls={panelId}
          aria-expanded={true}
          data-site-chat-hide=""
          className="text-fg-muted hover:text-fg pointer-coarse:size-11"
          onClick={onHide}
        >
          {left ? (
            <PanelLeftCloseIcon aria-hidden="true" className="size-4" />
          ) : (
            <PanelRightCloseIcon aria-hidden="true" className="size-4" />
          )}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {!list.loaded && !conversation ? (
          list.error ? (
            <Retry message="Couldn’t load conversations." onRetry={() => void list.refresh()} />
          ) : (
            <PanelLoading label="Loading conversations" />
          )
        ) : showComposer ? (
          canCreate ? (
            <ConsoleNewConversation
              key={`new:${siteId}`}
              workspaceId={workspaceId}
              createSession={createSession}
              defaultModel={agentModel}
              title={ready ? `Ask about ${ready.title}` : "New conversation"}
              onCreated={(created) => {
                setHandoff({
                  ...created,
                  creation: createdSessions.current.get(created.sessionId) ?? null,
                });
                void list.refresh();
                // Opening it ends composing, like any other choice.
                toSite({ conversation: created.sessionId });
              }}
              className="min-h-0 flex-1 px-3 pb-3"
            />
          ) : site.status === "loading" ? (
            <PanelLoading label="Loading app" />
          ) : site.status === "error" ? (
            <Retry message="Couldn’t load this app." onRetry={retrySite} />
          ) : (
            <p className="px-4 py-4 text-sm text-fg-muted">No conversations yet.</p>
          )
        ) : selectedId ? (
          // The regular chat, as on its own page, without the session panel
          // there's no room for beside a Site.
          <SessionUiFeaturesOff features={["dock"]}>
            <Suspense fallback={<PanelLoading label="Loading conversation" />}>
              <SessionRoute
                key={selectedId}
                workspaceId={workspaceId}
                sessionId={selectedId}
                placement="panel"
                onEvent={onEvent}
                messageContext={messageContext}
                // The first prompt and anything typed meanwhile carry over.
                creationHandoff={handedOff?.creation ?? null}
                initialDraft={handedOff?.draft}
                // A voice-first chat starts its call once it opens.
                realtimeAutostartModel={handedOff?.realtimeModel}
                onRealtimeAutostartConsumed={() =>
                  setHandoff((current) =>
                    current?.sessionId === selectedId
                      ? { ...current, realtimeModel: undefined }
                      : current,
                  )
                }
                onNewSession={canCreate ? startNew : undefined}
              />
            </Suspense>
          </SessionUiFeaturesOff>
        ) : null}
      </div>
    </aside>
  );
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4" aria-busy="true">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-16 w-full rounded-lg" />
      <span className="sr-only" role="status">
        {label}
      </span>
    </div>
  );
}

function Retry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="px-4 py-4 text-sm text-fg-muted">
      {message}{" "}
      <button type="button" className="og-link" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}
