import type { AgentRunStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

import { StatusDot } from "./StatusDot";

const LABEL: Record<AgentRunStatus, string> = {
  queued: "Queued",
  dispatched: "Dispatched",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusBadge({
  status,
  className,
}: {
  status: AgentRunStatus;
  className?: string;
}) {
  return (
    <span
      aria-label={`Run status: ${LABEL[status]}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        "border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/60",
        "text-[color:var(--color-fg-muted)]",
        className,
      )}
    >
      <StatusDot status={status} />
      <span>{LABEL[status]}</span>
    </span>
  );
}
