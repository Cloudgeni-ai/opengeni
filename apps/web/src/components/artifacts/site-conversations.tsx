import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import type { SessionListResponse } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";
import { sessionDisplayTitle } from "@/lib/session-rename";
import { sessionStateLabel } from "@/lib/session-rail";

/** Host-owned navigation remains available even when the generated Site is broken. */
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
  const [open, setOpen] = useState(false);
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
    if (open) void load();
    return () => request.current?.abort();
  }, [open, load]);
  const sessions = page
    ? [...new Map([...page.pinned, ...page.sessions].map((s) => [s.id, s])).values()]
    : [];
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <MessageSquareIcon className="mr-2 size-4" />
          Conversations
        </Button>
      </SheetTrigger>
      <SheetContent className="flex flex-col">
        <SheetHeader>
          <SheetTitle>Conversations</SheetTitle>
          <SheetDescription>
            Created through {title}, including conversations filed in projects.
          </SheetDescription>
        </SheetHeader>
        <div className="flex gap-1 px-4" aria-label="Conversation visibility">
          <Button
            size="sm"
            variant={archivedOnly ? "ghost" : "secondary"}
            aria-pressed={!archivedOnly}
            onClick={() => setArchivedOnly(false)}
          >
            Active
          </Button>
          <Button
            size="sm"
            variant={archivedOnly ? "secondary" : "ghost"}
            aria-pressed={archivedOnly}
            onClick={() => setArchivedOnly(true)}
          >
            Archived
          </Button>
        </div>
        <div className="flex gap-2 px-4">
          <Input
            aria-label="Search Site conversations"
            placeholder="Search conversations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh conversations"
            disabled={busy}
            onClick={() => void load()}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {error ? (
            <p role="alert" className="py-4 text-sm text-fg-muted">
              Couldn’t load conversations. Try refreshing.
            </p>
          ) : null}
          {busy && !page ? (
            <p role="status" className="py-4 text-sm text-fg-muted">
              Loading conversations…
            </p>
          ) : null}
          {!busy && !error && sessions.length === 0 ? (
            <p className="py-4 text-sm text-fg-muted">
              {search ? "No matching conversations." : "No conversations yet."}
            </p>
          ) : null}
          <ul className="space-y-1">
            {sessions.map((session) => (
              <li key={session.id}>
                <a
                  href={`/workspaces/${workspaceId}/sessions/${session.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg px-3 py-3 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="min-w-0 truncate text-sm">{sessionDisplayTitle(session)}</span>
                  <span
                    className="max-w-40 shrink-0 truncate text-xs text-fg-muted"
                    title={sessionStateLabel(session)}
                  >
                    {sessionStateLabel(session)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {page?.nextCursor && (
            <Button variant="ghost" disabled={busy} onClick={() => void load(page.nextCursor!)}>
              Load older conversations
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
