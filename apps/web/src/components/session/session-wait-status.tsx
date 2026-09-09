import { useEffect, useState } from "react";
import { Clock3Icon } from "lucide-react";
import type { Session } from "@opengeni/sdk";
import { sessionInputWait } from "@/lib/session-rail";

/** Current durable wait state, separate from immutable timeline history. */
export function SessionWaitStatus({
  session,
}: {
  session: Pick<Session, "status" | "effectiveControl" | "inputWait">;
}) {
  const waiting = sessionInputWait(session);
  const deadlineAt = waiting?.deadlineAt;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!deadlineAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [deadlineAt]);
  if (!waiting) return null;
  const deadline = new Date(waiting.deadlineAt);
  const time = deadline.toLocaleString(undefined, {
    ...(deadline.toDateString() === new Date(now).toDateString()
      ? {}
      : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
  const reason = waiting.reason.trim();
  // Older agents used this field for verbose internal notes. Preserve those in
  // disclosure instead of promoting them into the current status headline.
  const compact = reason.length <= 180 && !/[\n]|[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(reason);
  return (
    <div className="shrink-0 px-4 py-2 sm:px-6" data-session-wait-status="">
      <div className="mx-auto flex w-full max-w-3xl items-start gap-2 text-sm text-fg-muted">
        <Clock3Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <div role="status">
            <p className="font-medium text-fg">
              {compact && reason ? reason : "Waiting for work in progress"}
            </p>
            <p className="mt-0.5 text-xs">
              {deadline.getTime() <= now
                ? "Recheck due · waiting to resume"
                : `Checks again at ${time} · resumes sooner if an update arrives`}
            </p>
          </div>
          {!compact && (
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer">Wait details</summary>
              <p className="mt-1 whitespace-pre-wrap break-words">{reason}</p>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
