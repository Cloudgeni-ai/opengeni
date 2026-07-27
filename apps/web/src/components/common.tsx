import type { SessionEventsConnectionState } from "@opengeni/react";
import { AlertTriangleIcon, CopyIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

export function LoadingPanel({ label }: { label: string }) {
  return (
    <section className="grid flex-1 place-items-center px-4 text-center">
      <div className="max-w-sm rounded-lg border border-border bg-surface p-5 text-sm text-fg-muted">
        <Loader2Icon className="mx-auto mb-3 size-5 animate-spin text-fg" />
        {label}
      </div>
    </section>
  );
}

export function ProblemPanel(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <section className="grid flex-1 place-items-center px-4 text-center">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-5">
        <AlertTriangleIcon className="mx-auto mb-3 size-5 text-status-waiting" />
        <h1 className="text-base font-semibold">{props.title}</h1>
        <p className="mt-2 text-sm leading-5 text-fg-muted">{props.description}</p>
        {props.action ? <div className="mt-4 flex justify-center">{props.action}</div> : null}
      </div>
    </section>
  );
}

/**
 * Connection health, shown only when it needs a word (doctrine D2). Healthy
 * states (live / idle / ended) render nothing — the session status badge is the
 * single persistent pill, so there is no "live" + "Idle" double-green. The pill
 * surfaces only while the stream is degraded, in sentence case.
 */
export function ConnectionPill({ state }: { state: SessionEventsConnectionState }) {
  const degraded: Partial<
    Record<SessionEventsConnectionState, { label: string; dot: string; text: string }>
  > = {
    connecting: { label: "Connecting…", dot: "bg-status-running", text: "text-status-running" },
    reconnecting: { label: "Reconnecting…", dot: "bg-status-running", text: "text-status-running" },
    error: { label: "Stream error", dot: "bg-status-failed", text: "text-status-failed" },
  };
  const meta = degraded[state];
  if (!meta) {
    return null;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2/60 px-2 py-1 text-xs font-medium",
        meta.text,
      )}
    >
      <span className={cn("size-2 rounded-full motion-safe:animate-pulse", meta.dot)} />
      <span>{meta.label}</span>
    </span>
  );
}

export function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">{title}</h3>
      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface/45 p-3">
        {children}
      </div>
    </section>
  );
}

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  const renderedValue =
    typeof value === "string" || typeof value === "number" ? (
      <span className="min-w-0 truncate">{value}</span>
    ) : (
      value
    );
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-3 border-b border-border/70 py-1.5 last:border-b-0">
      <span className="min-w-0 truncate text-xs text-fg-subtle">{label}</span>
      <span className="flex min-w-0 justify-end overflow-hidden text-right text-xs text-fg-muted">
        {renderedValue}
      </span>
    </div>
  );
}

export function CopyableMono({ value }: { value: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        toast.success("Copied");
      }}
      className="flex w-full min-w-0 max-w-full items-center justify-end gap-1 rounded px-1 py-0.5 font-mono text-2xs text-fg-muted hover:bg-surface-2 hover:text-fg"
      title={value}
    >
      <span className="min-w-0 truncate text-right">{value}</span>
      <CopyIcon className="size-3 shrink-0" />
    </button>
  );
}

/** Standard page header: icon, title, blurb, and trailing actions. */
export function PageHeader(props: {
  icon: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <span className="text-brand">{props.icon}</span>
          {props.title}
        </h1>
        <p className="mt-1 text-sm leading-5 text-fg-muted">{props.description}</p>
      </div>
      {props.actions ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">{props.actions}</div>
      ) : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-4 text-sm text-fg-subtle">
      {children}
    </div>
  );
}

/**
 * Honest failed-load state for list surfaces. Renders the error with a retry
 * affordance instead of letting routes fall through to "No X yet…" copy when
 * the request failed.
 */
export function LoadErrorState({
  title,
  error,
  onRetry,
}: {
  title: string;
  error?: Error | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-status-failed/40 bg-status-failed/10 p-3 text-sm text-status-failed">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {error?.message ? (
          <div className="mt-0.5 break-words text-xs leading-4 text-status-failed/80">
            {error.message}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-status-failed/40 px-2 text-xs font-medium text-status-failed transition-colors hover:bg-status-failed/20"
      >
        <RefreshCwIcon className="size-3" />
        Retry
      </button>
    </div>
  );
}
