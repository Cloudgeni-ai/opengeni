import { deriveSessionDisplayTitle, type OpenGeniClient, type Session } from "@opengeni/sdk";
import { ArchiveIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useWorkspaceSessions } from "../hooks/use-workspace-sessions";
import { cn } from "../lib/cn";
import { formatRelativeTime } from "../lib/format";
import { useOpenGeni, type ClientOverride } from "../session-context";

export type SessionListLabels = {
  heading: string;
  newChat: string;
  empty: string;
  loading: string;
  loadMore: string;
  rename: string;
  archive: string;
  save: string;
  cancel: string;
};

const DEFAULT_LABELS: SessionListLabels = {
  heading: "Chats",
  newChat: "New chat",
  empty: "No chats yet",
  loading: "Loading chats…",
  loadMore: "Show more",
  rename: "Rename",
  archive: "Archive",
  save: "Save",
  cancel: "Cancel",
};

export type SessionListProps = ClientOverride & {
  selectedSessionId?: string | null | undefined;
  onSelect: (sessionId: string) => void;
  /** Shown as a "New chat" button when provided. */
  onNewChat?: (() => void) | undefined;
  /** Allow inline rename (`updateSession`). Defaults to true. */
  rename?: boolean | undefined;
  /** Allow archiving (`updateSessionArchive`). Defaults to true. */
  archive?: boolean | undefined;
  /** Called after the selected chat was archived, so the host can move on. */
  onArchived?: ((sessionId: string) => void) | undefined;
  pageSize?: number | undefined;
  /** Change the reference to force a refetch (for example after creating a chat). */
  refreshKey?: unknown;
  labels?: Partial<SessionListLabels> | undefined;
  className?: string | undefined;
};

type ArchiveClient = Partial<Pick<OpenGeniClient, "updateSessionArchive">>;

/**
 * The workspace's root chats for the current user, newest activity first.
 * Through `createSessionProxyHandler` the list is limited to the chats the
 * resolved user created (or everything they may read, with `sessionList:
 * "visible"`); OpenGeni enforces visibility either way.
 */
export function SessionList({
  client,
  workspaceId,
  selectedSessionId,
  onSelect,
  onNewChat,
  rename = true,
  archive = true,
  onArchived,
  pageSize = 30,
  refreshKey,
  labels: labelOverrides,
  className,
}: SessionListProps) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const scope = { client, workspaceId };
  const context = useOpenGeni(scope);
  const [limit, setLimit] = useState(pageSize);
  const list = useWorkspaceSessions({
    ...scope,
    parentSessionId: null,
    archiveStatus: "active",
    sortBy: "updatedAt",
    limit,
  });
  const refresh = list.refresh;
  const firstRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (Object.is(refreshKey, firstRefreshKey.current)) return;
    firstRefreshKey.current = refreshKey;
    void refresh();
  }, [refresh, refreshKey]);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const archiveClient = context.client as unknown as ArchiveClient;
  const canArchive = archive && typeof archiveClient.updateSessionArchive === "function";

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await action();
      await list.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveTitle = (event: FormEvent) => {
    event.preventDefault();
    const current = editing;
    if (!current) return;
    const title = current.title.trim();
    setEditing(null);
    if (!title) return;
    void run(current.id, () =>
      context.client.updateSession(context.workspaceId, current.id, { title }),
    );
  };

  const archiveSession = (session: Session) =>
    void run(session.id, async () => {
      await archiveClient.updateSessionArchive!(context.workspaceId, session.id, {
        archived: true,
      });
      onArchived?.(session.id);
    });

  const sessions = list.sessions;
  return (
    <nav
      className={cn("flex min-h-0 min-w-0 flex-col gap-1 text-og-fg", className)}
      aria-label={labels.heading}
      data-og-session-list=""
    >
      <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-2">
        <h2 className="text-og-sm font-semibold text-og-fg-muted">{labels.heading}</h2>
        {onNewChat ? (
          <button
            type="button"
            onClick={onNewChat}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-og-control text-og-fg hover:bg-og-surface-2"
            data-og-new-chat=""
          >
            <PlusIcon className="size-3.5" aria-hidden />
            {labels.newChat}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="px-2 text-og-xs text-og-status-failed">
          {error}
        </p>
      ) : null}
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-2">
        {list.loading && sessions.length === 0 ? (
          <li className="px-2 py-2 text-og-xs text-og-fg-subtle">{labels.loading}</li>
        ) : null}
        {!list.loading && sessions.length === 0 ? (
          <li className="px-2 py-2 text-og-xs text-og-fg-subtle">{labels.empty}</li>
        ) : null}
        {sessions.map((session) => {
          const selected = session.id === selectedSessionId;
          const title = deriveSessionDisplayTitle(session);
          if (editing?.id === session.id) {
            return (
              <li key={session.id}>
                <form onSubmit={saveTitle} className="flex items-center gap-1 px-1 py-1">
                  <input
                    aria-label={labels.rename}
                    value={editing.title}
                    maxLength={200}
                    autoFocus
                    onChange={(event) => setEditing({ id: session.id, title: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditing(null);
                    }}
                    className="min-w-0 flex-1 rounded-md border border-og-border bg-og-bg px-2 py-1 text-og-sm text-og-fg"
                  />
                  <button
                    type="submit"
                    className="rounded-md px-2 py-1 text-og-xs text-og-fg hover:bg-og-surface-2"
                  >
                    {labels.save}
                  </button>
                </form>
              </li>
            );
          }
          return (
            <li key={session.id} className="group relative">
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                aria-current={selected ? "true" : undefined}
                disabled={busy === session.id}
                className={cn(
                  "flex w-full min-w-0 flex-col items-start rounded-md px-2 py-1.5 text-left",
                  selected ? "bg-og-surface-2" : "hover:bg-og-surface-1",
                )}
                data-og-session-row=""
              >
                <span className="w-full truncate pr-12 text-og-sm text-og-fg">{title}</span>
                <span className="text-og-xs text-og-fg-subtle">
                  {formatRelativeTime(session.updatedAt)}
                </span>
              </button>
              <span className="absolute right-1 top-1.5 hidden gap-0.5 group-focus-within:flex group-hover:flex">
                {rename ? (
                  <button
                    type="button"
                    aria-label={`${labels.rename}: ${title}`}
                    onClick={() => setEditing({ id: session.id, title: session.title ?? title })}
                    className="rounded p-1 text-og-fg-subtle hover:bg-og-surface-3 hover:text-og-fg"
                  >
                    <PencilIcon className="size-3.5" aria-hidden />
                  </button>
                ) : null}
                {canArchive ? (
                  <button
                    type="button"
                    aria-label={`${labels.archive}: ${title}`}
                    onClick={() => archiveSession(session)}
                    className="rounded p-1 text-og-fg-subtle hover:bg-og-surface-3 hover:text-og-fg"
                  >
                    <ArchiveIcon className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
        {list.nextCursor ? (
          <li>
            <button
              type="button"
              onClick={() => setLimit((current) => current + pageSize)}
              className="w-full rounded-md px-2 py-1.5 text-left text-og-xs text-og-fg-muted hover:bg-og-surface-1"
            >
              {labels.loadMore}
            </button>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
