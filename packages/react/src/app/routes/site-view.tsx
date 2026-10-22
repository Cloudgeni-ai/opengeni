import { SITE_ID_HEADER, SITE_VERSION_HEADER } from "@opengeni/contracts/site-session-http";
import type { Session, SessionListResponse } from "@opengeni/sdk";
import { Maximize2Icon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SiteView } from "../../artifacts";
import { NewConversation } from "../../components/new-conversation";
import type { NewConversationCreateOptions } from "../../hooks/use-new-conversation";
import { SessionConversation } from "../../components/session-conversation";
import { Button } from "../../ui/button";
import { Skeleton } from "../../ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { useAppContext } from "../app-context";
import { useAppApi } from "../lib/app-api";
import { useConsoleSiteToolBridge, useConsoleSiteViewer } from "../lib/console-site";
import { t } from "../lib/console-text";
import { Link, useNavigate } from "../lib/navigation";
import { hasWorkspacePermission } from "../lib/permissions";
import { workspaceSitePath } from "../lib/routes";
import { sessionDisplayTitle } from "../lib/session-rename";
import { sessionStateLabel } from "../lib/session-rail";
import { isRunningStatus, relativeTimeLabel } from "../lib/sessions-group";
import { useSessionListHintRefresh } from "../lib/use-session-list-hint-refresh";
import { cn } from "../lib/utils";

type SiteState = { title: string; versionId: string | null; archived: boolean };

/**
 * A Site with its conversations beside it. The Site fills the page; the
 * panel keeps one conversation open (the newest unless one is chosen), lists
 * the others to switch between, and starts a new one.
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
  const [site, setSite] = useState<SiteState | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setSite(null);
    client
      .getWorkspaceArtifact(workspaceId, siteId, { signal: abort.signal })
      .then(({ artifact }) => {
        if (abort.signal.aborted) return;
        setSite({
          title: artifact.title,
          versionId: artifact.currentVersion?.id ?? null,
          archived: artifact.status === "archived",
        });
      })
      // SiteView shows why the Site can't load; the panel only loses New.
      .catch(() => undefined);
    return () => abort.abort();
  }, [client, siteId, workspaceId]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 max-lg:flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SiteView
          client={client}
          workspaceId={workspaceId}
          siteId={siteId}
          toolBridge={toolBridge}
          viewer={viewer}
          archivedMessage="This Site is archived. Restore it from its settings."
        />
      </div>
      <SiteConversationsColumn
        key={`${workspaceId}:${siteId}`}
        workspaceId={workspaceId}
        siteId={siteId}
        site={site}
        conversation={conversation}
      />
    </div>
  );
}

const PAGE_SIZE = 30;

/** The Site's own conversations for this viewer, newest activity first. */
function useSiteConversations(workspaceId: string, siteId: string) {
  const { client } = useAppContext();
  const [page, setPage] = useState<SessionListResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef<AbortController | null>(null);
  const read = useCallback(
    (cursor?: string) =>
      client.listSessionPage(workspaceId, {
        originSiteId: siteId,
        parentSessionId: null,
        sortBy: "updatedAt",
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }),
    [client, siteId, workspaceId],
  );
  const refresh = useCallback(async () => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    try {
      const next = await read();
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
    return () => request.current?.abort();
  }, [refresh]);
  useSessionListHintRefresh(refresh, error);
  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await read(cursor);
      setPage((current) =>
        current
          ? {
              ...next,
              sessions: [
                ...new Map(
                  [...current.sessions, ...next.sessions].map((session) => [session.id, session]),
                ).values(),
              ],
            }
          : next,
      );
    } catch {
      // The button stays, so trying again is one click.
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, page?.nextCursor, read]);
  const sessions = page
    ? [...new Map([...page.pinned, ...page.sessions].map((session) => [session.id, session]))]
        .map(([, session]) => session)
        .filter((session) => !session.archived)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    : [];
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
  conversation,
}: {
  workspaceId: string;
  siteId: string;
  site: SiteState | null;
  conversation?: string | undefined;
}) {
  const context = useAppContext();
  const api = useAppApi();
  const navigate = useNavigate();
  const list = useSiteConversations(workspaceId, siteId);
  const [composing, setComposing] = useState(false);
  // Choosing a conversation anywhere (the rail, a link) ends composing.
  useEffect(() => {
    if (conversation) setComposing(false);
  }, [conversation]);
  const canCreate =
    hasWorkspacePermission(context.accessContext, workspaceId, "sessions:create") &&
    site !== null &&
    site.versionId !== null &&
    !site.archived;
  const selectedId = composing ? null : (conversation ?? list.sessions[0]?.id ?? null);
  const showComposer = composing || (list.loaded && selectedId === null);
  const select = (sessionId: string) => {
    setComposing(false);
    void navigate({
      to: "/workspaces/$workspaceId/sites/$siteId",
      params: { workspaceId, siteId },
      search: { conversation: sessionId },
    });
  };
  // Created like the Site's own chats: private to this person and listed
  // under the Site. The API refuses anything else a Site may not set.
  const createSession = useCallback(
    async (
      initialMessage: string,
      idempotencyKey: string,
      options: NewConversationCreateOptions,
    ): Promise<string> => {
      if (!site?.versionId) throw new Error("This Site has no published version yet.");
      const created = await api.request<Pick<Session, "id">>(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
        {
          method: "POST",
          headers: { [SITE_ID_HEADER]: siteId, [SITE_VERSION_HEADER]: site.versionId },
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
    [api, site?.versionId, siteId, workspaceId],
  );
  const others = list.sessions;
  return (
    <aside
      aria-label="Conversations"
      className="flex min-h-0 w-[400px] shrink-0 flex-col border-l border-border bg-bg max-xl:w-[360px] max-lg:h-[55%] max-lg:w-full max-lg:border-t max-lg:border-l-0"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">Conversations</h2>
        {selectedId ? (
          <Tooltip>
            <TooltipTrigger asChild>
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
                >
                  <Maximize2Icon aria-hidden="true" className="size-3.5" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Open as a full chat</TooltipContent>
          </Tooltip>
        ) : null}
        {canCreate ? (
          <Button
            type="button"
            variant={showComposer ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={showComposer}
            className="pointer-coarse:h-11"
            onClick={() => {
              setComposing(true);
              // Nothing is selected while composing, so the rail marks the Site.
              if (conversation)
                void navigate({
                  to: "/workspaces/$workspaceId/sites/$siteId",
                  params: { workspaceId, siteId },
                  search: {},
                });
            }}
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
            New
          </Button>
        ) : null}
      </div>
      {others.length > (showComposer ? 0 : 1) ? (
        <nav
          aria-label={`Conversations in ${site?.title ?? "this Site"}`}
          className="max-h-[172px] shrink-0 overflow-y-auto border-b border-border p-1.5"
        >
          <ul className="flex flex-col gap-px">
            {others.map((session) => (
              <ConversationRow
                key={session.id}
                session={session}
                selected={session.id === selectedId}
                href={workspaceSitePath(workspaceId, siteId, session.id)}
                onSelect={() => select(session.id)}
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
            <p className="p-4 text-sm text-fg-muted">
              Couldn't load conversations.{" "}
              <button
                type="button"
                className="text-fg underline underline-offset-2"
                onClick={() => void list.refresh()}
              >
                Try again
              </button>
            </p>
          ) : (
            <div className="flex flex-col gap-3 p-4" aria-busy="true">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-16 w-full rounded-lg" />
              <span className="sr-only" role="status">
                Loading conversations
              </span>
            </div>
          )
        ) : showComposer ? (
          canCreate ? (
            <NewConversation
              key={`new:${siteId}`}
              createSession={createSession}
              attachments={false}
              labels={{ title: site?.title ? `Ask about ${site.title}` : "New conversation" }}
              onCreated={(created) => {
                void list.refresh();
                select(created.sessionId);
              }}
              className="min-h-0 flex-1"
            />
          ) : (
            <p className="p-4 text-sm text-fg-muted">
              {site?.archived
                ? "This Site is archived."
                : "No conversations yet. Conversations started in this Site appear here."}
            </p>
          )
        ) : selectedId ? (
          <SessionConversation
            key={selectedId}
            sessionId={selectedId}
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

function ConversationRow({
  session,
  selected,
  href,
  onSelect,
}: {
  session: Session;
  selected: boolean;
  href: string;
  onSelect: () => void;
}) {
  const title = sessionDisplayTitle(session);
  const running = isRunningStatus(session.status);
  return (
    <li>
      <a
        href={href}
        aria-current={selected ? "true" : undefined}
        aria-label={`${title}. ${sessionStateLabel(session)}`}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          onSelect();
        }}
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
      </a>
    </li>
  );
}
