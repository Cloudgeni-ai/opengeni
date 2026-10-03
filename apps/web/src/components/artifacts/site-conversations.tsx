import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquareIcon, RefreshCwIcon } from "lucide-react";
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

/**
 * The Site page's Conversations tab. Host-owned, so it works even when the
 * generated Site is broken.
 */
export function SiteConversations(props: { workspaceId: string; siteId: string; title: string }) {
  const { client } = useAppContext();
  return <SiteConversationsPanel {...props} client={client} />;
}

export function SiteConversationsPanel({
  client,
  workspaceId,
  siteId,
  title,
}: {
  client: Pick<OpenGeniBrowserClient, "listSessionPage">;
  workspaceId: string;
  siteId: string;
  title: string;
}) {
  const [search, setSearch] = useState("");
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [page, setPage] = useState<SessionListResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
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
          originSiteId: siteId,
          search,
          archivedOnly,
          limit: 30,
          cursor,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
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
    [client, workspaceId, siteId, search, archivedOnly],
  );
  useEffect(() => {
    setPage(null);
    void load();
    return () => request.current?.abort();
  }, [load]);
  const sessions = page
    ? [...new Map([...page.pinned, ...page.sessions].map((s) => [s.id, s])).values()]
    : [];
  const navigate = useNavigate();
  return (
    <section aria-label={`Conversations from ${title}`} className="flex min-w-0 flex-col gap-4">
      <p className="text-sm leading-5 text-fg-muted">
        Conversations started from {title}, including ones filed in projects.
      </p>
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
          title={search ? "No matching conversations." : "No conversations yet."}
        />
      ) : (
        <RowList label="Conversations" busy={busy}>
          {sessions.map((session) => (
            <ListRow
              key={session.id}
              leading={<LogoTile icon={<MessageSquareIcon />} name="Conversation" />}
              title={sessionDisplayTitle(session)}
              meta={[sessionStateLabel(session)]}
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
