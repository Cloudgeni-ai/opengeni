import { useEffect, useState } from "react";

import {
  OPEN_ANALYTICS_PREFERENCES_EVENT,
  analyticsPreferencesAvailable,
  persistAnalyticsConsent,
  reportAnalyticsConsentDecision,
  storedAnalyticsConsent,
  takePendingAnalyticsPreferencesOpen,
  type AnalyticsConsent,
} from "@/lib/analytics-consent";
import type { ClientConfig } from "@/types";
import { journeyAction, journeyPage } from "@/lib/analytics-journey";

/**
 * Project a trusted click to its content-free event: the destination page of a
 * same-origin link, or the kind of other control. A closed
 * `data-analytics-action` label on the control itself is attached to either.
 * Visible text, input values, and URLs are never read.
 */
export function analyticsClickEvent(
  target: EventTarget | null,
  origin: string,
): {
  name: "navigation_clicked" | "product_clicked";
  properties: Record<string, string>;
} | null {
  const element = target instanceof Element ? target : null;
  const control = element?.closest("button,a,[role=button],[role=tab],[role=menuitem]");
  if (!control) return null;
  const action = journeyAction(control.getAttribute("data-analytics-action"));
  if (control instanceof HTMLAnchorElement && control.origin === origin) {
    const destination = journeyPage(control.pathname, control.search);
    return {
      name: "navigation_clicked",
      properties: {
        destination_page: String(destination.page),
        ...(destination.section ? { destination_section: String(destination.section) } : {}),
        ...(action ? { action } : {}),
      },
    };
  }
  return {
    name: "product_clicked",
    properties: {
      ...(action ? { action } : {}),
      control_kind:
        control.tagName === "BUTTON" ? "button" : (control.getAttribute("role") ?? "link"),
    },
  };
}

const BUTTON_CLASS =
  "inline-flex h-9 pointer-coarse:h-11 cursor-pointer items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export function AnalyticsManager({
  config,
  hasSearchParameters,
  isPublicAuthRoute,
  pathname,
  search = "",
  analyticsAccountId,
  analyticsAccountResolved,
  analyticsUserId,
}: {
  config: ClientConfig["analytics"];
  hasSearchParameters: boolean;
  isPublicAuthRoute: boolean;
  pathname: string;
  search?: string;
  analyticsAccountId: string | null;
  /** False while the signed-in user's account is still loading. */
  analyticsAccountResolved: boolean;
  analyticsUserId: string | null;
}) {
  const [choice, setChoice] = useState<AnalyticsConsent | null>(() => storedAnalyticsConsent());
  const [editing, setEditing] = useState(choice === null);

  useEffect(() => {
    let cancelled = false;
    void import("@/lib/analytics").then(
      ({ suspendAnalytics, syncAnalytics, syncAnalyticsIdentity }) => {
        if (cancelled) return;
        syncAnalyticsIdentity(
          analyticsUserId
            ? {
                userId: analyticsUserId,
                accountId: analyticsAccountId,
                accountResolved: analyticsAccountResolved,
              }
            : null,
        );
        if (isPublicAuthRoute) {
          suspendAnalytics();
          return;
        }
        syncAnalytics(config, pathname, search || (hasSearchParameters ? "?" : ""));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    config,
    hasSearchParameters,
    isPublicAuthRoute,
    pathname,
    search,
    analyticsUserId,
    analyticsAccountId,
    analyticsAccountResolved,
  ]);

  useEffect(() => {
    if (isPublicAuthRoute) return;
    let cancelled = false;
    let dispose = () => {};
    void import("@/lib/analytics").then(({ captureAnalyticsEvent }) => {
      if (cancelled) return;
      let lastActive = 0;
      const activity = () => {
        if (document.visibilityState !== "visible" || Date.now() - lastActive < 60_000) return;
        if (captureAnalyticsEvent("app_active", { activity_source: "human_input" }))
          lastActive = Date.now();
      };
      const click = (event: MouseEvent) => {
        if (!event.isTrusted) return;
        activity();
        const clicked = analyticsClickEvent(event.target, window.location.origin);
        if (clicked) captureAnalyticsEvent(clicked.name, clicked.properties);
      };
      const key = (event: KeyboardEvent) => {
        if (event.isTrusted) activity();
      };
      document.addEventListener("click", click, true);
      document.addEventListener("keydown", key, true);
      dispose = () => {
        document.removeEventListener("click", click, true);
        document.removeEventListener("keydown", key, true);
      };
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [isPublicAuthRoute]);

  useEffect(() => {
    const open = () => {
      takePendingAnalyticsPreferencesOpen();
      setEditing(true);
    };
    if (takePendingAnalyticsPreferencesOpen()) setEditing(true);
    window.addEventListener(OPEN_ANALYTICS_PREFERENCES_EVENT, open);
    return () => window.removeEventListener(OPEN_ANALYTICS_PREFERENCES_EVENT, open);
  }, []);

  const showPreferences = analyticsPreferencesAvailable(config);

  const choose = (nextChoice: AnalyticsConsent) => {
    // Content-free server count of choices, so reports can state how much of
    // the audience the consent-gated providers cannot see. Unchanged
    // re-confirmations from Account preferences are not counted again.
    if (nextChoice !== choice) reportAnalyticsConsentDecision(nextChoice);
    persistAnalyticsConsent(nextChoice);
    setChoice(nextChoice);
    setEditing(false);
    void import("@/lib/analytics").then(({ applyAnalyticsConsent }) => {
      applyAnalyticsConsent(nextChoice);
    });
  };

  if (!showPreferences || isPublicAuthRoute || !editing) return null;

  // Docked in normal flow at the bottom of the fixed app canvas (the parent is
  // a flex column): the banner takes its own space instead of floating over
  // sign-in, onboarding, or the composer, so every control stays reachable.
  return (
    <section
      aria-label="Analytics preferences"
      className="order-last shrink-0 border-t border-border bg-surface px-4 py-2.5"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
        <div className="min-w-0 flex-1">
          <p data-contrast-audited className="text-xs leading-relaxed text-fg-muted">
            <span className="text-sm font-medium text-fg">Help us improve Opengeni.</span> Optional
            analytics with first-party cookies. We never send prompts, code, names, emails, or
            secrets.
          </p>
          <details className="mt-0.5 text-xs text-fg-muted">
            <summary className="w-fit cursor-pointer rounded-sm text-fg underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
              What we collect
            </summary>
            <p data-contrast-audited className="mt-1 max-w-3xl leading-relaxed">
              We use optional performance analytics, including first-party cookies, to understand
              adoption. When you sign in, consented events use internal user and account IDs. Copy
              tracking is disabled; we do not send names, email addresses, prompts, source code,
              repository content, tool arguments, or secrets.
            </p>
          </details>
        </div>
        <div className="flex shrink-0 justify-end gap-2">
          {choice !== null ? (
            <button
              type="button"
              className={`${BUTTON_CLASS} hover:bg-accent hover:text-accent-foreground`}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            className={`${BUTTON_CLASS} bg-secondary text-secondary-foreground hover:bg-surface-3 hover:text-fg`}
            onClick={() => choose("denied")}
          >
            Decline
          </button>
          <button
            type="button"
            className={`${BUTTON_CLASS} border border-primary-border bg-primary text-primary-foreground hover:bg-primary-hover`}
            onClick={() => choose("granted")}
          >
            Allow analytics
          </button>
        </div>
      </div>
    </section>
  );
}
