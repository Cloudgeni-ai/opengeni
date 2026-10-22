import { SITE_ID_HEADER, SITE_VERSION_HEADER } from "@opengeni/contracts/site-session-http";
import type { Session, SessionListResponse } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { InfoIcon, Maximize2Icon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
import { Skeleton } from "../../ui/skeleton";
import { useAppContext } from "../app-context";
import { useAppApi } from "../lib/app-api";
import { useConsoleSiteToolBridge, useConsoleSiteViewer } from "../lib/console-site";
import { t } from "../lib/console-text";
import { formatTimestamp } from "../lib/format";
import { Link, useNavigate } from "../lib/navigation";
import { hasWorkspacePermission } from "../lib/permissions";
import { sessionDisplayTitle } from "../lib/session-rename";
import { sessionStateLabel } from "../lib/session-rail";
import { sessionSiteOrigin } from "../lib/session-site-origin";
import { isRunningStatus, relativeTimeLabel } from "../lib/sessions-group";
import { useRecordSiteOpened } from "../lib/site-opened";
import { useSessionListHintRefresh } from "../lib/use-session-list-hint-refresh";
import { cn } from "../lib/utils";

const SITE_ROUTE = "/workspaces/$workspaceId/sites/$siteId";

type SiteState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; title: string; versionId: string | null; archived: boolean };

/**
 * A Site with its conversations beside it. The Site fills the page; the
 * panel keeps one conversation open (the newest when the Site opens, unless
 * one is chosen), lists the others to switch between, and starts a new one.
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
  const { client } = useAppContext();
  const viewer = useConsoleSiteViewer();
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
    <div className="flex min-h-0 min-w-0 flex-1 max-lg:flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SiteView
          client={client}
          workspaceId={workspaceId}
          siteId={siteId}
          toolBridge={toolBridge}
          viewer={viewer}
          archivedMessage="This Site is archived. Restore it from Site details."
        />
      </div>
      <SiteConversationsColumn
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
/** The most a session list page returns. */
const MAX_PAGE_SIZE = 100;

/** The Site's own conversations for this viewer, newest activity first. */
function useSiteConversations(workspaceId: string, siteId: string) {
  const { client } = useAppContext();
  const [page, setPage] = useState<SessionListResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef<AbortController | null>(null);
  const more = useRef<AbortController | null>(null);
  // A refresh re-reads as many as are loaded, so "Show older" survives updates.
  const loadedCount = useRef(0);
  useEffect(() => {
    loadedCount.current = page?.sessions.length ?? 0;
  }, [page]);
  const read = useCallback(
    (signal: AbortSignal, cursor?: string, limit = PAGE_SIZE) =>
      client.listSessionPage(workspaceId, {
        originSiteId: siteId,
        parentSessionId: null,
        sortBy: "updatedAt",
        limit,
        signal,
        ...(cursor ? { cursor } : {}),
      }),
    [client, siteId, workspaceId],
  );
  const refresh = useCallback(async () => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    try {
      const next = await read(
        abort.signal,
        undefined,
        Math.min(MAX_PAGE_SIZE, Math.max(PAGE_SIZE, loadedCount.current)),
      );
      if (abort.signal.aborted) return;
      setPage(next);
      setError(null);
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure : new Error(String(failure)));
    }
  }, [read]);
  useEffect(() => {
    void refresh();
    return () => {
      request.current?.abort();
      more.current?.abort();
    };
  }, [refresh]);
  // This list shows only Site conversations, which ordinary hints never name.
  useSessionListHintRefresh(refresh, error, { siteConversations: true });
  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor;
    if (!cursor || loadingMore) return;
    const abort = new AbortController();
    more.current = abort;
    setLoadingMore(true);
    try {
      const next = await read(abort.signal, cursor);
      if (abort.signal.aborted) return;
      setPage((current) =>
        // Only extend the page this cursor came from; a refresh since replaced it.
        current?.nextCursor === cursor
          ? {
              ...next,
              sessions: [
                ...new Map(
                  [...current.sessions, ...next.sessions].map((session) => [session.id, session]),
                ).values(),
              ],
            }
          : current,
      );
    } catch {
      // The button stays, so trying again is one click.
    } finally {
      if (more.current === abort) more.current = null;
      setLoadingMore(false);
    }
  }, [loadingMore, page?.nextCursor, read]);
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
  return {
    sessions,
    loaded: page !== null,
    error,
    nextCursor: page?.nextCursor ?? null,
    loadingMore,
    refresh,
    loadMore,
  };
}

function SiteConversationsColumn({
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
  const headingId = useId();
  const panel = useRef<HTMLElement>(null);
  const list = useSiteConversations(workspaceId, siteId);
  const [composing, setComposing] = useState(false);
  const [handoff, setHandoff] = useState<CreatedConversation | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

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

  // Choosing a conversation anywhere (the rail, a link) ends composing.
  // Returning to the Site itself, as its rail row does, opens its newest.
  const previousConversation = useRef(conversation);
  const startingNew = useRef(false);
  useEffect(() => {
    const previous = previousConversation.current;
    previousConversation.current = conversation;
    if (conversation) setComposing(false);
    else if (previous && !startingNew.current) setDefaultId(undefined);
    startingNew.current = false;
  }, [conversation]);

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
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const input = panel.current?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])");
      if (input) input.focus();
      else if ((tries += 1) < 60) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

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
  const conversations = list.sessions;
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
  return (
    <aside
      ref={panel}
      aria-labelledby={headingId}
      className="flex min-h-0 w-[400px] shrink-0 flex-col border-l border-border bg-bg max-xl:w-[360px] max-lg:h-[55%] max-lg:w-full max-lg:border-t max-lg:border-l-0"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border pr-2 pl-4">
        <h2 id={headingId} className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          Conversations
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
      </div>
      {conversations.length > (showComposer ? 0 : 1) ? (
        <nav
          aria-label={`Conversations in ${ready?.title ?? "this Site"}`}
          className="max-h-[172px] shrink-0 overflow-y-auto border-b border-border p-1.5"
        >
          <ul className="flex flex-col gap-px">
            {conversations.map((session) => (
              <ConversationRow
                key={session.id}
                workspaceId={workspaceId}
                siteId={siteId}
                session={session}
                selected={session.id === selectedId}
              />
            ))}
          </ul>
          {list.nextCursor ? (
            <button
              type="button"
              disabled={list.loadingMore}
              onClick={() => void list.loadMore()}
              className="mt-px flex h-8 w-full items-center rounded-md px-2 text-left text-xs text-fg-muted hover:bg-hover hover:text-fg pointer-coarse:h-11"
            >
              {list.loadingMore ? "Loading…" : "Show older"}
            </button>
          ) : null}
        </nav>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
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
              attachments={false}
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
            <p className="p-4 text-sm text-fg-muted">
              {ready?.archived
                ? "No conversations yet."
                : "No conversations yet. Conversations started in this Site appear here."}
            </p>
          )
        ) : selectedId ? (
          <SessionConversation
            key={selectedId}
            sessionId={selectedId}
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
  );
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy="true">
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
    <p className="p-4 text-sm text-fg-muted">
      {message}{" "}
      <button type="button" className="text-fg underline underline-offset-2" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}

function ConversationRow({
  workspaceId,
  siteId,
  session,
  selected,
}: {
  workspaceId: string;
  siteId: string;
  session: Session;
  selected: boolean;
}) {
  const title = sessionDisplayTitle(session);
  const running = isRunningStatus(session.status);
  return (
    <li>
      <Link
        to={SITE_ROUTE}
        params={{ workspaceId, siteId }}
        search={{ conversation: session.id }}
        aria-current={selected ? "page" : undefined}
        aria-label={`${title}. ${sessionStateLabel(session)}. Updated ${formatTimestamp(session.updatedAt)}`}
        className={cn(
          "flex h-8 items-center gap-2 rounded-md border px-2 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:h-11",
          selected
            ? "border-brand/20 bg-selection text-fg"
            : "border-transparent text-fg-label hover:bg-hover hover:text-fg",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {running ? (
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-status-running" />
        ) : null}
        <span aria-hidden="true" className="shrink-0 text-xs tabular-nums text-fg-subtle">
          {relativeTimeLabel(t, session.updatedAt)}
        </span>
      </Link>
    </li>
  );
}
