import { ChevronRightIcon, Loader2Icon, SquareIcon } from "lucide-react";
import { useState } from "react";
import type { UseSessionBackgroundCommandsResult } from "../hooks/use-session-background-commands";
import { formatClockTime } from "../lib/format";

/** The current session's live commands. Settled commands belong to the timeline. */
export function SessionCommandsPanel({
  commands: state,
  readOnly = false,
}: {
  commands: UseSessionBackgroundCommandsResult;
  readOnly?: boolean;
}) {
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
      setError(cause instanceof Error ? cause.message : "Stop was not confirmed. Try again.");
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="space-y-2 text-og-xs" data-og-session-commands="">
      {state.loading && active.length === 0 ? (
        <p role="status" className="text-og-fg-muted">
          Loading commands…
        </p>
      ) : null}
      {state.error ? (
        <div role="alert" className="flex items-center justify-between gap-2 text-og-danger">
          <span>Commands unavailable.</span>
          <button
            type="button"
            className="underline outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
            onClick={() => void state.refresh()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {!state.loading && !state.error && active.length === 0 ? (
        <p role="status" className="text-og-fg-muted">
          No background commands running.
        </p>
      ) : null}
      {active.length > 0 ? (
        <ul className="max-h-64 overflow-y-auto overscroll-contain divide-y divide-og-border/40">
          {active.map((command) => (
            <li key={command.id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <details className="group/command">
                  <summary
                    className="flex cursor-pointer list-none items-center gap-1.5 rounded-og-sm font-mono text-og-fg outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
                    title="Expand command"
                  >
                    <ChevronRightIcon className="size-3 shrink-0 text-og-fg-subtle transition-transform group-open/command:rotate-90" />
                    <span className="truncate">
                      {command.commandPreview || "Background command"}
                    </span>
                  </summary>
                  <div className="mt-2 space-y-1">
                    <p className="whitespace-pre-wrap break-all font-mono text-og-fg-muted">
                      {command.commandPreview || "Background command"}
                    </p>
                    <time
                      className="block text-og-fg-subtle"
                      dateTime={command.startedAt}
                      title={new Date(command.startedAt).toLocaleString()}
                    >
                      Started {formatClockTime(command.startedAt)}
                    </time>
                  </div>
                </details>
                <p className="mt-1 text-og-fg-subtle">
                  {command.state === "stopping" ? "Stopping…" : "Running"}
                </p>
              </div>
              {!readOnly ? (
                <button
                  type="button"
                  aria-label={`Stop ${command.commandPreview || "background command"}`}
                  disabled={pending !== null || command.state === "stopping"}
                  onClick={() => void stop(command.id)}
                  className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-og-sm px-2 text-og-fg-muted outline-hidden hover:bg-og-surface-3/70 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:opacity-50 pointer-coarse:min-h-11"
                >
                  {pending === command.id || command.state === "stopping" ? (
                    <Loader2Icon className="size-3 animate-og-spin motion-reduce:animate-none" />
                  ) : (
                    <SquareIcon className="size-3" />
                  )}
                  Stop
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
