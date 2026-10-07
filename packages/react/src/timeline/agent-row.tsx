import { ArrowUpRightIcon, ChevronRightIcon } from "lucide-react";
import { useContext, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { useForcedDefaultOpen } from "./disclosure-context";
import type { AgentTitleParts } from "./platform-activity-presentation";
import { ActivityDisclosure, CompactActivityContext } from "./shared";

/* ----------------------------------------------------------------------------
   Agent row

   One row for everything that crosses between agents: spawning one, messaging
   one, and every update one sends back. It names the agent, previews what was
   said, opens the full text in place, and deep-links to the agent's session.
   It reuses the rail's row geometry (chevron, icon, title) so it reads as a
   sibling of tool rows, and spends color only on failure.
   -------------------------------------------------------------------------- */

export type AgentRowProps = {
  icon: ReactNode;
  title: AgentTitleParts;
  /** Quiet secondary text shown while collapsed. */
  preview?: string | null | undefined;
  /** Two lines suit inbound messages; spawns and messages use one. */
  previewLines?: 1 | 2 | undefined;
  /** Short trailing note after the title, e.g. "+2 earlier". */
  meta?: string | null | undefined;
  /** The agent session the row deep-links to. */
  sessionId?: string | null | undefined;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  running?: boolean | undefined;
  failed?: boolean | undefined;
  cancelled?: boolean | undefined;
  /** Expanded body; the row is static when absent. */
  children?: ReactNode | undefined;
};

export function AgentRow({
  icon,
  title,
  preview,
  previewLines = 1,
  meta,
  sessionId,
  onOpenSession,
  running,
  failed,
  cancelled,
  children,
}: AgentRowProps) {
  const compact = useContext(CompactActivityContext);
  const forcedDefaultOpen = useForcedDefaultOpen();
  const [open, setOpen] = useState(forcedDefaultOpen ?? false);
  if (compact) {
    return (
      <ActivityDisclosure
        icon={icon}
        title={title.text}
        preview={preview ?? undefined}
        running={running}
        failed={failed}
        cancelled={cancelled}
      />
    );
  }
  const hasBody = children != null;
  const canOpen = Boolean(sessionId && onOpenSession);
  const openLabel = title.name ? `Open ${title.name}` : "Open agent session";
  const status = failed ? "failed" : cancelled ? "cancelled" : running ? "running" : undefined;

  const inner = (
    <>
      {hasBody ? (
        <ChevronRightIcon
          aria-hidden
          className="mt-[3px] size-3.5 shrink-0 text-og-fg-subtle transition-transform duration-[var(--_og-duration-disclose)] ease-og-in-out group-data-[state=open]/agent:rotate-90"
        />
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden />
      )}
      <span
        aria-hidden
        className={cn(
          "mt-[3px] shrink-0 [&_svg]:size-3.5",
          failed ? "text-og-status-failed" : "text-og-fg-subtle",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 truncate text-og-base leading-5",
              running && "og-shimmer-text",
              failed && "text-og-status-failed",
            )}
          >
            {title.name ? (
              <>
                {title.before ? <span className="text-og-fg-muted">{title.before}</span> : null}
                <span className={cn("font-medium", failed ? undefined : "text-og-fg")}>
                  {title.name}
                </span>
                {title.after ? <span className="text-og-fg-muted">{title.after}</span> : null}
              </>
            ) : (
              <span className={cn("font-medium", failed ? undefined : "text-og-fg")}>
                {title.text}
              </span>
            )}
          </span>
          {meta ? (
            <span className="shrink-0 text-og-xs text-og-fg-subtle tabular-nums">{meta}</span>
          ) : null}
        </span>
        {preview && !open ? (
          <span
            data-og-agent-preview=""
            className={cn(
              "mt-0.5 block text-og-sm leading-5 text-og-fg-muted",
              previewLines === 2 ? "line-clamp-2 break-words" : "truncate",
            )}
          >
            {preview}
          </span>
        ) : null}
      </span>
      {failed ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 self-center font-og-mono text-og-xs leading-none text-og-status-failed">
          <span className="size-1.5 rounded-full bg-og-status-failed" />
          failed
        </span>
      ) : cancelled ? (
        <span className="og-cancelled-chip shrink-0 self-center font-og-mono text-og-xs leading-none text-og-fg-subtle">
          interrupted
        </span>
      ) : null}
      {canOpen && sessionId && onOpenSession ? (
        <button
          type="button"
          aria-label={openLabel}
          title={openLabel}
          onClick={(event) => {
            event.stopPropagation();
            onOpenSession(sessionId);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            "-my-0.5 inline-grid size-6 shrink-0 place-items-center rounded-og-sm text-og-fg-subtle",
            "outline-hidden transition-colors duration-150 hover:bg-og-surface-2 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent",
            "pointer-coarse:size-10",
          )}
        >
          <ArrowUpRightIcon aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </>
  );

  const rowClass = cn(
    "group/agent flex w-full min-w-0 items-start gap-2 rounded-og-sm px-1.5 py-1.5 text-left",
    "pointer-coarse:min-h-11 pointer-coarse:py-2.5",
  );

  if (!hasBody) {
    return (
      <div data-og-agent-row="" data-status={status} className={rowClass}>
        {inner}
      </div>
    );
  }

  // A div with button semantics (like ActivityDisclosure) so the open-session
  // button can live inside the row without nesting native buttons.
  return (
    <div data-og-agent-row="" data-status={status}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-state={open ? "open" : "closed"}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((previous) => !previous);
          }
        }}
        className={cn(
          rowClass,
          "cursor-pointer outline-hidden transition-colors duration-150 hover:bg-og-surface-1",
          "focus-visible:ring-2 focus-visible:ring-og-accent",
        )}
      >
        {inner}
      </div>
      {open ? (
        <div className="mb-2 ml-[2.125rem] mr-1.5 mt-0.5 flex flex-col gap-2 border-l border-og-border pl-4 text-og-sm leading-6 text-og-fg animate-og-expand">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Plain multi-line text for an expanded agent row. */
export function AgentRowText({ children }: { children: string }) {
  return <p className="whitespace-pre-wrap break-words">{children}</p>;
}

/** A labelled section inside an expanded agent row (Brief, Report, Evidence). */
export function AgentRowSection({
  label,
  children,
  muted,
}: {
  label: string;
  children: string;
  muted?: boolean | undefined;
}) {
  return (
    <div className="min-w-0">
      <p className="text-og-xs font-medium text-og-fg-subtle">{label}</p>
      <p
        className={cn("whitespace-pre-wrap break-words", muted ? "text-og-fg-muted" : "text-og-fg")}
      >
        {children}
      </p>
    </div>
  );
}
