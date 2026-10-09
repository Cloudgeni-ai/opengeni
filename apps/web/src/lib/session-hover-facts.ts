import { modelDisplayName } from "@opengeni/react";
import { labelReasoningEffort } from "@opengeni/react/model-policy";

import type { SemanticTone } from "@/components/ui/status-dot";
import { formatAbsoluteTime, inSentence } from "@/components/ui/relative-time";
import { sessionStatusLabel, sessionInputWait } from "@/lib/session-rail";
import type { RailSession } from "@/lib/session-list-entry";
import { sessionSiteOrigin } from "@/lib/session-site-origin";
import { sessionDescendantCountText } from "@/lib/session-tree-count";
import { scheduledTaskIdOf } from "@/lib/sessions-group";

/**
 * Everything the sidebar hover says about one session, derived only from the
 * compact list row. Every field is null (or empty) when the row has nothing
 * true to say, so the card never shows an empty label or a zero count.
 */
export type SessionHoverFacts = {
  status: { label: string; tone: SemanticTone; live: boolean };
  /** Short lines that explain the status: how long it has waited, when it checks next, who paused it. */
  context: string[];
  /** The agent's own waiting reason or the pause reason, verbatim. */
  reason: string | null;
  origin: { kind: "schedule" | "site"; label: string } | null;
  model: { id: string; effort: string | null } | null;
  subAgents: {
    total: string;
    parts: { label: string; tone: "attention" | "danger" | null }[];
  } | null;
  commands: string | null;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : pluralForm}`;
}

/** How long since `iso`, as a duration that keeps reading as one: "<1 min", "24 min", "3 hours", "2 days". */
export function formatWaitDuration(iso: string, now: number): string | null {
  const since = Date.parse(iso);
  if (Number.isNaN(since)) return null;
  const elapsed = Math.max(0, now - since);
  if (elapsed < MINUTE) return "<1 min";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < 2 * DAY) return plural(Math.floor(elapsed / HOUR), "hour");
  return plural(Math.floor(elapsed / DAY), "day");
}

/** "Next check at 14:30", "Next check tomorrow, 09:00", or "Next check due now". */
export function nextCheckLabel(deadlineAt: string, now: number): string | null {
  const deadline = new Date(deadlineAt);
  if (Number.isNaN(deadline.getTime())) return null;
  if (deadline.getTime() <= now) return "Next check due now";
  const absolute = formatAbsoluteTime(deadline, { now });
  return absolute.startsWith("Today, ")
    ? `Next check at ${absolute.slice("Today, ".length)}`
    : `Next check ${inSentence(absolute)}`;
}

function lifecycleStatus(session: RailSession, waiting: boolean): SessionHoverFacts["status"] {
  switch (session.status) {
    case "requires_action":
      return { label: "Needs you", tone: "attention", live: false };
    case "failed":
      return { label: "Failed", tone: "danger", live: false };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral", live: false };
    case "running":
    case "recovering":
      return { label: sessionStatusLabel(session.status), tone: "progress", live: true };
    case "queued":
    case "waiting_capacity":
      return { label: sessionStatusLabel(session.status), tone: "neutral", live: false };
    default:
      return waiting
        ? { label: "Waiting", tone: "progress", live: false }
        : { label: "Idle", tone: "success", live: false };
  }
}

function pauseContext(session: RailSession): string | null {
  const control = session.effectiveControl;
  if (!control || control.state !== "paused" || session.status === "cancelled") return null;
  if (control.settlement) return "Pausing";
  const blocker = control.primaryBlocker;
  if (blocker?.kind === "workspace") return "Workspace paused";
  if (control.directState === "paused" || !blocker || blocker.sessionId === session.id) {
    return "Paused directly";
  }
  return `Paused through ${blocker.displayName}`;
}

function subAgentFacts(
  session: RailSession,
  descendantCount: number,
  truncated: boolean,
): SessionHoverFacts["subAgents"] {
  if (descendantCount <= 0) return null;
  const stats = session.treeStats;
  const bound = truncated ? "+" : "";
  const part = (count: number | undefined, label: (count: number) => string) =>
    count && count > 0 ? `${count.toLocaleString("en-US")}${bound} ${label(count)}` : null;
  const parts: NonNullable<SessionHoverFacts["subAgents"]>["parts"] = [];
  const push = (label: string | null, tone: "attention" | "danger" | null = null) => {
    if (label) parts.push({ label, tone });
  };
  push(
    part(stats?.attentionDescendants, (count) =>
      count === 1 && !truncated ? "needs you" : "need you",
    ),
    "attention",
  );
  push(
    part(stats?.unreadFailedDescendants, (count) =>
      count === 1 && !truncated ? "unread failure" : "unread failures",
    ),
    "danger",
  );
  push(part(stats?.runningDescendants, () => "running"));
  push(part(stats?.waitingDescendants, () => "waiting"));
  push(part(stats?.queuedDescendants, () => "queued"));
  push(part(stats?.pausedDescendants, () => "paused"));
  return {
    total: `${sessionDescendantCountText(descendantCount, truncated)} ${
      descendantCount === 1 && !truncated ? "sub-agent" : "sub-agents"
    }`,
    parts,
  };
}

/**
 * Background commands, never claiming more than is observable: commands whose
 * status is unavailable are named as such, not counted as running.
 */
function commandFacts(session: RailSession): string | null {
  const activity = session.backgroundCommandActivity;
  if (!activity || activity.count <= 0) return null;
  const unavailable = Math.min(activity.count, activity.unavailableCount ?? 0);
  const known = activity.count - unavailable;
  const unknown =
    unavailable === 0
      ? null
      : unavailable === 1
        ? "1 command status unavailable"
        : `${unavailable.toLocaleString("en-US")} command statuses unavailable`;
  if (known > 0) {
    // "stopping" is aggregate: at least one command is stopping, not all.
    const main =
      activity.state === "stopping"
        ? `${plural(known, "background command")} · Stop requested`
        : `${plural(known, "background command")} running`;
    return unknown ? `${main} · ${unknown}` : main;
  }
  if (!unknown) return null;
  return activity.state === "stopping"
    ? `Stop requested · ${unknown}`
    : `${unknown.charAt(0).toUpperCase()}${unknown.slice(1)}`;
}

export function sessionHoverFacts(
  session: RailSession,
  {
    descendantCount,
    descendantCountTruncated,
    now = Date.now(),
  }: { descendantCount: number; descendantCountTruncated: boolean; now?: number },
): SessionHoverFacts {
  const wait = sessionInputWait(session);
  const paused = pauseContext(session);
  const lifecycle = lifecycleStatus(session, Boolean(wait));
  // A pause outranks ordinary lifecycle, but never hides that the session
  // needs a person or failed: those keep their status and gain the pause line.
  const status =
    paused && session.status !== "requires_action" && session.status !== "failed"
      ? {
          label: paused === "Pausing" ? "Pausing" : "Paused",
          tone: "neutral" as const,
          live: false,
        }
      : lifecycle;

  const context: string[] = [];
  if (session.status === "requires_action" && session.requiresActionSince) {
    const waited = formatWaitDuration(session.requiresActionSince, now);
    if (waited) context.push(`Waiting on you for ${waited}`);
  }
  if (wait) {
    const nextCheck = nextCheckLabel(wait.deadlineAt, now);
    if (nextCheck) context.push(nextCheck);
  }
  // The badge already says "Pausing" or "Paused" unless a needs-you or failed
  // status kept its place; then the pause (or its settlement) is spelled out.
  if (paused && (paused !== "Pausing" || status.label !== "Pausing")) context.push(paused);

  const pauseReason = paused ? session.effectiveControl?.primaryBlocker?.reason?.trim() : null;
  const reason = wait?.reason.trim() || pauseReason || null;

  const site = sessionSiteOrigin(session);
  const origin = site
    ? { kind: "site" as const, label: `Started from ${site.title}` }
    : scheduledTaskIdOf(session)
      ? { kind: "schedule" as const, label: "Started by a schedule" }
      : session.hasSchedules
        ? { kind: "schedule" as const, label: "On a schedule" }
        : null;

  const modelId = session.model?.trim();
  const effort = session.reasoningEffort;
  return {
    status,
    context,
    reason,
    origin,
    model: modelId
      ? {
          id: modelId,
          effort: effort && effort !== "none" ? `${labelReasoningEffort(effort)} reasoning` : null,
        }
      : null,
    subAgents: subAgentFacts(session, descendantCount, descendantCountTruncated),
    commands: commandFacts(session),
  };
}

/**
 * The hover's facts as one plain sentence list, for the row's accessible
 * description. The row's name already carries its title, state and creator, so
 * this adds only what the card adds, in the same order.
 */
export function sessionHoverDescription(facts: SessionHoverFacts): string {
  const model = facts.model
    ? [modelDisplayName(facts.model.id), facts.model.effort].filter(Boolean).join(", ")
    : null;
  const subAgents = facts.subAgents
    ? [facts.subAgents.total, ...facts.subAgents.parts.map((part) => part.label)].join(", ")
    : null;
  const parts = [
    ...facts.context,
    facts.reason,
    facts.origin?.label,
    model,
    subAgents,
    facts.commands,
  ].filter((part): part is string => Boolean(part));
  return parts.map((part) => part.replace(/[.\s]+$/u, "")).join(". ");
}
