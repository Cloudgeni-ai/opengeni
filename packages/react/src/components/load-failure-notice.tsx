import { useOpenGeniText } from "../messages/runtime";
import { cn } from "../lib/cn";

/**
 * What an error boundary shows when the code it guards failed to download
 * (see isChunkLoadError). Remounting reuses the failed import, so the only
 * thing that helps is a reload; every boundary in the chat offers it.
 * `block` fills a screen or the whole chat; `inline` replaces one item.
 */
export function LoadFailureNotice({
  variant = "inline",
  className,
}: {
  variant?: "block" | "inline";
  className?: string | undefined;
}) {
  const t = useOpenGeniText();
  const reload = (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className={
        variant === "block"
          ? "inline-flex min-h-9 items-center rounded-og-md border border-og-border bg-og-surface-1 px-3 py-1.5 text-og-sm font-medium text-og-fg hover:bg-og-surface-2"
          : "inline-flex min-h-7 shrink-0 items-center rounded-og-md px-1.5 font-medium text-og-fg underline-offset-2 hover:underline pointer-coarse:min-h-11"
      }
    >
      {t("loadFailure.reload")}
    </button>
  );
  if (variant === "block") {
    return (
      <div
        role="alert"
        data-og-load-failure="block"
        className={cn(
          "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center",
          className,
        )}
      >
        <p className="max-w-sm text-og-base text-og-fg-muted">{t("loadFailure.didNotLoad")}</p>
        {reload}
      </div>
    );
  }
  return (
    <div
      role="status"
      data-og-load-failure="inline"
      className={cn(
        "flex flex-wrap items-center gap-x-1 px-1.5 py-1 text-og-menu text-og-fg-muted",
        className,
      )}
    >
      <span>{t("loadFailure.partDidNotLoad")}</span>
      {reload}
    </div>
  );
}
