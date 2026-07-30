import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  analyticsHasProviders,
  setAnalyticsConsent,
  storedAnalyticsConsent,
  type AnalyticsConsent,
} from "@/lib/analytics";
import type { ClientConfig } from "@/types";

export function AnalyticsConsentBanner({ config }: { config: ClientConfig["analytics"] }) {
  const [choice, setChoice] = useState<AnalyticsConsent | null>(() => storedAnalyticsConsent());

  if (!config.consentRequired || !analyticsHasProviders(config) || choice !== null) {
    return null;
  }

  const choose = (nextChoice: AnalyticsConsent) => {
    setAnalyticsConsent(nextChoice);
    setChoice(nextChoice);
  };

  return (
    <section
      aria-label="Analytics preferences"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-2xl rounded-xl border border-border bg-surface p-4 shadow-2xl"
    >
      <p className="text-sm font-medium text-fg">Help us improve OpenGeni</p>
      <p className="mt-1 text-sm text-fg-muted">
        We use privacy-limited analytics to understand adoption. We do not send prompts, source
        code, repository content, tool arguments, or secrets.
      </p>
      <div className="mt-3 flex justify-end gap-2">
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
