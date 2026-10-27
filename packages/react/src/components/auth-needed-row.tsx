import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { authNeededPresentation } from "../auth-needed-presentation";
import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";
import { useEntranceAnimation } from "../timeline/entrance";
import type { AuthNeededItem } from "../timeline/types";

const PRIMARY_ACTION_CLASS =
  "inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-og-md border border-og-primary-border bg-og-primary text-og-primary-fg px-3 py-1.5 text-og-menu font-medium sm:w-auto";

/**
 * The inline connection-recovery card: missing or lapsed access surfaces as a
 * calm, tappable affordance instead of a raw provider-domain error. The `reason`
 * only shapes human copy; no domain or enum code is shown as a label.
 * `onReconnect` (from the app, which owns the SDK client) starts the flow;
 * without it, a pre-minted authorization link is offered, or the card stays
 * informative. Recovery never claims to resume/replay the failed tool call.
 */
export function AuthNeededRow({
  item,
  onReconnect,
  resolveProviderLogo,
  setupUnavailable = false,
}: {
  item: AuthNeededItem;
  onReconnect?: ((item: AuthNeededItem) => void | Promise<void>) | undefined;
  resolveProviderLogo?: ((providerDomain: string) => string | null | undefined) | undefined;
  /** This person cannot set the capability up from here; say so instead of offering a review. */
  setupUnavailable?: boolean | undefined;
}) {
  const t = useOpenGeniText();
  const enter = useEntranceAnimation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const recommendation = item.capability ?? null;
  const presentation = authNeededPresentation(t, item, { setupUnavailable });
  const { provider, actionLabel, title, reasonLine, unavailable } = presentation;
  const hostAuthorizationUrl = item.authoritySource === "host" ? item.authorizationUrl : null;

  const start = async () => {
    if (!onReconnect || busy) {
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      // On success the app redirects to consent (or routes to credential entry),
      // so this row unmounts; a resolve without navigation just relaxes the button.
      // The callback starts authorization only. It never resumes this tool call.
      await onReconnect(item);
      setBusy(false);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  if (recommendation?.id === "api:connected-machine") {
    return (
      <div className="og-session-capability-setup" role="status">
        <p>{t("thisComputer.card.name")}</p>
        <p>{t("thisComputer.card.hostSetupUnavailable")}</p>
      </div>
    );
  }

  return (
    <div className={cn(enter && "animate-og-enter", "flex flex-col gap-2")} role="status">
      <div className="flex flex-col gap-3 rounded-og-lg border border-og-border bg-og-surface-1 px-3.5 py-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <AuthProviderLogo
            src={resolveProviderLogo?.(item.providerDomain) ?? null}
            label={provider}
          />
          <div className="min-w-0">
            <p className="truncate text-og-md font-medium text-og-fg">{title}</p>
            <p className="line-clamp-2 text-og-sm text-og-fg-subtle">{reasonLine}</p>
            {presentation.providerLine ? (
              <p className="mt-1 truncate text-og-xs text-og-fg-muted">
                {presentation.providerLine}
              </p>
            ) : null}
            {presentation.variablesLine ? (
              <p className="mt-1 truncate text-og-xs text-og-fg-muted">
                {presentation.variablesLine}
              </p>
            ) : null}
          </div>
        </div>
        {hostAuthorizationUrl ? (
          <a
            href={hostAuthorizationUrl}
            rel="noreferrer"
            target="_blank"
            className={cn(
              PRIMARY_ACTION_CLASS,
              "transition-colors hover:bg-og-primary-hover pointer-coarse:min-h-9",
            )}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
            {actionLabel}
          </a>
        ) : item.authoritySource !== "host" && !unavailable && onReconnect ? (
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy}
            className={cn(
              PRIMARY_ACTION_CLASS,
              "transition-colors hover:bg-og-primary-hover disabled:opacity-50 pointer-coarse:min-h-9",
            )}
          >
            <RefreshCwIcon className={cn("size-3.5", busy && "animate-og-spin")} aria-hidden />
            {busy ? t("messageTimeline.opening") : actionLabel}
          </button>
        ) : item.authoritySource !== "host" && !unavailable && item.authorizationUrl ? (
          <a
            href={item.authorizationUrl}
            rel="noreferrer"
            target="_blank"
            className={cn(
              PRIMARY_ACTION_CLASS,
              "transition-colors hover:bg-og-primary-hover pointer-coarse:min-h-9",
            )}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
            {actionLabel}
          </a>
        ) : null}
      </div>
      {presentation.footnote ? (
        <p className="px-1 text-og-xs text-og-fg-subtle">{presentation.footnote}</p>
      ) : null}
      {failed ? (
        <p className="px-1 text-og-xs text-og-status-failed">{presentation.startFailed}</p>
      ) : null}
    </div>
  );
}

/**
 * The provider's logo in a rounded tile, from a URL the HOST serves itself
 * (resolved via `resolveProviderLogo` → the app's catalog assets). A missing or
 * failed image falls back to a calm letter monogram — same as the rest of the
 * app — so the card never shows a broken-image glyph and never reaches off-origin
 * for a favicon (CSP + privacy).
 */
function AuthProviderLogo({ src, label }: { src: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  // A resolver that only returns the URL after a lazy catalog fetch means `src`
  // can arrive on a later render; reset the error latch so it gets its attempt.
  useEffect(() => setFailed(false), [src]);
  const showImage = src && !failed;
  return (
    <span
      className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-og-md border border-og-border bg-og-surface-2 text-og-menu font-semibold text-og-fg-muted"
      aria-hidden
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-contain p-1.5"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{monogram(label)}</span>
      )}
    </span>
  );
}

/** First one or two initials for the monogram fallback — mirrors the app's
    `capabilityMonogram` so the reconnect tile reads like every other logo tile. */
function monogram(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return "?";
  }
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
