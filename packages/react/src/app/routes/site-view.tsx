import {
  SITE_ID_HEADER,
  SITE_VERSION_HEADER,
  siteConversationContext,
} from "@opengeni/contracts/site-session-http";
import type { Session, SessionEvent, SessionListResponse } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import {
  ArrowLeftIcon,
  InfoIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
  PlusIcon,
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
  type RefObject,
} from "react";
import { SiteView } from "../../artifacts";
import { SiteVersionMenu } from "../components/artifacts/site-version-menu";
import { useArtifactsBackLink } from "../components/artifacts/artifact-page-chrome";
import type {
  CreatedConversation,
  NewConversationCreateOptions,
} from "../../hooks/use-new-conversation";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
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
import { useConsoleSiteToolBridge, useConsoleSiteViewer } from "../lib/console-site";
import { Link, useNavigate } from "../lib/navigation";
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
  useSiteChatPanelLayout,
  type SiteChatPanelLayout,
} from "../lib/site-chat-panel";
import { useRecordSiteOpened } from "../lib/site-opened";
import { siteMayHaveChanged, useSiteLiveVersion } from "../lib/site-live-version";
import { useSessionListHintRefresh } from "../lib/use-session-list-hint-refresh";
import { cn } from "../lib/utils";
import { useWindowBarTitle } from "../../ui/window-bar-title";

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
type SiteHandoff = CreatedConversation & { creation: SessionCreationHandoff | null };

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
 * Its header says whether the Site is on the web: "Published" opens or
 * copies the address, or Publish for people who can. Publishing and its
 * settings open the Site's own publish form in place of the Site, with the
 * chat still beside it.
 */
export function SiteViewRoute({
  workspaceId,
  siteId,
  conversation,
  startNew = false,
  page,
  artifactsReturn,
}: {
  workspaceId: string;
  siteId: string;
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
}) {
  const { client, accessContext } = useAppContext();
  const navigate = useNavigate();
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
        },
        ...(options.replace ? { replace: true } : {}),
      }),
    [back, conversation, navigate, siteId, workspaceId],
  );
  // Anyone who can open the Site sees whether it is published and its
  // address; Publish and the publish form are for people who can publish.
  const canPublish = hasWorkspacePermission(accessContext, workspaceId, "artifacts:publish");
  const publication = useSitePublicationLink({ client, workspaceId, siteId });
  const toolBridge = useConsoleSiteToolBridge(workspaceId);
  useRecordSiteOpened(client, workspaceId, siteId);
  const live = useSiteLiveVersion(client, workspaceId, siteId);
  const artifact = live.detail?.artifact;
  // In the macOS app the Site's name is the window bar's title, as a page's
  // is, instead of in its toolbar (which shows it again in full screen, where
  // the bar's row is hidden).
  const titleInWindowBar = useWindowBarTitle(artifact?.title ?? null);
  // The publish form, open for this Site; another Site starts without it.
  const siteKey = `${workspaceId}/${siteId}`;
  const [publishingFor, setPublishingFor] = useState<string | null>(null);
  const publishingSite =
    publishingFor === siteKey && artifact?.status === "active" ? artifact : null;
  const publishing = publishingSite !== null;
  // Full screen is the route's so opening the form can leave it first.
  const [fullScreen, setFullScreen] = useState(false);
  const openPublishing = useCallback(() => {
    setFullScreen(false);
    setPublishingFor(siteKey);
  }, [siteKey]);
  // Back from the form returns focus to the control that opened it.
  const siteColumn = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  const closePublishing = useCallback(() => {
    returnFocus.current = true;
    setPublishingFor(null);
  }, []);
  useEffect(() => {
    if (publishing || !returnFocus.current) return;
    returnFocus.current = false;
    siteColumn.current?.querySelector<HTMLElement>("[data-site-publication]")?.focus();
  }, [publishing]);
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
  const backControl = back ? (
    <ArtifactsBackLink workspaceId={workspaceId} artifactsReturn={back} />
  ) : undefined;
  const { layout, update: updateLayout } = useSiteChatPanelLayout(accessContext.subjectId);
  const [relay] = useState(() => new ChatFileDropRelay());
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
      {/* The Site's column, not its chat: the Site's toolbar is this page's
          top row. */}
      <div
        ref={siteColumn}
        data-site-column
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
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
        {artifact?.status === "archived" ? (
          <>
            {backControl ? (
              <div className="flex min-h-12 shrink-0 items-center border-b border-border/80 px-3 sm:px-4">
                {backControl}
              </div>
            ) : null}
            <p className="p-4 text-sm text-fg-muted">
              This Site is archived.{" "}
              <Link
                to="/workspaces/$workspaceId/artifacts/$artifactId"
                params={{ workspaceId, artifactId: siteId }}
                search={{ tab: "settings" }}
                className="font-medium text-fg underline underline-offset-2"
              >
                {canPublish ? "Restore it from Site details" : "View Site details"}
              </Link>
            </p>
          </>
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
              toolbarStart={backControl}
              showTitle={!titleInWindowBar || fullScreen}
              // The one publication control. The Site view never says "Live":
              // it stays current, and says so only while Updating or Reconnecting.
              liveStatus={
                <SitePublicationControl
                  load={publication.load}
                  canPublish={canPublish}
                  onOpenPublishing={openPublishing}
                />
              }
              versionId={artifact ? (artifact.currentVersion?.id ?? null) : undefined}
              watch={live.watch}
              versionControl={
                live.detail ? (
                  <SiteVersionMenu
                    workspaceId={workspaceId}
                    siteId={siteId}
                    detail={live.detail}
                    canPublish={canPublish}
                    onRestored={check}
                  />
                ) : undefined
              }
              fullScreen={fullScreen}
              onFullScreenChange={setFullScreen}
              archivedMessage={
                canPublish
                  ? "This Site is archived. Restore it from Site details."
                  : "This Site is archived."
              }
            />
          </div>
        )}
        <ChatFileDropCover relay={relay} enabled={!layout.collapsed} />
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
          artifactsReturn={back}
          layout={layout}
          updateLayout={updateLayout}
          onEvent={(event) => {
            // A publish or restore from this conversation shows at once.
            if (siteMayHaveChanged(event)) check();
          }}
        />
      </ChatFileDropRelayProvider>
    </div>
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
  artifactsReturn,
  layout,
  updateLayout,
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
  /** The Artifacts page the Site was opened from, kept when another conversation is chosen. */
  artifactsReturn?: SiteViewArtifactsReturn | undefined;
  /** Width, hidden and side, remembered per person; shared with the Site beside it. */
  layout: SiteChatPanelLayout;
  updateLayout: (patch: Partial<SiteChatPanelLayout>) => void;
  /** Each new event in the open conversation, so the Site can follow its edits. */
  onEvent: (event: SessionEvent) => void;
}) {
  const context = useAppContext();
  const api = useAppApi();
  const navigate = useNavigate();
  const panelId = useId();
  const panel = useRef<HTMLElement>(null);
  const hideButtonId = `${panelId}-hide`;
  const showButtonId = `${panelId}-show`;
  const list = useSiteConversations(workspaceId, siteId);
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

  // Choosing a conversation anywhere (the rail, a link) ends composing and
  // shows a hidden panel: the sidebar is where conversations are chosen, so
  // choosing one must show it. Opening the page keeps the panel as it was.
  // Returning to the Site itself, as its rail row does, opens its newest.
  const previousConversation = useRef(conversation);
  const startingNew = useRef(false);
  useEffect(() => {
    const previous = previousConversation.current;
    previousConversation.current = conversation;
    if (conversation) {
      setComposing(false);
      if (conversation !== previous) updateLayout({ collapsed: false });
    } else if (previous && !startingNew.current) setDefaultId(undefined);
    startingNew.current = false;
  }, [conversation, updateLayout]);

  const toSite = useCallback(
    (search: { conversation?: string }, replace = false) =>
      void navigate({
        to: SITE_ROUTE,
        params: { workspaceId, siteId },
        // Choosing a conversation keeps the Site where it is.
        search: { ...artifactsReturn, ...search, ...(page ? { page } : {}) },
        ...(replace ? { replace: true } : {}),
      }),
    [artifactsReturn, navigate, page, siteId, workspaceId],
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

  // Hiding and showing keep focus on the control that brings the panel back.
  const [focusToggle, setFocusToggle] = useState<"show" | "hide" | null>(null);
  useEffect(() => {
    if (!focusToggle) return;
    document.getElementById(focusToggle === "show" ? showButtonId : hideButtonId)?.focus();
    setFocusToggle(null);
  }, [focusToggle, hideButtonId, showButtonId]);
  const hide = () => {
    updateLayout({ collapsed: true });
    setFocusToggle("show");
  };
  const show = () => {
    updateLayout({ collapsed: false });
    setFocusToggle("hide");
  };

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
    updateLayout({ collapsed: false });
    if (conversation) startingNew.current = true;
    toSite({}, true);
  }, [conversation, startNewRequested, toSite, updateLayout]);
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
      if (!versionId) throw new Error("This Site has no published version yet.");
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
    <>
      <aside
        ref={panel}
        id={panelId}
        aria-label="Chat"
        hidden={layout.collapsed}
        style={{ [WIDTH_VARIABLE]: `${width}px` } as CSSProperties}
        data-position={layout.position}
        className={cn(
          "relative flex min-h-0 shrink-0 flex-col border-border bg-bg lg:w-(--og-site-chat-width) max-lg:h-[55%] max-lg:w-full max-lg:border-t",
          left ? "lg:border-r" : "lg:border-l",
          // Hidden, not unmounted: the conversation keeps its place and stream.
          layout.collapsed && "hidden",
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
          onCollapse={hide}
          className="max-lg:hidden"
        />
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border pr-2 pl-4">
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
              className="pointer-coarse:h-11"
              onClick={startNew}
            >
              <PlusIcon aria-hidden="true" className="size-3.5" />
              New
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="More"
                title="More"
                className="text-fg-muted hover:text-fg pointer-coarse:size-11"
              >
                <MoreHorizontalIcon aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {selectedId ? (
                <DropdownMenuItem asChild>
                  <Link
                    to="/workspaces/$workspaceId/sessions/$sessionId"
                    params={{ workspaceId, sessionId: selectedId }}
                  >
                    <Maximize2Icon aria-hidden="true" />
                    Open as a full chat
                  </Link>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem asChild>
                <Link
                  to="/workspaces/$workspaceId/artifacts/$artifactId"
                  params={{ workspaceId, artifactId: siteId }}
                  // Its details are by tab; without one the address opens
                  // the Site view again. Settings shows Versions to people
                  // who can't manage it.
                  search={{ tab: "settings" }}
                >
                  <InfoIcon aria-hidden="true" />
                  Site details
                </Link>
              </DropdownMenuItem>
              {/* Beside the Site only on wide screens; narrower ones stack the chat below. */}
              <DropdownMenuItem
                className="max-lg:hidden"
                onSelect={() => updateLayout({ position: left ? "right" : "left" })}
              >
                {left ? (
                  <PanelRightIcon aria-hidden="true" />
                ) : (
                  <PanelLeftIcon aria-hidden="true" />
                )}
                {left ? "Move chat to right" : "Move chat to left"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            id={hideButtonId}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Hide chat"
            title="Hide chat"
            aria-controls={panelId}
            aria-expanded={true}
            className="text-fg-muted hover:text-fg pointer-coarse:size-11"
            onClick={hide}
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
              <PanelLoading label="Loading Site" />
            ) : site.status === "error" ? (
              <Retry message="Couldn’t load this Site." onRetry={retrySite} />
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
      {layout.collapsed ? (
        <div
          className={cn(
            "flex shrink-0 border-border bg-bg lg:w-12 lg:flex-col max-lg:h-12 max-lg:justify-end max-lg:border-t max-lg:px-2",
            left ? "lg:border-r" : "lg:border-l",
          )}
        >
          <div className="flex h-12 items-center justify-center">
            <Button
              id={showButtonId}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Show chat"
              title="Show chat"
              aria-controls={panelId}
              aria-expanded={false}
              className="text-fg-muted hover:text-fg pointer-coarse:size-11"
              onClick={show}
            >
              {left ? (
                <PanelLeftOpenIcon aria-hidden="true" className="size-4" />
              ) : (
                <PanelRightOpenIcon aria-hidden="true" className="size-4" />
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </>
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
