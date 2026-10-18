import { ChevronRightIcon, Loader2Icon, SquareIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { SessionBackgroundCommand } from "@opengeni/sdk";
import type { UseSessionBackgroundCommandsResult } from "../hooks/use-session-background-commands";
import { formatClockTime } from "../lib/format";
import { useErrorMessage } from "../lib/error-message";
import { useOpenGeniText } from "../messages/runtime";

/** The current session's live commands. Settled commands belong to the timeline. */
export function SessionCommandsPanel({
  commands: state,
  readOnly = false,
  renderMetadata,
  compact = true,
}: {
  commands: UseSessionBackgroundCommandsResult;
  readOnly?: boolean;
  renderMetadata?: (command: SessionBackgroundCommand) => ReactNode;
  compact?: boolean;
}) {
  const t = useOpenGeniText();
  const formatError = useErrorMessage();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = state.commands.filter(
    (command) => command.state === "running" || command.state === "stopping",
  );
  const stop = async (id: string) => {
    setPending(id);
    setError(null);
    try {
      await state.cancel(id);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setPending(null);
    }
  };
  return (
    <div
      className={`space-y-2 ${compact ? "text-og-xs" : "text-og-sm"}`}
      data-og-session-commands=""
    >
      {state.loading && active.length === 0 ? (
        <p role="status" className="text-og-fg-muted">
          {t("sessionCommandsPanel.loadingCommands")}
        </p>
      ) : null}
      {state.error ? (
        <div role="alert" className="flex items-center justify-between gap-2 text-og-danger">
          <span>{t("sessionCommandsPanel.commandsUnavailable")}</span>
          <button
            type="button"
            className="underline outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
            onClick={() => void state.refresh()}
          >
            {t("sessionCommandsPanel.retry")}
          </button>
        </div>
      ) : null}
      {!state.loading && !state.error && active.length === 0 ? (
        <p role="status" className="text-og-fg-muted">
          {t("sessionCommandsPanel.noBackgroundCommandsRunning")}
        </p>
      ) : null}
      {active.length > 0 ? (
        <ul
          className={`${compact ? "max-h-64 overflow-y-auto overscroll-contain" : ""} divide-y divide-og-border/40`}
        >
          {active.map((command) => (
            <li key={command.id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                {renderMetadata?.(command)}
                <details className="group/command">
                  <summary
                    className="flex cursor-pointer list-none items-center gap-1.5 rounded-og-sm font-mono text-og-fg outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
                    title={t("sessionCommandsPanel.expandCommand")}
                  >
                    <ChevronRightIcon className="size-3 shrink-0 text-og-fg-subtle transition-transform group-open/command:rotate-90" />
                    <span
                      className="min-w-0 truncate"
                      title={
                        command.commandText ??
                        (command.commandPreview || t("sessionCommandsPanel.backgroundCommand"))
                      }
                    >
                      {command.commandText ??
                        (command.commandPreview || t("sessionCommandsPanel.backgroundCommand"))}
                    </span>
                  </summary>
                  <div className="mt-2 space-y-1">
                    <p className="whitespace-pre-wrap break-all font-mono text-og-fg-muted">
                      {command.commandText ??
                        (command.commandPreview || t("sessionCommandsPanel.backgroundCommand"))}
                    </p>
                    <time
                      className="block text-og-fg-subtle"
                      dateTime={command.startedAt}
                      title={new Date(command.startedAt).toLocaleString(t.locale)}
                    >
                      {t("sessionCommandsPanel.startedClocktime", {
                        clockTime: formatClockTime(t, command.startedAt),
                      })}
                    </time>
                  </div>
                </details>
                <p className="mt-1 text-og-fg-subtle">
                  {command.observationStatus === "unavailable"
                    ? command.state === "stopping"
                      ? t("sessionCommandsPanel.stopRequestedStatusUnavailable")
                      : t("sessionCommandsPanel.commandStatusUnavailable")
                    : command.state === "stopping"
                      ? t("sessionCommandsPanel.stopping")
                      : t("sessionCommandsPanel.running")}
                </p>
              </div>
              {!readOnly ? (
                <button
                  type="button"
                  aria-label={t("sessionCommandsPanel.stopCommandpreview", {
                    commandPreview:
                      command.commandPreview || t("sessionCommandsPanel.backgroundCommand2"),
                  })}
                  disabled={pending !== null || command.state === "stopping"}
                  onClick={() => void stop(command.id)}
                  className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-og-sm px-2 text-og-fg-muted outline-hidden hover:bg-og-surface-3/70 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:opacity-50 pointer-coarse:min-h-11"
                >
                  {pending === command.id || command.state === "stopping" ? (
                    <Loader2Icon className="size-3 animate-og-spin motion-reduce:animate-none" />
                  ) : (
                    <SquareIcon className="size-3" />
                  )}
                  {t("sessionCommandsPanel.stop")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-og-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
