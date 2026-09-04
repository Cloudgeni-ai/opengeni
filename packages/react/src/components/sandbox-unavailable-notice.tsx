import { TriangleAlertIcon } from "lucide-react";

export const SANDBOX_UNAVAILABLE_TITLE = "Sandbox unavailable";
export const SANDBOX_UNAVAILABLE_FALLBACK = "Couldn't reach the sandbox for this session.";

export function SandboxUnavailableNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-2.5" data-opengeni-sandbox-unavailable>
      <span className="grid size-10 place-items-center rounded-og-lg border border-og-border bg-og-surface-1 text-og-fg-muted shadow-sm">
        <TriangleAlertIcon className="size-5" aria-hidden />
      </span>
      <p className="font-medium text-og-fg">{SANDBOX_UNAVAILABLE_TITLE}</p>
      <p data-contrast-audited className="text-og-sm leading-5 text-og-fg-muted">
        {message}
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex min-h-11 items-center justify-center rounded-og-md bg-og-accent-deep px-3 py-2 text-og-sm font-medium text-og-accent-fg shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent focus-visible:ring-offset-2 focus-visible:ring-offset-og-bg"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
