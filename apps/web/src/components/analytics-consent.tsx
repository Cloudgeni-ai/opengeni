import { useEffect, useState } from "react";

import {
  OPEN_ANALYTICS_PREFERENCES_EVENT,
  analyticsPreferencesAvailable,
  persistAnalyticsConsent,
  storedAnalyticsConsent,
  takePendingAnalyticsPreferencesOpen,
  type AnalyticsConsent,
} from "@/lib/analytics-consent";
import type { ClientConfig } from "@/types";
import { journeyAction, journeyPage } from "@/lib/analytics-journey";

const BUTTON_CLASS =
  "inline-flex h-11 cursor-pointer items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export function AnalyticsManager({
  config,
  hasSearchParameters,
  isPublicAuthRoute,
  pathname,
  search = "",
  analyticsAccountId,
  analyticsUserId,
}: {
  config: ClientConfig["analytics"];
  hasSearchParameters: boolean;
  isPublicAuthRoute: boolean;
  pathname: string;
  search?: string;
  analyticsAccountId: string | null;
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
          analyticsUserId ? { userId: analyticsUserId, accountId: analyticsAccountId } : null,
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
        const target = event.target instanceof Element ? event.target : null;
        const control = target?.closest("button,a,[role=button],[role=tab],[role=menuitem]");
        if (!control) return;
        if (control instanceof HTMLAnchorElement && control.origin === window.location.origin) {
          const destination = journeyPage(control.pathname, control.search);
          captureAnalyticsEvent("navigation_clicked", {
            destination_page: destination.page!,
            ...(destination.section ? { destination_section: destination.section } : {}),
          });
        } else {
          const action = journeyAction(control.getAttribute("data-analytics-action"));
          captureAnalyticsEvent("product_clicked", {
            ...(action ? { action } : {}),
            control_kind:
              control.tagName === "BUTTON" ? "button" : (control.getAttribute("role") ?? "link"),
          });
        }
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
    persistAnalyticsConsent(nextChoice);
    setChoice(nextChoice);
    setEditing(false);
    void import("@/lib/analytics").then(({ applyAnalyticsConsent }) => {
      applyAnalyticsConsent(nextChoice);
    });
  };

  if (!showPreferences || isPublicAuthRoute || !editing) return null;

  return (
    <section
      aria-label="Analytics preferences"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-2xl rounded-xl border border-border bg-surface p-4 shadow-2xl"
    >
      <p className="text-sm font-medium text-fg">Help us improve OpenGeni</p>
      <p data-contrast-audited className="mt-1 text-sm text-fg-muted">
        We use optional performance analytics, including first-party cookies, to understand
        adoption. When you sign in, consented events use internal user and account IDs. Copy
        tracking is disabled; we do not send names, email addresses, prompts, source code,
        repository content, tool arguments, or secrets.
      </p>
      <div className="mt-3 flex justify-end gap-2">
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
          className={`${BUTTON_CLASS} bg-secondary text-secondary-foreground hover:bg-secondary/80`}
          onClick={() => choose("denied")}
        >
          Decline
        </button>
        <button
          type="button"
          className={`${BUTTON_CLASS} bg-primary text-primary-foreground hover:bg-primary/90`}
          onClick={() => choose("granted")}
        >
          Allow analytics
        </button>
      </div>
    </section>
  );
}
