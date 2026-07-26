import type { Session } from "@opengeni/sdk";
import { cn } from "../lib/cn";
import { formatRelativeTime, truncate } from "../lib/format";
import { SessionStatus } from "./session-status";

export type FleetTileProps = {
  session: Session;
  /** Overrides the derived title (metadata.title/name, else the initial message). */
  title?: string | undefined;
  /** Extra line under the title — e.g. "drift check" or the worker's task. */
  subtitle?: string | undefined;
  onOpen?: ((session: Session) => void) | undefined;
  className?: string | undefined;
};

/** Best-effort display title for a session. */
export function sessionDisplayTitle(session: Session): string {
  // A set title (agent-generated or user-renamed) wins over metadata + the
  // initial-message fallback.
  if (typeof session.title === "string" && session.title.trim().length > 0) {
    return session.title;
  }
  for (const key of ["title", "name"] as const) {
    const value = session.metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return truncate(session.initialMessage, 100) || session.id.slice(0, 8);
}

/**
 * One session in the fleet/manager view: title, live status, model, and
 * recency — dense but calm. Running sessions carry a breathing status dot
 * and a faint accent edge so the live ones read at a glance.
 */
export function FleetTile({ session, title, subtitle, onOpen, className }: FleetTileProps) {
  const running = session.status === "running" || session.status === "queued";
  const needsYou = session.status === "requires_action";
  return (
    <button
      type="button"
      data-status={session.status}
      onClick={onOpen ? () => onOpen(session) : undefined}
      disabled={!onOpen}
      className={cn(
        "og-root group relative flex w-full flex-col gap-2.5 overflow-hidden rounded-og-lg border border-og-border",
        "bg-og-surface-1 p-4 text-left shadow-og-sm",
        "transition-[border-color,background-color,box-shadow,transform] duration-200 ease-og-out",
        onOpen &&
          "hover:-translate-y-px hover:border-og-border-strong hover:bg-og-surface-2 hover:shadow-og-md",
        "disabled:cursor-default",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-0.5 transition-opacity duration-300",
          running
            ? "bg-og-accent opacity-100"
            : needsYou
              ? "bg-og-status-waiting opacity-100"
              : "opacity-0",
        )}
      />
      <span className="flex w-full items-start justify-between gap-3">
        <span className="line-clamp-2 min-w-0 text-og-base font-medium leading-snug text-og-fg">
          {title ?? sessionDisplayTitle(session)}
        </span>
        <SessionStatus status={session.status} size="sm" className="mt-px" />
      </span>
      {subtitle ? (
        <span className="line-clamp-1 text-og-sm text-og-fg-muted">{subtitle}</span>
      ) : null}
      <span className="mt-auto flex w-full items-center gap-2 text-og-xs text-og-fg-subtle">
        <span className="font-og-mono">{session.id.slice(0, 8)}</span>
        <span aria-hidden>·</span>
        <span className="truncate">{session.model}</span>
        <span className="ml-auto shrink-0" title={session.updatedAt}>
          {formatRelativeTime(session.updatedAt)}
        </span>
      </span>
    </button>
  );
}
