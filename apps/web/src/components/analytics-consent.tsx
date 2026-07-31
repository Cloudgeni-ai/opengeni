import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  analyticsHasProviders,
  persistAnalyticsConsent,
  storedAnalyticsConsent,
  type AnalyticsConsent,
} from "@/lib/analytics-consent";
import type { ClientConfig } from "@/types";

export function AnalyticsConsentBanner({ config }: { config: ClientConfig["analytics"] }) {
  const [choice, setChoice] = useState<AnalyticsConsent | null>(() => storedAnalyticsConsent());
  const [editing, setEditing] = useState(choice === null);

  if (!config.consentRequired || !analyticsHasProviders(config)) {
    return null;
  }

  const choose = (nextChoice: AnalyticsConsent) => {
    persistAnalyticsConsent(nextChoice);
    setChoice(nextChoice);
    setEditing(false);
    void import("@/lib/analytics").then(({ applyAnalyticsConsent }) => {
      applyAnalyticsConsent(nextChoice);
    });
  };

  if (!editing) {
    return (
      <Button
        type="button"
        variant="secondary"
        className="fixed bottom-3 left-3 z-40 h-8 px-2 text-xs"
        onClick={() => setEditing(true)}
      >
        Analytics preferences
      </Button>
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
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        ) : null}
        <Button type="button" variant="secondary" onClick={() => choose("denied")}>
          Decline
        </Button>
        <Button type="button" onClick={() => choose("granted")}>
          Allow analytics
        </Button>
      </div>
    </section>
  );
}
