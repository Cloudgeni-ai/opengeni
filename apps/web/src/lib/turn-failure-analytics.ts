// Consent-gated product journey around a failed turn (PostHog through
// `captureAnalyticsEvent`). When the failed-turn banner is shown the page
// reports `turn_failure_viewed{failure_class}`, then the person's first next
// step as `turn_failure_action{failure_class, action}`. Only closed values
// leave the browser: the class is derived from the recorded failure code and
// the presentation classifier, never from failure text.
//
// `left` is best effort: the banner went away without an action (navigation
// to another page or session), the page was closed, or the tab stayed hidden
// for five minutes after the failure was shown.
import { captureAnalyticsEvent } from "./analytics-observer";
import type { SessionFailureSummary } from "./events";
import { classifyProviderFailure, failedSessionCopy } from "./failed-session-copy";
import { setTurnFailureStepSink } from "./turn-failure-actions";

export { noteTurnFailureAction } from "./turn-failure-actions";

export const TURN_FAILURE_CLASSES = [
  "credits_exhausted",
  "provider_credentials",
  "provider_billing",
  "provider_access",
  "daily_limit",
  "monthly_limit",
  "provider_quota",
  "rate_limited",
  "provider_error",
  "model_unavailable",
  "codex_account",
  "safety_refusal",
  "sandbox",
  "mcp",
  "context_limit",
  "connectivity",
  "pre_start",
  "other",
] as const;
export type TurnFailureClass = (typeof TURN_FAILURE_CLASSES)[number];

export const TURN_FAILURE_ACTIONS = [
  "retry",
  "switch_model",
  "buy_credits",
  "connect_model",
  "new_session",
  "send_message",
  "left",
] as const;
export type TurnFailureAction = (typeof TURN_FAILURE_ACTIONS)[number];

/** Hidden this long after the failure was shown, with no action, counts as `left`. */
export const TURN_FAILURE_HIDDEN_LEFT_MS = 5 * 60_000;

/** The closed class of a failure, from its recorded code and closed markers only. */
export function turnFailureClass(
  failure: SessionFailureSummary,
  creditExhausted = false,
): TurnFailureClass {
  if (failure.structuralSandboxFailure) return "sandbox";
  if (creditExhausted) return "credits_exhausted";
  if (failure.safetyRefusal) return "safety_refusal";
  const code = failure.failureCode ?? "";
  if (code.startsWith("codex_")) return "codex_account";
  if (failedSessionCopy(failure).unavailableModel) return "model_unavailable";
  const known = classifyProviderFailure(
    failure.recordedDetail ?? failure.reason ?? "",
    failure.failureCode,
    failure.quotaScope,
  );
  if (known) return known.kind;
  if (code.startsWith("sandbox_")) return "sandbox";
  if (code.startsWith("mcp_")) return "mcp";
  if (code.startsWith("context_") || code.includes("compaction")) return "context_limit";
  if (code === "upstream_connectivity_unavailable") return "connectivity";
  if (code === "pre_claim_failure") return "pre_start";
  return "other";
}

type Capture = (
  name: "turn_failure_viewed" | "turn_failure_action",
  properties: Record<string, string>,
) => void;

export type TurnFailureJourneyOptions = {
  capture?: Capture;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  hiddenLeftMs?: number;
};

export type TurnFailureJourney = {
  /** The banner for this exact failure is visible. Reported once per failure. */
  viewed(failureKey: string, failureClass: TurnFailureClass): void;
  /** The person's first next step for the visible failure; later steps are ignored. */
  action(action: Exclude<TurnFailureAction, "left">, failureKey?: string): void;
  /** The banner for this failure went away. Reports `left` when no action came first. */
  dismissed(failureKey: string): void;
  /** Document visibility changed; a long hidden period counts as leaving. */
  visibilityChanged(hidden: boolean): void;
  /** The page is being unloaded. */
  pageHidden(): void;
  /** Currently tracked failure, for tests. */
  activeKey(): string | null;
};

export function createTurnFailureJourney(
  options: TurnFailureJourneyOptions = {},
): TurnFailureJourney {
  const capture: Capture =
    options.capture ?? ((name, properties) => void captureAnalyticsEvent(name, properties));
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const hiddenLeftMs = options.hiddenLeftMs ?? TURN_FAILURE_HIDDEN_LEFT_MS;
  // Bounded memory of failures already reported as viewed in this document.
  const seen: string[] = [];
  let active: { key: string; failureClass: TurnFailureClass } | null = null;
  let hiddenTimer: unknown = null;
  // A dismissal waits one task so an immediate remount of the same banner
  // (React StrictMode, a Suspense retry) is not mistaken for leaving.
  const pendingDismissals = new Map<string, unknown>();

  const send: Capture = (name, properties) => {
    try {
      capture(name, properties);
    } catch {
      // Optional telemetry cannot fail product work.
    }
  };
  const stopHiddenTimer = () => {
    if (hiddenTimer !== null) clearTimer(hiddenTimer);
    hiddenTimer = null;
  };
  const finish = (action: TurnFailureAction) => {
    if (!active) return;
    const { failureClass } = active;
    active = null;
    stopHiddenTimer();
    send("turn_failure_action", { failure_class: failureClass, action });
  };

  return {
    viewed(failureKey, failureClass) {
      const pending = pendingDismissals.get(failureKey);
      if (pending !== undefined) {
        clearTimer(pending);
        pendingDismissals.delete(failureKey);
      }
      if (active?.key === failureKey) return;
      if (seen.includes(failureKey)) return;
      seen.push(failureKey);
      if (seen.length > 50) seen.shift();
      if (active) finish("left");
      active = { key: failureKey, failureClass };
      send("turn_failure_viewed", { failure_class: failureClass });
    },
    action(action, failureKey) {
      if (!active || (failureKey !== undefined && failureKey !== active.key)) return;
      finish(action);
    },
    dismissed(failureKey) {
      if (active?.key !== failureKey || pendingDismissals.has(failureKey)) return;
      pendingDismissals.set(
        failureKey,
        setTimer(() => {
          pendingDismissals.delete(failureKey);
          if (active?.key === failureKey) finish("left");
        }, 0),
      );
    },
    visibilityChanged(hidden) {
      stopHiddenTimer();
      if (!hidden || !active) return;
      hiddenTimer = setTimer(() => {
        hiddenTimer = null;
        finish("left");
      }, hiddenLeftMs);
    },
    pageHidden() {
      finish("left");
    },
    activeKey() {
      return active?.key ?? null;
    },
  };
}

let journey: TurnFailureJourney | null = null;
let listenersInstalled = false;

/** The page-wide journey, created on first use in a browser. */
export function turnFailureJourney(): TurnFailureJourney {
  if (!journey) {
    journey = createTurnFailureJourney();
    setTurnFailureStepSink((step) => journey?.action(step));
  }
  if (!listenersInstalled && typeof document !== "undefined") {
    listenersInstalled = true;
    document.addEventListener("visibilitychange", () =>
      journey?.visibilityChanged(document.visibilityState === "hidden"),
    );
    window.addEventListener("pagehide", () => journey?.pageHidden());
    // Labelled New session controls are a recovery path from the banner.
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[data-analytics-action="new_session"]')) {
          journey?.action("new_session");
        }
      },
      { capture: true },
    );
  }
  return journey;
}
