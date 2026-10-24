import { SITE_ID_HEADER, SITE_VERSION_HEADER } from "@opengeni/contracts/site-session-http";
import type { Session, SessionListResponse } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import {
  InfoIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlusIcon,
} from "lucide-react";
import {
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
import { NewConversation } from "../../components/new-conversation";
import type {
  CreatedConversation,
  NewConversationCreateOptions,
} from "../../hooks/use-new-conversation";
import { SessionConversation } from "../../components/session-conversation";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { ResizeHandle } from "../../ui/resize-handle";
import { Skeleton } from "../../ui/skeleton";
import { useAppContext } from "../app-context";
import {
  SitePublicLink,
  useSitePublicationLink,
  type SitePublicationLinkLoad,
} from "../components/artifacts/site-public-link";
import { useAppApi } from "../lib/app-api";
import { useConsoleSiteToolBridge, useConsoleSiteViewer } from "../lib/console-site";
import { Link, useNavigate } from "../lib/navigation";
import { hasWorkspacePermission } from "../lib/permissions";
import { sessionDisplayTitle } from "../lib/session-rename";
import { sessionSiteOrigin } from "../lib/session-site-origin";
import {
  SITE_CHAT_DEFAULT_WIDTH,
  SITE_CHAT_MAX_WIDTH,
  SITE_CHAT_MIN_WIDTH,
  SITE_MIN_WIDTH,
  useSiteChatPanelLayout,
} from "../lib/site-chat-panel";
import { useRecordSiteOpened } from "../lib/site-opened";
import { useSessionListHintRefresh } from "../lib/use-session-list-hint-refresh";
import { cn } from "../lib/utils";

const SITE_ROUTE = "/workspaces/$workspaceId/sites/$siteId";
/** The panel's width while it sits beside the Site, set live while dragging. */
const WIDTH_VARIABLE = "--og-site-chat-width";

type SiteState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; title: string; versionId: string | null; archived: boolean };

/**
 * A Site with its chat beside it. The Site fills the page; the panel shows
 * one conversation (the newest when the Site opens, unless one is chosen) as
 * a regular chat, narrower, and starts a new one. The sidebar lists the
 * Site's conversations, so the panel doesn't repeat them. The panel can be
 * resized and hidden; both are remembered per person, and choosing a
 * conversation brings a hidden panel back.
 */
export function SiteViewRoute({
  workspaceId,
  siteId,
  conversation,
}: {
  workspaceId: string;
  siteId: string;
  /** The conversation open in the panel; the newest when omitted. */
  conversation?: string | undefined;
}) {
  const { client, accessContext } = useAppContext();
  const viewer = useConsoleSiteViewer();
  // Anyone who can open the Site gets its published address in the header;
  // Publish is offered only to people who can publish.
  const canPublish = hasWorkspacePermission(accessContext, workspaceId, "artifacts:publish");
  const publicationLink = useSitePublicationLink({ client, workspaceId, siteId });
  const toolBridge = useConsoleSiteToolBridge(workspaceId);
  const [site, setSite] = useState<SiteState>({ status: "loading" });
  const [siteAttempt, setSiteAttempt] = useState(0);
  useRecordSiteOpened(client, workspaceId, siteId);
  useEffect(() => {
    const abort = new AbortController();
    setSite({ status: "loading" });
    client
      .getWorkspaceArtifact(workspaceId, siteId, { signal: abort.signal })
      .then(({ artifact }) => {
        if (abort.signal.aborted) return;
        setSite({
          status: "ready",
          title: artifact.title,
          versionId: artifact.currentVersion?.id ?? null,
          archived: artifact.status === "archived",
        });
      })
      .catch(() => {
        if (!abort.signal.aborted) setSite({ status: "error" });
      });
    return () => abort.abort();
  }, [client, siteAttempt, siteId, workspaceId]);
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 max-lg:flex-col"
      data-workspace-scroll-owner="self-managed"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SiteView
          client={client}
          workspaceId={workspaceId}
          siteId={siteId}
          toolBridge={toolBridge}
          viewer={viewer}
          liveStatus={siteLiveStatus(publicationLink, canPublish, workspaceId, siteId)}
          archivedMessage="This Site is archived. Restore it from Site details."
        />
      </div>
      <SiteChatPanel
        key={`${workspaceId}:${siteId}`}
        workspaceId={workspaceId}
        siteId={siteId}
        site={site}
        retrySite={() => setSiteAttempt((attempt) => attempt + 1)}
        conversation={conversation}
      />
    </div>
  );
}

const PAGE_SIZE = 30;

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
  conversation,
}: {
  workspaceId: string;
  siteId: string;
  site: SiteState;
  retrySite: () => void;
  conversation?: string | undefined;
}) {
  const context = useAppContext();
  const api = useAppApi();
  const navigate = useNavigate();
  const panelId = useId();
  const panel = useRef<HTMLElement>(null);
  const hideButtonId = `${panelId}-hide`;
  const showButtonId = `${panelId}-show`;
  const list = useSiteConversations(workspaceId, siteId);
  const { layout, update: updateLayout } = useSiteChatPanelLayout(context.accessContext.subjectId);
  const maxWidth = useAvailableWidth(panel);
  const width = Math.min(layout.width, maxWidth);
  const [composing, setComposing] = useState(false);
  const [handoff, setHandoff] = useState<CreatedConversation | null>(null);
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
        search,
        ...(replace ? { replace: true } : {}),
      }),
    [navigate, siteId, workspaceId],
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
  // Created like the Site's own chats: private to this person and listed
  // under the Site. The API refuses anything else a Site may not set.
  const versionId = ready?.versionId ?? null;
  const createSession = useCallback(
    async (
      initialMessage: string,
      idempotencyKey: string,
      options: NewConversationCreateOptions,
    ): Promise<string> => {
      if (!versionId) throw new Error("This Site has no published version yet.");
      const created = await api.request<Pick<Session, "id">>(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
        {
          method: "POST",
          headers: { [SITE_ID_HEADER]: siteId, [SITE_VERSION_HEADER]: versionId },
          body: JSON.stringify({
            initialMessage,
            idempotencyKey,
            ...(options.model ? { model: options.model } : {}),
            ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
            ...(options.latencyMode ? { latencyMode: options.latencyMode } : {}),
          }),
        },
      );
      return created.id;
    },
    [api, siteId, versionId, workspaceId],
  );
  const handedOff = handoff !== null && handoff.sessionId === selectedId ? handoff : null;
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
        className={cn(
          "relative flex min-h-0 shrink-0 flex-col border-l border-border bg-bg lg:w-(--og-site-chat-width) max-lg:h-[55%] max-lg:w-full max-lg:border-t max-lg:border-l-0",
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
          edge="start"
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
            <DropdownMenuContent align="end" className="w-48">
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
                >
                  <InfoIcon aria-hidden="true" />
                  Site details
                </Link>
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
            <PanelRightCloseIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>
        {/* The regular chat's inset, so the composer sits as it does in a full chat. */}
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          {!list.loaded && !conversation ? (
            list.error ? (
              <Retry message="Couldn’t load conversations." onRetry={() => void list.refresh()} />
            ) : (
              <PanelLoading label="Loading conversations" />
            )
          ) : showComposer ? (
            canCreate ? (
              <NewConversation
                key={`new:${siteId}`}
                createSession={createSession}
                // A Site's new conversation takes only text and a model; files
                // can be added once it has started.
                attachments={false}
                modelPicker
                // Voice-first chats aren't offered from a Site.
                realtimeVoice={false}
                labels={{ title: ready ? `Ask about ${ready.title}` : "New conversation" }}
                onCreated={(created) => {
                  setHandoff(created);
                  void list.refresh();
                  // Opening it ends composing, like any other choice.
                  toSite({ conversation: created.sessionId });
                }}
                className="min-h-0 flex-1"
              />
            ) : site.status === "loading" ? (
              <PanelLoading label="Loading Site" />
            ) : site.status === "error" ? (
              <Retry message="Couldn’t load this Site." onRetry={retrySite} />
            ) : (
              <p className="py-4 pl-1 text-sm text-fg-muted">No conversations yet.</p>
            )
          ) : selectedId ? (
            <SessionConversation
              key={selectedId}
              sessionId={selectedId}
              // As in a regular chat: choose the model and attach files.
              modelPicker
              viewerSubjectId={context.accessContext.subjectId}
              // The first prompt and anything typed meanwhile carry over.
              {...(handedOff?.initialMessage
                ? { pendingPrompt: { text: handedOff.initialMessage, sentAt: handedOff.sentAt } }
                : {})}
              {...(handedOff ? { composerOptions: { initialDraft: handedOff.draft } } : {})}
              onOpenSession={(sessionId) =>
                void navigate({
                  to: "/workspaces/$workspaceId/sessions/$sessionId",
                  params: { workspaceId, sessionId },
                })
              }
              className="min-h-0 flex-1"
            />
          ) : null}
        </div>
      </aside>
      {layout.collapsed ? (
        <div className="flex shrink-0 border-border bg-bg lg:w-12 lg:flex-col lg:border-l max-lg:h-12 max-lg:justify-end max-lg:border-t max-lg:px-2">
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
              <PanelRightOpenIcon aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The header's publication control, or undefined for the plain "Live". */
function siteLiveStatus(
  load: SitePublicationLinkLoad,
  canPublish: boolean,
  workspaceId: string,
  siteId: string,
) {
  // Nothing until the answer, so an unpublished Site never flashes "Live".
  if (load.state === "loading") return null;
  // No Sites domain, no access to the address, or a failed read: the plain "Live".
  if (load.state === "unavailable" || load.state === "forbidden" || load.state === "error")
    return undefined;
  return (
    <SitePublicLink load={load} workspaceId={workspaceId} siteId={siteId} canPublish={canPublish} />
  );
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3 py-4 pl-1" aria-busy="true">
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
    <p className="py-4 pl-1 text-sm text-fg-muted">
      {message}{" "}
      <button type="button" className="og-link" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}
