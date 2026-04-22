import type { AgentRunStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<AgentRunStatus, string> = {
  queued: "bg-[color:var(--color-status-waiting)]",
  dispatched: "bg-[color:var(--color-status-waiting)]",
  running: "bg-[color:var(--color-status-running)]",
  waiting: "bg-[color:var(--color-status-waiting)]",
  succeeded: "bg-[color:var(--color-status-success)]",
  failed: "bg-[color:var(--color-status-failed)]",
  cancelled: "bg-[color:var(--color-status-cancelled)]",
};

const ACTIVE_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "dispatched",
  "running",
]);

export function StatusDot({
  status,
  className,
}: {
  status: AgentRunStatus;
  className?: string;
}) {
  const active = ACTIVE_STATUSES.has(status);
  return (
    <span
      role="img"
      aria-label={`Status: ${status}`}
      className={cn("relative inline-flex size-2", className)}
    >
      {active ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-60",
            STATUS_CLASS[status],
          )}
        />
      ) : null}
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-flex size-2 rounded-full",
          STATUS_CLASS[status],
        )}
      />
    </span>
  );
}
