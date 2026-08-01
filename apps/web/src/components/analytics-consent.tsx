import { useEffect, useState } from "react";

import {
  analyticsHasProviders,
  persistAnalyticsConsent,
  storedAnalyticsConsent,
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
}: {
  config: ClientConfig["analytics"];
  hasSearchParameters: boolean;
  isPublicAuthRoute: boolean;
  pathname: string;
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

  const showPreferences = config.consentRequired && analyticsHasProviders(config);

  const choose = (nextChoice: AnalyticsConsent) => {
    persistAnalyticsConsent(nextChoice);
    setChoice(nextChoice);
    setEditing(false);
    void import("@/lib/analytics").then(({ applyAnalyticsConsent }) => {
      applyAnalyticsConsent(nextChoice);
    });
  };

  if (!showPreferences || isPublicAuthRoute) return null;

  if (!editing) {
    return (
      <button
        type="button"
        className={`${BUTTON_CLASS} fixed bottom-3 left-3 z-40 h-8 bg-secondary px-2 text-xs text-secondary-foreground hover:bg-secondary/80`}
        onClick={() => setEditing(true)}
      >
        Analytics preferences
      </button>
    );
  }

  return (
    <section
      aria-label="Analytics preferences"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-2xl rounded-xl border border-border bg-surface p-4 shadow-2xl"
    >
      <p className="text-sm font-medium text-fg">Help us improve OpenGeni</p>
      <p className="mt-1 text-sm text-fg-muted">
        We use optional performance analytics, including first-party cookies, to understand
        adoption. Copy tracking is disabled; we do not send prompts, source code, repository
        content, tool arguments, or secrets.
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
