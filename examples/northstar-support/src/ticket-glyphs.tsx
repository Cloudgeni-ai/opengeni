import type { TicketPriority, TicketStatus } from "./types";

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  investigating: "Investigating",
  waiting_on_customer: "Waiting on customer",
  resolved: "Resolved",
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/** One shape per workflow state, so the queue can be scanned without reading. */
export function StatusGlyph({ status, className }: { status: TicketStatus; className?: string }) {
  const tone =
    status === "resolved"
      ? "text-ns-ok"
      : status === "investigating"
        ? "text-ns-navy"
        : status === "waiting_on_customer"
          ? "text-ns-subtle"
          : "text-ns-muted";
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`${tone} ${className ?? "size-3.5"}`}
      fill="none"
    >
      {status === "open" ? (
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
      ) : null}
      {status === "investigating" ? (
        <>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 4.5a3.5 3.5 0 0 1 0 7Z" fill="currentColor" />
        </>
      ) : null}
      {status === "waiting_on_customer" ? (
        <circle
          cx="8"
          cy="8"
          r="6"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeDasharray="2.4 2.2"
        />
      ) : null}
      {status === "resolved" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="m5.2 8.2 1.9 1.9 3.7-3.9"
            stroke="white"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
    </svg>
  );
}

/** Signal bars for low/normal/high, a filled alert square for urgent. */
export function PriorityGlyph({
  priority,
  className,
}: {
  priority: TicketPriority;
  className?: string;
}) {
  if (priority === "urgent") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className={`text-ns-alert ${className ?? "size-3.5"}`}
      >
        <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="currentColor" />
        <path d="M8 4.6v4.2" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="11.3" r="1.05" fill="white" />
      </svg>
    );
  }
  const filled = priority === "high" ? 3 : priority === "normal" ? 2 : 1;
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`${priority === "high" ? "text-ns-ink" : "text-ns-muted"} ${className ?? "size-3.5"}`}
    >
      {[0, 1, 2].map((bar) => (
        <rect
          key={bar}
          x={2 + bar * 4.5}
          y={10 - bar * 3.5}
          width="3"
          height={4 + bar * 3.5}
          rx="1"
          fill="currentColor"
          opacity={bar < filled ? 1 : 0.22}
        />
      ))}
    </svg>
  );
}

export function Kbd({ children, tone = "light" }: { children: string; tone?: "light" | "dark" }) {
  return (
    <kbd
      className={
        tone === "dark"
          ? "inline-flex h-5 min-w-5 items-center justify-center rounded border border-white/15 px-1 font-[inherit] text-[11px] font-medium text-white/60"
          : "inline-flex h-5 min-w-5 items-center justify-center rounded border border-ns-line bg-ns-sheet px-1 font-[inherit] text-[11px] font-medium text-ns-subtle"
      }
    >
      {children}
    </kbd>
  );
}

/** Mac shows ⌘, everything else Ctrl. */
export const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ";
