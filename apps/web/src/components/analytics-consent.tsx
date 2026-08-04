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

const BUTTON_CLASS =
  "inline-flex h-9 cursor-pointer items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export function AnalyticsManager({
  config,
  hasSearchParameters,
  isPublicAuthRoute,
  pathname,
  analyticsAccountId,
  analyticsUserId,
}: {
  config: ClientConfig["analytics"];
  hasSearchParameters: boolean;
  isPublicAuthRoute: boolean;
  pathname: string;
  analyticsAccountId: string | null;
  analyticsUserId: string | null;
}) {
  const [choice, setChoice] = useState<AnalyticsConsent | null>(() => storedAnalyticsConsent());
  const [editing, setEditing] = useState(choice === null);

  useEffect(() => {
    let cancelled = false;
    void import("@/lib/analytics").then(({ suspendAnalytics, syncAnalytics }) => {
      if (cancelled) return;
      if (isPublicAuthRoute || hasSearchParameters) {
        suspendAnalytics();
        return;
      }
      syncAnalytics(config, pathname);
    });
    return () => {
      cancelled = true;
    };
  }, [config, hasSearchParameters, isPublicAuthRoute, pathname]);

  useEffect(() => {
    void import("@/lib/analytics").then(({ syncAnalyticsIdentity }) => {
      syncAnalyticsIdentity(
        analyticsUserId ? { userId: analyticsUserId, accountId: analyticsAccountId } : null,
      );
    });
  }, [analyticsAccountId, analyticsUserId]);

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
      <p className="mt-1 text-sm text-fg-muted">
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
