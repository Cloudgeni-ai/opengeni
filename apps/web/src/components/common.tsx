import type { SessionEventsConnectionState } from "@opengeni/react";
import { AlertTriangleIcon, CopyIcon, InfoIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import {
  apiErrorTechnicalFacts,
  isPermissionDenied,
  userErrorTextWithoutReference,
} from "@/lib/api-error";
import { cn } from "@/lib/utils";

const RECONNECT_PILL_REVEAL_DELAY_MS = 1_500;

// Startup code: the disclosure lives with the management UI primitives, so it
// loads only once a load error actually has details to show.
const TechnicalDetails = lazy(() =>
  import("@/components/ui/error-message").then((module) => ({
    default: module.TechnicalDetails,
  })),
);

type ConnectionPillMeta = { label: string; dot: string; text: string };

const degradedConnectionStates: Partial<Record<SessionEventsConnectionState, ConnectionPillMeta>> =
  {
    connecting: { label: "Connecting…", dot: "bg-status-running", text: "text-status-running" },
    reconnecting: { label: "Reconnecting…", dot: "bg-status-running", text: "text-status-running" },
    error: { label: "Stream error", dot: "bg-status-failed", text: "text-status-failed" },
  };

/** One quiet presentation across bootstrap, access, route and history gates.
 * Named operation panels retain their existing treatment. Gates still own
 * when content is authorized; this component never retains data.
 */
export function LoadingPanel({ label }: { label?: string }) {
  if (label) {
    return (
      <section className="grid flex-1 place-items-center px-4 text-center">
        <div className="max-w-sm rounded-lg border border-border bg-surface p-5 text-sm text-fg-muted">
          <Loader2Icon className="mx-auto mb-3 size-5 animate-spin text-fg" />
          {label}
        </div>
      </section>
    );
  }
  const indicator = (
    <span
      role="status"
      aria-label="Loading"
      className="pointer-events-none fixed left-1/2 top-1/2 inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 text-sm text-fg-muted"
      data-page-loading=""
    >
      <Loader2Icon
        aria-hidden
        ref={(node) =>
          node?.getAnimations?.().forEach((animation) => {
            // Bootstrap/route boundaries remount this indicator. Share the
            // document timeline so its rotation does not restart at each one.
            animation.startTime = 0;
          })
        }
        className="size-4 animate-spin motion-reduce:animate-none"
      />
      Loading…
    </span>
  );
  return (
    <section aria-busy="true" className="min-h-0 flex-1">
      {typeof document === "undefined" ? indicator : createPortal(indicator, document.body)}
    </section>
  );
}

export function ProblemPanel(props: { title: string; description: ReactNode; action?: ReactNode }) {
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
 * surfaces only while the stream is degraded, in sentence case. Routine HTTP/1
 * stream cycling never mounts the reconnect pill, so its hidden content cannot
 * shift the surrounding header controls.
 */
export function ConnectionPill({ state }: { state: SessionEventsConnectionState }) {
  const meta = degradedConnectionStates[state];
  if (!meta) {
    return null;
  }
  if (state === "reconnecting") {
    return <DelayedReconnectPill meta={meta} />;
  }
  return <ConnectionPillContent meta={meta} />;
}

function DelayedReconnectPill({ meta }: { meta: ConnectionPillMeta }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), RECONNECT_PILL_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return visible ? <ConnectionPillContent meta={meta} /> : null;
}

function ConnectionPillContent({ meta }: { meta: ConnectionPillMeta }) {
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
      <h3 className="text-xs font-medium uppercase tracking-wider text-fg">{title}</h3>
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
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success("Copied");
        } catch {
          toast.error("Couldn't copy. Select the text and copy it manually.");
        }
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
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-center lg:justify-between",
        props.className,
      )}
    >
      <div className="min-w-0 lg:flex-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <span className="text-brand">{props.icon}</span>
          {props.title}
        </h1>
        {props.description ? (
          <p className="mt-1 text-sm leading-5 text-fg-muted">{props.description}</p>
        ) : null}
      </div>
      {props.actions ? (
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">{props.actions}</div>
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
 * the request failed. Says what to do in product words; the raw status and
 * request reference stay behind Technical details. A permission refusal is
 * not a failure: it reads calmly, names who can help, and offers no retry.
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
  const denied = error ? isPermissionDenied(error) : false;
  const facts = error ? apiErrorTechnicalFacts(error) : [];
  return (
    <div
      role={denied ? undefined : "alert"}
      aria-live={denied ? undefined : "assertive"}
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-sm text-fg",
        denied ? "border-border bg-surface/40" : "border-status-failed/40 bg-status-failed/10",
      )}
    >
      {denied ? (
        <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
      ) : (
        <AlertTriangleIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-status-failed"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {error ? (
          <div className="mt-0.5 break-words text-xs leading-4.5 text-fg-muted">
            {denied
              ? "You don't have access to this. Ask an admin for access."
              : userErrorTextWithoutReference(error)}
          </div>
        ) : null}
        {!denied && facts.length > 0 ? (
          <Suspense fallback={null}>
            <div className="mt-1">
              <TechnicalDetails facts={facts} />
            </div>
          </Suspense>
        ) : null}
      </div>
      {denied ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-status-failed/50 px-2 text-xs font-medium text-fg transition-colors hover:bg-status-failed/20"
        >
          <RefreshCwIcon className="size-3" />
          Retry
        </button>
      )}
    </div>
  );
}
