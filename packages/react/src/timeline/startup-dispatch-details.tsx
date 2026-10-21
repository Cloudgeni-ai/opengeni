import { useEffect, useState } from "react";
import type { Session } from "@opengeni/sdk";
import { useOpenGeniText } from "../messages/runtime";

/** Live dispatch diagnostics belong to the current loading area, never history. */
export function StartupDispatchDetails({ wait }: { wait: Session["dispatchWait"] }) {
  const t = useOpenGeniText();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const next = wait?.nextAttemptAt ? new Date(wait.nextAttemptAt) : null;
  return (
    <div className="text-og-xs text-og-fg-muted" data-og-startup-dispatch-details="">
      <p>{t("timeline.startupDispatchDetails.yourMessagesAreSavedNo")}</p>
      <p>
        {wait?.state === "pending" && next
          ? next.getTime() <= now
            ? t("timeline.startupDispatchDetails.automaticStartRetryIsDue")
            : t("timeline.startupDispatchDetails.automaticStartRetryAtLocaletimestring", {
                localeTimeString: next.toLocaleTimeString(t.locale, {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })
          : wait?.state === "acknowledged"
            ? t("timeline.startupDispatchDetails.theStartRequestWasAccepted")
            : t("timeline.startupDispatchDetails.startConfirmationIsUnavailable")}
      </p>
      {wait && wait.attempts > 0 ? (
        <p>{t("timeline.startupDispatchDetails.dispatchAttempts", { count: wait.attempts })}</p>
      ) : null}
      {wait?.lastError ? (
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
          {t("timeline.startupDispatchDetails.lastRecordedDispatchErrorLasterror", {
            lastError: wait.lastError,
          })}
        </p>
      ) : null}
    </div>
  );
}
