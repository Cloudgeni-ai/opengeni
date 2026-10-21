import { Link } from "@tanstack/react-router";
import { MonitorIcon, RefreshCwIcon } from "lucide-react";
import { SessionCommandsPanel, useWorkspaceBackgroundCommands } from "@opengeni/react";
import { Button } from "@opengeni/react/ui/button";

export function commandElapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "Duration unavailable";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function WorkspaceCommands({
  workspaceId,
  canControl,
  now,
  commands,
}: {
  workspaceId: string;
  canControl: boolean;
  now: number;
  commands: ReturnType<typeof useWorkspaceBackgroundCommands>;
}) {
  const byId = new Map(commands.commands.map((command) => [command.id, command]));
  return (
    <section
      aria-labelledby="workspace-commands-title"
      className="mt-8 border-t border-border pt-6"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 id="workspace-commands-title" className="text-base font-semibold text-fg">
            Running commands
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            Across chats you can access, including archived chats.
          </p>
          {!canControl ? (
            <p className="mt-1 text-sm text-fg-muted">
              You can view commands, but do not have permission to stop them.
            </p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh running commands"
          disabled={commands.loading}
          onClick={() => void commands.refresh()}
        >
          <RefreshCwIcon
            className={
              commands.loading ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"
            }
          />
        </Button>
      </div>
      <SessionCommandsPanel
        commands={commands}
        readOnly={!canControl}
        compact={false}
        renderMetadata={(command) => {
          const item = byId.get(command.id)!;
          return (
            <div className="mb-2 min-w-0 space-y-1">
              <Link
                to="/workspaces/$workspaceId/sessions/$sessionId"
                params={{ workspaceId, sessionId: item.sessionId }}
                className="og-link block w-fit max-w-full truncate font-medium text-fg"
                title={item.sessionTitle || "Untitled chat"}
              >
                {item.sessionTitle || "Untitled chat"}
              </Link>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
                <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                  <MonitorIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate" title={item.machineName ?? undefined}>
                    {item.machineName ??
                      (item.provider === "managed"
                        ? "Managed sandbox"
                        : "Machine name unavailable")}
                  </span>
                </span>
                <time
                  dateTime={item.startedAt}
                  title={`Started ${new Date(item.startedAt).toLocaleString()}`}
                  className="shrink-0 tabular-nums"
                >
                  {commandElapsed(item.startedAt, now)} elapsed
                </time>
              </div>
            </div>
          );
        }}
      />
      {commands.hasMore ? (
        <Button
          variant="outline"
          className="mt-4"
          disabled={commands.loading}
          onClick={commands.loadMore}
        >
          Show more commands
        </Button>
      ) : null}
    </section>
  );
}

export function WorkspaceCommandsSection({
  workspaceId,
  canControl,
  now,
}: {
  workspaceId: string;
  canControl: boolean;
  now: number;
}) {
  const commands = useWorkspaceBackgroundCommands({ workspaceId });
  return (
    <WorkspaceCommands
      key={workspaceId}
      workspaceId={workspaceId}
      canControl={canControl}
      now={now}
      commands={commands}
    />
  );
}
