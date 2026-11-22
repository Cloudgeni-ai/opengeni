import { CheckIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { authNeededPresentation } from "../auth-needed-presentation";
import { bundledServiceLogoForDomain } from "../connection-service-presentation";
import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";
import { useEntranceAnimation } from "../timeline/entrance";
import type { AuthNeededItem } from "../timeline/types";
import {
  DecisionActions,
  decisionButtonClass,
  decisionCardClass,
  decisionCardPad,
} from "./decision-card";
import { displayImageSrc } from "../lib/content-hosting";

/**
 * What a recovery the app ran from the card itself ended with. `done`: the
 * person finished it (for example allowed more access), so the card says so.
 * Returning nothing means the app navigated or opened its own setup.
 */
export type AuthNeededRecoveryResult = { outcome: "done" };

export type AuthNeededRecoveryOptions = {
  /**
   * Aborted when the person starts the card's action again, for example
   * after closing a sign-in window the app can't see is closed.
   */
  signal: AbortSignal;
};

/**
 * The app's recovery for a card: start authorization, and optionally report
 * that it finished from the card itself.
 */
export type AuthNeededRecoveryHandler = (
  item: AuthNeededItem,
  options?: AuthNeededRecoveryOptions,
) => void | AuthNeededRecoveryResult | Promise<void | AuthNeededRecoveryResult | undefined>;

/**
 * The inline connection-recovery card: missing or lapsed access surfaces as a
 * calm, tappable affordance instead of a raw provider-domain error. The `reason`
 * only shapes human copy; no domain or enum code is shown as a label.
 * `onReconnect` (from the app, which owns the SDK client) starts the flow;
 * without it, a pre-minted authorization link is offered, or the card stays
 * informative. Recovery never claims to resume/replay the failed tool call.
 * When the app finishes recovery from the card (`{ outcome: "done" }`), or
 * the chat recorded that setup from it finished, the card says it is done.
 */
type CardRun = {
  controller: AbortController | null;
  busy: boolean;
  failed: boolean;
  done: boolean;
};

const IDLE_RUN: CardRun = { controller: null, busy: false, failed: false, done: false };

/**
 * The run each card started, kept per card rather than per row: the card
 * moves between the timeline and the composer as the chat works and idles,
 * and the person's consent in the provider's window must not be cancelled,
 * or look forgotten, because of that move.
 */
const cardRuns = new Map<string, CardRun>();
const cardRunListeners = new Map<string, Set<() => void>>();

function readCardRun(cardId: string): CardRun {
  return cardRuns.get(cardId) ?? IDLE_RUN;
}

function writeCardRun(cardId: string, next: CardRun): void {
  // A run that ended with nothing to show leaves nothing behind.
  if (!next.controller && !next.busy && !next.failed && !next.done) cardRuns.delete(cardId);
  else cardRuns.set(cardId, next);
  for (const listener of cardRunListeners.get(cardId) ?? []) listener();
}

function subscribeCardRun(cardId: string, listener: () => void): () => void {
  const listeners = cardRunListeners.get(cardId) ?? new Set<() => void>();
  listeners.add(listener);
  cardRunListeners.set(cardId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) cardRunListeners.delete(cardId);
  };
}

/** Forget every card's run (tests). */
export function resetAuthNeededRuns(): void {
  for (const run of cardRuns.values()) run.controller?.abort();
  cardRuns.clear();
}

export function AuthNeededRow({
  item,
  onReconnect,
  resolveProviderLogo,
  setupUnavailable = false,
}: {
  item: AuthNeededItem;
  onReconnect?: AuthNeededRecoveryHandler | undefined;
  resolveProviderLogo?: ((providerDomain: string) => string | null | undefined) | undefined;
  /** This person cannot set the capability up from here; say so instead of offering a review. */
  setupUnavailable?: boolean | undefined;
}) {
  const t = useOpenGeniText();
  const enter = useEntranceAnimation();
  const { busy, failed, done } = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeCardRun(item.id, listener), [item.id]),
    () => readCardRun(item.id),
    () => IDLE_RUN,
  );
  // The same request was made again further down, where its card is live.
  if (item.askedAgainLater && item.capability) {
    return (
      <p className="text-xs text-fg-muted">
        {item.capability.id === "api:connected-machine"
          ? t(
              item.purpose === "chrome"
                ? "native.timeline.machineRequest.askedAgainChrome"
                : "native.timeline.machineRequest.askedAgain",
            )
          : t("native.timeline.inChatConnect.askedAgain", { name: item.capability.name })}
      </p>
    );
  }
  const recommendation = item.capability ?? null;
  const presentation = authNeededPresentation(t, item, { setupUnavailable });
  const { provider, actionLabel, title, reasonLine, unavailable } = presentation;
  const hostAuthorizationUrl = item.authoritySource === "host" ? item.authorizationUrl : null;
  const finished = done || item.setupFinished === true;

  const start = async () => {
    if (!onReconnect || finished) {
      return;
    }
    // A step-up waits for the provider's consent window, which the app may
    // be unable to see close: pressing again starts over instead of waiting.
    if (busy && !presentation.moreAccess) return;
    // Starting again aborts the run before.
    readCardRun(item.id).controller?.abort();
    const current = new AbortController();
    writeCardRun(item.id, { controller: current, busy: true, failed: false, done: false });
    try {
      // On success the app redirects to consent (or routes to credential entry),
      // so this row unmounts; a resolve without navigation just relaxes the button.
      // The callback starts authorization only. It never resumes this tool call.
      const result = await onReconnect(item, { signal: current.signal });
      if (readCardRun(item.id).controller !== current) return;
      writeCardRun(item.id, {
        controller: null,
        busy: false,
        failed: false,
        done: result?.outcome === "done",
      });
    } catch {
      // Superseded by a newer press: that run owns the card now.
      if (readCardRun(item.id).controller !== current || current.signal.aborted) return;
      writeCardRun(item.id, { controller: null, busy: false, failed: true, done: false });
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

  // The same request for more access is asked again later in this chat: only
  // that latest card is shown, so the chat never piles up copies of it.
  if (item.askedAgainLater && presentation.moreAccess) return null;

  const actionIcon = presentation.moreAccess ? (
    busy ? (
      <LoaderCircleIcon className="size-3.5 animate-og-spin" aria-hidden />
    ) : null
  ) : (
    <RefreshCwIcon className={cn("size-3.5", busy && "animate-og-spin")} aria-hidden />
  );
  const action = finished ? (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 text-og-sm font-medium text-og-fg-muted"
    >
      <CheckIcon className="size-3.5 text-og-status-idle" aria-hidden />
      {presentation.doneLabel}
    </span>
  ) : hostAuthorizationUrl ? (
    <a
      href={hostAuthorizationUrl}
      rel="noreferrer"
      target="_blank"
      className={decisionButtonClass("primary")}
    >
      {actionIcon}
      {actionLabel}
    </a>
  ) : item.authoritySource !== "host" && !unavailable && onReconnect ? (
    <button
      type="button"
      onClick={() => void start()}
      disabled={busy && !presentation.moreAccess}
      aria-busy={busy || undefined}
      className={decisionButtonClass("primary")}
    >
      {actionIcon}
      {busy ? presentation.pendingLabel : actionLabel}
    </button>
  ) : item.authoritySource !== "host" && !unavailable && item.authorizationUrl ? (
    <a
      href={item.authorizationUrl}
      rel="noreferrer"
      target="_blank"
      className={decisionButtonClass("primary")}
    >
      {actionIcon}
      {actionLabel}
    </a>
  ) : null;

  return (
    <div
      className={cn(enter && "animate-og-enter", "flex w-full max-w-[540px] flex-col gap-2")}
      role="status"
    >
      <div className={decisionCardClass}>
        <div
          className={cn(
            "flex min-w-0 items-center gap-3 pt-4 @md/decision:pt-[18px]",
            decisionCardPad,
          )}
        >
          <AuthProviderLogo
            src={
              resolveProviderLogo?.(item.providerDomain) ??
              bundledServiceLogoForDomain(item.providerDomain)
            }
            label={provider}
          />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="text-og-md font-semibold [overflow-wrap:anywhere] text-og-fg">{title}</p>
            {presentation.providerLine ? (
              <p className="truncate text-og-sm text-og-fg-muted">{presentation.providerLine}</p>
            ) : null}
          </div>
        </div>
        <p
          className={cn(
            "line-clamp-2 pt-3 text-og-base text-og-fg [overflow-wrap:anywhere]",
            decisionCardPad,
            !action && !presentation.variablesLine && "pb-4",
          )}
          title={reasonLine}
        >
          {reasonLine}
        </p>
        {presentation.variablesLine ? (
          <p
            className={cn(
              "truncate pt-1.5 text-og-sm text-og-fg-muted",
              decisionCardPad,
              !action && "pb-4",
            )}
          >
            {presentation.variablesLine}
          </p>
        ) : null}
        {action ? (
          <DecisionActions className={cn("pt-4 pb-4 @md/decision:pb-[18px]", decisionCardPad)}>
            {action}
          </DecisionActions>
        ) : null}
      </div>
      {presentation.footnote && !finished ? (
        <p className="px-1 text-og-xs text-og-fg-muted">{presentation.footnote}</p>
      ) : null}
      {failed && !finished ? (
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
      className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-og-md border border-og-border bg-og-surface-1 text-og-sm font-semibold text-og-fg-muted"
      aria-hidden
    >
      {showImage ? (
        <img
          src={displayImageSrc(src)}
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
