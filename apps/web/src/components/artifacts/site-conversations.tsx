import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import type { SessionListResponse } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Toolbar, ToolbarGroup, ToolbarSearch } from "@/components/ui/toolbar";
import { sessionDisplayTitle } from "@/lib/session-rename";
import { sessionStateLabel } from "@/lib/session-rail";
import { userErrorText } from "@/lib/api-error";

/**
 * The Site page's Conversations tab. Host-owned, so it works even when the
 * generated Site is broken.
 */
export function SiteConversations(props: {
  workspaceId: string;
  siteId: string;
  title: string;
  canManageAccess?: boolean;
}) {
  const { client } = useAppContext();
  return <SiteConversationsPanel {...props} client={client} />;
}

export function SiteConversationsPanel({
  client,
  workspaceId,
  siteId,
  title,
  canManageAccess = false,
}: {
  client: Pick<
    OpenGeniBrowserClient,
    "listSessionPage" | "listSiteSessionAccess" | "setSiteSessionAccess"
  >;
  workspaceId: string;
  siteId: string;
  title: string;
  canManageAccess?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [page, setPage] = useState<SessionListResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [changing, setChanging] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(
    async (cursor?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError(false);
      try {
        const next = await client.listSessionPage(workspaceId, {
          ...(!adding ? { siteAccessId: siteId } : {}),
          search,
          archivedOnly,
          limit: 30,
          cursor,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (canManageAccess) {
          const access = await client.listSiteSessionAccess(workspaceId, siteId);
          if (controller.signal.aborted) return;
          setAllowed(access.sessionIds);
        }
        setPage((previous) =>
          cursor && previous
            ? {
                ...next,
                sessions: [
                  ...new Map(
                    [...previous.sessions, ...next.sessions].map((s) => [s.id, s]),
                  ).values(),
                ],
              }
            : next,
        );
      } catch {
        if (!controller.signal.aborted) {
          setError(true);
          setPage(null);
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [client, workspaceId, siteId, search, archivedOnly, adding, canManageAccess],
  );
  useEffect(() => {
    setPage(null);
    void load();
    return () => request.current?.abort();
  }, [load]);
  const visibleSessions = page
    ? [...new Map([...page.pinned, ...page.sessions].map((s) => [s.id, s])).values()]
    : [];
  const sessions = adding
    ? visibleSessions.filter(
        (session) => session.tenancy?.ownedByCurrentUser && !session.metadata._opengeniSiteOrigin,
      )
    : visibleSessions;
  const changeAccess = async (sessionId: string, allow: boolean) => {
    setChanging(sessionId);
    try {
      await client.setSiteSessionAccess(workspaceId, siteId, sessionId, allow);
      setAllowed((current) =>
        allow ? [...new Set([...current, sessionId])] : current.filter((id) => id !== sessionId),
      );
      toast.success(
        allow ? "Chat allowed in this Site" : "Chat access removed",
        !allow
          ? {
              action: { label: "Undo", onClick: () => void changeAccess(sessionId, true) },
            }
          : undefined,
      );
      await load();
    } catch (failure) {
      toast.error("Couldn’t change chat access", { description: userErrorText(failure) });
    } finally {
      setChanging(null);
    }
  };
  const navigate = useNavigate();
  return (
    <section aria-label={`Conversations in ${title}`} className="flex min-w-0 flex-col gap-4">
      <p className="text-sm leading-5 text-fg-muted">
        {adding
          ? `Choose a chat you own. ${title} can read it and send messages as you, using the chat’s existing tools and permissions. Only allow Sites you trust. Approvals stay in the console.`
          : `Conversations available in ${title}, including ones you explicitly allowed.`}
      </p>
      {canManageAccess && (
        <Button
          type="button"
          variant="outline"
          className="self-start pointer-coarse:h-11"
          onClick={() => {
            setAdding((value) => !value);
            setSearch("");
          }}
        >
          {adding ? "Back to Site conversations" : "Allow an existing chat"}
        </Button>
      )}
      <Toolbar>
        <ToolbarSearch
          value={search}
          onValueChange={setSearch}
          placeholder="Search conversations"
          aria-label="Search Site conversations"
        />
        <ToolbarGroup align="end">
          <SegmentedControl<"active" | "archived">
            aria-label="Conversation visibility"
            size="sm"
            options={[
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
            ]}
            value={archivedOnly ? "archived" : "active"}
            onValueChange={(value) => setArchivedOnly(value === "archived")}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh conversations"
            disabled={busy}
            onClick={() => void load()}
            className="rounded-[10px] text-fg-muted pointer-coarse:size-11"
          >
            <RefreshCwIcon />
          </Button>
        </ToolbarGroup>
      </Toolbar>
      {error ? (
        <Notice tone="failed" live="assertive">
          Couldn’t load conversations. Try refreshing.
        </Notice>
      ) : busy && !page ? (
        <RowList label="Conversations" busy>
          <ListRowSkeleton count={3} />
        </RowList>
      ) : sessions.length === 0 ? (
        <EmptyState
          variant="inline"
          title={
            search
              ? "No matching conversations."
              : adding
                ? "No chats you own on this page."
                : "No conversations yet."
          }
        />
      ) : (
        <RowList label="Conversations" busy={busy}>
          {sessions.map((session) => (
            <ListRow
              key={session.id}
              leading={<LogoTile icon={<MessageSquareIcon />} name="Conversation" />}
              title={sessionDisplayTitle(session)}
              meta={[sessionStateLabel(session)]}
              control={
                canManageAccess && (adding || allowed.includes(session.id)) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="pointer-coarse:h-11"
                    disabled={changing !== null || (adding && allowed.includes(session.id))}
                    aria-label={`${adding ? (allowed.includes(session.id) ? "Already allowed:" : "Allow") : "Remove access to"} ${sessionDisplayTitle(session)}`}
                    onClick={() => void changeAccess(session.id, adding)}
                  >
                    {changing === session.id
                      ? "Saving…"
                      : adding
                        ? allowed.includes(session.id)
                          ? "Allowed"
                          : "Allow chat"
                        : "Remove access"}
                  </Button>
                ) : undefined
              }
              href={`/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(session.id)}`}
              onOpen={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                void navigate({
                  to: "/workspaces/$workspaceId/sessions/$sessionId",
                  params: { workspaceId, sessionId: session.id },
                });
              }}
            />
          ))}
        </RowList>
      )}
      {page?.nextCursor && !error ? (
        <Button
          type="button"
          variant="outline"
          className="self-start pointer-coarse:h-11"
          disabled={busy}
          onClick={() => void load(page.nextCursor!)}
        >
          Load older conversations
        </Button>
      ) : null}
    </section>
  );
}
