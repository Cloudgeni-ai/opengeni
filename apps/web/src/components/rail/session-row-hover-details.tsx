import {
  BotIcon,
  CalendarClockIcon,
  GitForkIcon,
  PanelsTopLeftIcon,
  SquareTerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { CreatorMonogram } from "@/components/creator-monogram";
import { ModelMark, modelDisplayName } from "@/components/model-identity";
import {
  formatAbsoluteTime,
  formatExactTime,
  formatRelativeTime,
  inSentence,
  useMinuteNow,
} from "@/components/ui/relative-time";
import { StatusBadge } from "@/components/ui/status-badge";
import { type CreatorRef, creatorInitials, creatorLabel } from "@/lib/creator-initials";
import { sessionHoverFacts } from "@/lib/session-hover-facts";
import type { RailSession } from "@/lib/session-list-entry";
import { cn } from "@/lib/utils";

/** One quiet fact: a 16px icon slot, then text that wraps under itself. */
function FactRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2 text-xs leading-4">
      <span className="flex size-4 shrink-0 items-center justify-center text-fg-subtle [&>svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

function Timestamp({
  label,
  iso,
  relative,
  now,
}: {
  label: string;
  iso: string;
  relative: boolean;
  now: number;
}) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const text = relative ? formatRelativeTime(date, { now }) : formatAbsoluteTime(date, { now });
  return (
    <span className="whitespace-nowrap">
      {label}{" "}
      <time dateTime={date.toISOString()} title={formatExactTime(date)} className="tabular-nums">
        {inSentence(text)}
      </time>
    </span>
  );
}

/**
 * The sidebar hover: what this session is doing and whether it needs you,
 * from the compact list row alone. Order follows importance - full title,
 * status with its real waiting or blocking context, model, sub-agent and
 * background activity, then a quiet footer. Anything empty or zero is left
 * out rather than shown as a blank label or "0".
 */
export function SessionRowHoverDetails({
  session,
  title,
  descendantCount,
  descendantCountTruncated,
  showCreator = true,
  now: fixedNow,
}: {
  session: RailSession;
  title: string;
  descendantCount: number;
  descendantCountTruncated: boolean;
  /** Creator attribution only helps in a workspace other people share. */
  showCreator?: boolean;
  /** A fixed clock for tests and previews; otherwise labels refresh each minute. */
  now?: number;
}) {
  useMinuteNow();
  const now = fixedNow ?? Date.now();
  const facts = sessionHoverFacts(session, { descendantCount, descendantCountTruncated, now });
  const createdBy: CreatorRef = session.createdBy;
  const creatorName =
    showCreator && (createdBy.kind === "service" || creatorInitials(createdBy) !== null)
      ? creatorLabel(createdBy)
      : null;
  const hasActivity = Boolean(facts.model || facts.subAgents || facts.commands);

  return (
    <div data-session-row-hover-details className="grid min-w-0 grid-cols-1 gap-3">
      <div className="grid min-w-0 gap-2">
        <p className="text-sm font-medium leading-snug text-fg [overflow-wrap:anywhere]">{title}</p>
        <div data-session-hover-status className="grid min-w-0 gap-1">
          <StatusBadge
            variant="dot"
            tone={facts.status.tone}
            pulse={facts.status.live}
            className="text-fg"
          >
            {facts.status.label}
          </StatusBadge>
          {facts.context.map((line) => (
            <p key={line} className="pl-3 text-xs leading-4 text-fg-muted [overflow-wrap:anywhere]">
              {line}
            </p>
          ))}
        </div>
        {facts.reason ? (
          <p
            data-session-hover-reason
            className="line-clamp-3 border-l-2 border-border pl-2.5 text-xs leading-relaxed text-fg-muted [overflow-wrap:anywhere]"
          >
            {facts.reason}
          </p>
        ) : null}
        {facts.origin ? (
          <div className="text-fg-muted">
            <FactRow
              icon={
                facts.origin.kind === "site" ? (
                  <PanelsTopLeftIcon aria-hidden="true" />
                ) : (
                  <CalendarClockIcon aria-hidden="true" />
                )
              }
            >
              {facts.origin.label}
            </FactRow>
          </div>
        ) : null}
      </div>

      {hasActivity ? (
        <div data-session-hover-activity className="grid min-w-0 gap-1.5">
          {facts.model ? (
            <FactRow icon={<ModelMark model={facts.model.id} className="size-3.5 text-fg" />}>
              <span className="font-medium text-fg">{modelDisplayName(facts.model.id)}</span>
              {facts.model.effort ? (
                <span className="text-fg-muted"> · {facts.model.effort}</span>
              ) : null}
            </FactRow>
          ) : null}
          {facts.subAgents ? (
            <FactRow icon={<GitForkIcon aria-hidden="true" />}>
              <span className="text-fg">{facts.subAgents.total}</span>
              {facts.subAgents.parts.map((part) => (
                <span
                  key={part.label}
                  className={cn(
                    part.tone === "attention"
                      ? "text-status-waiting"
                      : part.tone === "danger"
                        ? "text-danger"
                        : "text-fg-muted",
                  )}
                >
                  <span className="text-fg-subtle"> · </span>
                  {part.label}
                </span>
              ))}
            </FactRow>
          ) : null}
          {facts.commands ? (
            <FactRow icon={<SquareTerminalIcon aria-hidden="true" />}>
              <span className="text-fg">{facts.commands}</span>
            </FactRow>
          ) : null}
        </div>
      ) : null}

      <div
        data-session-hover-footer
        className="grid min-w-0 gap-1 border-t border-border pt-2.5 text-xs leading-4 text-fg-subtle"
      >
        {creatorName ? (
          <div className="flex min-w-0 items-center gap-2">
            {createdBy.kind === "subject" ? (
              <CreatorMonogram createdBy={createdBy} showTitle={false} />
            ) : (
              <span className="flex size-4 shrink-0 items-center justify-center">
                <BotIcon aria-hidden="true" className="size-3.5" />
              </span>
            )}
            <span className="min-w-0 truncate text-fg-muted">{creatorName}</span>
          </div>
        ) : null}
        <p className="flex flex-wrap gap-x-1.5">
          <Timestamp label="Created" iso={session.createdAt} relative={false} now={now} />
          <span aria-hidden="true">·</span>
          <Timestamp label="Updated" iso={session.updatedAt} relative now={now} />
        </p>
      </div>
    </div>
  );
}
