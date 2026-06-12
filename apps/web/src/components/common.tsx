import type { SessionEventsConnectionState } from "@opengeni/react";
import { AlertTriangleIcon, CopyIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

export function LoadingPanel({ label }: { label: string }) {
  return (
    <section className="grid flex-1 place-items-center px-4 text-center">
      <div className="max-w-sm rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-5 text-sm text-[color:var(--color-fg-muted)]">
        <Loader2Icon className="mx-auto mb-3 size-5 animate-spin text-[color:var(--color-fg)]" />
        {label}
      </div>
    </section>
  );
}

export function ProblemPanel(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <section className="grid flex-1 place-items-center px-4 text-center">
      <div className="w-full max-w-md rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-5">
        <AlertTriangleIcon className="mx-auto mb-3 size-5 text-amber-300" />
        <h1 className="text-base font-semibold">{props.title}</h1>
        <p className="mt-2 text-sm leading-5 text-[color:var(--color-fg-muted)]">{props.description}</p>
        {props.action ? <div className="mt-4 flex justify-center">{props.action}</div> : null}
      </div>
    </section>
  );
}

export function ConnectionPill({ state }: { state: SessionEventsConnectionState }) {
  const tone = {
    connecting: "bg-amber-400",
    reconnecting: "bg-amber-400",
    live: "bg-emerald-400",
    idle: "bg-zinc-500",
    ended: "bg-zinc-500",
    error: "bg-red-400",
  }[state];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/60 px-2 py-1 text-xs font-medium text-[color:var(--color-fg-muted)]">
      <span className={cn("size-2 rounded-full", tone)} />
      <span>{state}</span>
    </span>
  );
}

export function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">{title}</h3>
      <div className="min-w-0 overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3">
        {children}
      </div>
    </section>
  );
}

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  const renderedValue = typeof value === "string" || typeof value === "number"
    ? <span className="min-w-0 truncate">{value}</span>
    : value;
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-3 border-b border-[color:var(--color-border)]/70 py-1.5 last:border-b-0">
      <span className="min-w-0 truncate text-xs text-[color:var(--color-fg-subtle)]">{label}</span>
      <span className="flex min-w-0 justify-end overflow-hidden text-right text-xs text-[color:var(--color-fg-muted)]">{renderedValue}</span>
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
      className="flex w-full min-w-0 max-w-full items-center justify-end gap-1 rounded px-1 py-0.5 font-mono text-[11px] text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]"
      title={value}
    >
      <span className="min-w-0 truncate text-right">{value}</span>
      <CopyIcon className="size-3 shrink-0" />
    </button>
  );
}

/** Standard page header: icon, title, blurb, and trailing actions. */
export function PageHeader(props: { icon: ReactNode; title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-[color:var(--color-border)] pb-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-base font-semibold">
          <span className="text-[color:var(--color-brand)]">{props.icon}</span>
          {props.title}
        </div>
        <p className="mt-1 text-sm leading-5 text-[color:var(--color-fg-muted)]">{props.description}</p>
      </div>
      {props.actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{props.actions}</div> : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-4 text-sm text-[color:var(--color-fg-subtle)]">
      {children}
    </div>
  );
}

/**
 * Honest failed-load state for list surfaces. Renders the error with a retry
 * affordance instead of letting routes fall through to "No X yet…" copy when
 * the request failed.
 */
export function LoadErrorState({ title, error, onRetry }: { title: string; error?: Error | null; onRetry: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {error?.message ? <div className="mt-0.5 break-words text-xs leading-4 text-red-200/80">{error.message}</div> : null}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-red-500/40 px-2 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/20"
      >
        <RefreshCwIcon className="size-3" />
        Retry
      </button>
    </div>
  );
}
