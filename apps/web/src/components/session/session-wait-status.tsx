import { useEffect, useState } from "react";
import { Clock3Icon } from "lucide-react";
import type { Session } from "@opengeni/sdk";
import { sessionInputWait } from "@/lib/session-rail";
import {
  useSessionStartup,
  type SessionStartup,
  type SessionStartupSource,
} from "@/lib/session-startup";

/** Current durable wait state, separate from immutable timeline history. */
export function SessionWaitStatus({
  session,
}: {
  session: SessionStartupSource & Pick<Session, "inputWait">;
}) {
  const startup = useSessionStartup(session);
  if (startup) {
    return <SessionDispatchWaitStatus wait={session.dispatchWait} startup={startup} />;
  }
  return <SessionInputWaitStatus session={session} />;
}

function SessionDispatchWaitStatus({
  wait,
  startup,
}: {
  wait: Session["dispatchWait"];
  startup: SessionStartup;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const next = wait?.nextAttemptAt ? new Date(wait.nextAttemptAt) : null;
  return (
    <div className="shrink-0 px-4 py-2 sm:px-6" data-session-dispatch-wait="">
      <div className="mx-auto flex w-full max-w-3xl items-start gap-2 text-sm text-fg-muted">
        <Clock3Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <div role="status">
            <p className="font-medium text-fg">
              {wait?.lastError
                ? "Unable to start yet"
                : startup !== "starting"
                  ? "Still waiting to start"
                  : "Starting"}
            </p>
            {startup !== "starting" ? (
              <p className="mt-0.5 text-xs">No agent turn is running. Your messages are saved.</p>
            ) : null}
          </div>
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer">Start details</summary>
            <p className="mt-1">No agent turn is running yet.</p>
            <p className="mt-0.5 text-xs">
              {wait?.state === "pending" && next
                ? next.getTime() <= now
                  ? "Automatic start retry is due."
                  : `Automatic start retry at ${next.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.`
                : wait?.state === "acknowledged"
                  ? "The start request was accepted; a worker has not started the turn yet."
                  : "Start confirmation is unavailable. The next turn has not begun executing."}
            </p>
            {wait && (wait.attempts > 0 || wait.lastError) ? (
              <>
                <p className="mt-1">
                  {wait.attempts} dispatch attempt{wait.attempts === 1 ? "" : "s"} for the current
                  start request. Dispatch attempts do not mean the agent is running.
                </p>
                {wait.lastError ? (
                  <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
                    Last recorded dispatch error: {wait.lastError}
                  </p>
                ) : null}
              </>
            ) : null}
          </details>
        </div>
      </div>
    </div>
  );
}

/** The agent's deliberate wait retains its own reason and deadline. */
function SessionInputWaitStatus({
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
              <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
                {reason}
              </p>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
