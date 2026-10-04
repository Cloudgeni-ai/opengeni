import { useEffect, useState } from "react";
import type { Session } from "@opengeni/sdk";

/** Live dispatch diagnostics belong to the current loading area, never history. */
export function StartupDispatchDetails({ wait }: { wait: Session["dispatchWait"] }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const next = wait?.nextAttemptAt ? new Date(wait.nextAttemptAt) : null;
  return (
    <div className="text-og-xs text-og-fg-muted" data-og-startup-dispatch-details="">
      <p>Your messages are saved. No agent turn is running yet.</p>
      <p>
        {wait?.state === "pending" && next
          ? next.getTime() <= now
            ? "Automatic start retry is due."
            : `Automatic start retry at ${next.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.`
          : wait?.state === "acknowledged"
            ? "The start request was accepted; a worker has not started the turn yet."
            : "Start confirmation is unavailable."}
      </p>
      {wait && wait.attempts > 0 ? (
        <p>
          {wait.attempts} dispatch attempt{wait.attempts === 1 ? "" : "s"}.
        </p>
      ) : null}
      {wait?.lastError ? (
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
          Last recorded dispatch error: {wait.lastError}
        </p>
      ) : null}
    </div>
  );
}
