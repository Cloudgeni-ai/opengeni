import type { SessionGoalStatus, SessionStatus } from "./session-topology-primitives";
import type { WorkDiscoveryProjection } from "./work-claims";
import type { Session, SessionQueueSnapshot } from "./index";

/** MCP-only presentation choice. REST/SDK session shapes keep their own defaults. */
export type SessionMcpDetail = "compact" | "full";

/** Search evidence is inseparable from matching; presentation opts never weaken search. */
export function sessionMcpIncludesRelatedWork(options: {
  detail?: SessionMcpDetail | undefined;
  includeRelatedWork?: boolean | undefined;
  query?: string | undefined;
  subject?: unknown;
}): boolean {
  return (
    Boolean(options.query?.trim() || options.subject) ||
    (options.includeRelatedWork ?? options.detail === "full")
  );
}

/** A database prefix plus its exact Unicode code-point count, not a JS UTF-16 count. */
export function boundSessionMcpText(
  value: string | null,
  maxChars = 600,
  originalChars?: number | null,
) {
  if (value === null) return { text: null, truncated: false };
  const chars = Array.from(value);
  const sourceChars = Math.max(chars.length, originalChars ?? chars.length);
  if (sourceChars <= maxChars) return { text: value, truncated: false };
  let bodyChars = maxChars;
  let marker = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    marker = `…[${Math.max(0, sourceChars - bodyChars)} chars truncated]…`;
    const next = Math.max(0, maxChars - Array.from(marker).length);
    if (next === bodyChars) break;
    bodyChars = next;
  }
  return { text: `${chars.slice(0, bodyChars).join("")}${marker}`, truncated: true };
}

export type SessionMcpControlSource = {
  state: string;
  primaryBlocker: {
    kind: "session" | "workspace";
    sessionId?: string | undefined;
    displayName: string;
    displayNameOriginalChars?: number;
    reason?: string | null;
  } | null;
  additionalBlockerCount: number;
};

/** Call only after related-access projection: this helper never grants ancestor access. */
export function compactSessionMcpPause(control: SessionMcpControlSource) {
  const blocker = control.primaryBlocker;
  if (control.state === "active" && !blocker && !control.additionalBlockerCount) return undefined;
  const name = blocker
    ? boundSessionMcpText(blocker.displayName, 200, blocker.displayNameOriginalChars)
    : null;
  const reason = blocker?.reason ? boundSessionMcpText(blocker.reason) : null;
  return {
    state: control.state,
    ...(blocker
      ? {
          source: {
            kind: blocker.kind,
            ...(blocker.sessionId ? { sessionId: blocker.sessionId } : {}),
            displayName: name!.text,
            ...(name!.truncated ? { displayNameTruncated: true } : {}),
            ...(reason
              ? { reason: reason.text, ...(reason.truncated ? { reasonTruncated: true } : {}) }
              : {}),
          },
        }
      : {}),
    ...(control.additionalBlockerCount > 0
      ? { additionalBlockerCount: control.additionalBlockerCount }
      : {}),
  };
}

export type SessionMcpListSource = {
  id: string;
  title: string | null;
  titleOriginalChars?: number | null;
  status: SessionStatus;
  parentSessionId: string | null;
  effectiveControl: SessionMcpControlSource;
  goal: { status: SessionGoalStatus; text: string; textOriginalChars?: number } | null;
  updatedAt: string;
  workDiscovery?: WorkDiscoveryProjection;
  treeStats?: {
    attentionDescendants: number;
    pausedDescendants: number;
    failedDescendants: number;
    truncated: boolean;
  };
};

/** Closed allowlist, shared by MCP adapters. Never spread a database/session object. */
export function compactSessionMcpListRow(
  session: SessionMcpListSource,
  includeRelatedWork = false,
) {
  const title = boundSessionMcpText(session.title, 200, session.titleOriginalChars);
  const goal = session.goal
    ? boundSessionMcpText(session.goal.text, 600, session.goal.textOriginalChars)
    : null;
  const pause = compactSessionMcpPause(session.effectiveControl);
  const tree = session.treeStats;
  const attention =
    tree &&
    (tree.attentionDescendants > 0 ||
      tree.pausedDescendants > 0 ||
      tree.failedDescendants > 0 ||
      tree.truncated)
      ? {
          ...(tree.attentionDescendants > 0
            ? { requiresActionDescendants: tree.attentionDescendants }
            : {}),
          ...(tree.pausedDescendants > 0 ? { pausedDescendants: tree.pausedDescendants } : {}),
          ...(tree.failedDescendants > 0 ? { failedDescendants: tree.failedDescendants } : {}),
          ...(tree.truncated ? { truncated: true } : {}),
        }
      : undefined;
  return {
    id: session.id,
    title: title.text,
    status: session.status,
    ...(title.truncated ? { titleTruncated: true } : {}),
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(goal
      ? {
          goal: {
            status: session.goal!.status,
            summary: goal.text,
            ...(goal.truncated ? { summaryTruncated: true } : {}),
          },
        }
      : {}),
    ...(pause ? { pause } : {}),
    ...(attention ? { attention } : {}),
    ...(includeRelatedWork && session.workDiscovery ? { relatedWork: session.workDiscovery } : {}),
    updatedAt: session.updatedAt,
  };
}

export type SessionMcpMonitoringSource = {
  goal: {
    status: SessionGoalStatus;
    text: string;
    textOriginalChars: number;
    evidence: string | null;
    evidenceOriginalChars: number | null;
    rationale: string | null;
    rationaleOriginalChars: number | null;
    pausedReason: string | null;
    pausedReasonOriginalChars: number | null;
  } | null;
  progress: {
    sequence: number;
    text: string | null;
    /** Null when a bounded encoded prefix cannot establish the original code-point count. */
    originalChars: number | null;
    textTruncated?: true;
    occurredAt: string;
  } | null;
  wait: { reason: string; until: string } | null;
};

/** Closed management projection shared by adapters; never includes session configuration.
 * Apply target/ancestor authorization projection to session before calling. */
export function compactSessionMcpDetail(
  session: Session,
  monitoring: SessionMcpMonitoringSource,
  queue: SessionQueueSnapshot | null,
) {
  const title = boundSessionMcpText(session.title, 200);
  const pause = compactSessionMcpPause(session.effectiveControl);
  const goal = monitoring.goal;
  const goalText = goal ? boundSessionMcpText(goal.text, 600, goal.textOriginalChars) : null;
  const optionalText = <Name extends string>(
    name: Name,
    text: string | null,
    originalChars: number | null,
    limit = 600,
  ): Partial<Record<Name, string | null> & Record<`${Name}Truncated`, true>> => {
    if (text === null) return {};
    const bounded = boundSessionMcpText(text, limit, originalChars);
    return {
      [name]: bounded.text,
      ...(bounded.truncated ? { [`${name}Truncated`]: true } : {}),
    } as Partial<Record<Name, string | null> & Record<`${Name}Truncated`, true>>;
  };
  const progress = monitoring.progress;
  const progressText = progress
    ? boundSessionMcpText(progress.text, 600, progress.originalChars)
    : null;
  const waitReason = monitoring.wait ? boundSessionMcpText(monitoring.wait.reason) : null;
  return {
    id: session.id,
    title: title.text,
    status: session.status,
    ...(title.truncated ? { titleTruncated: true } : {}),
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
    lastSequence: session.lastSequence,
    ...(goal
      ? {
          goal: {
            status: goal.status,
            summary: goalText!.text,
            ...(goalText!.truncated ? { summaryTruncated: true } : {}),
            ...optionalText("evidence", goal.evidence, goal.evidenceOriginalChars, 2000),
            ...optionalText("rationale", goal.rationale, goal.rationaleOriginalChars),
            ...optionalText("pausedReason", goal.pausedReason, goal.pausedReasonOriginalChars),
          },
        }
      : {}),
    ...(progress
      ? {
          progress: {
            sequence: progress.sequence,
            text: progressText!.text,
            occurredAt: progress.occurredAt,
            ...(progressText!.truncated || progress.textTruncated ? { textTruncated: true } : {}),
          },
        }
      : {}),
    ...(pause ? { pause } : {}),
    ...(monitoring.wait
      ? {
          wait: {
            reason: waitReason!.text,
            until: monitoring.wait.until,
            ...(waitReason!.truncated ? { reasonTruncated: true } : {}),
          },
        }
      : {}),
    ...(queue
      ? {
          queue: {
            queuedTurns: queue.items.length,
            pendingInputs: queue.pendingInputs.length,
            ...(queue.stoppingPreviousAttempt ? { stoppingPreviousAttempt: true } : {}),
          },
        }
      : {}),
    ...(session.effectiveControl.settlement || session.effectiveControl.backgroundCommandSettlement
      ? {
          stopping: {
            ...(session.effectiveControl.settlement
              ? { attempts: session.effectiveControl.settlement.attemptCount }
              : {}),
            ...(session.effectiveControl.backgroundCommandSettlement
              ? {
                  backgroundCommands:
                    session.effectiveControl.backgroundCommandSettlement.commandCount,
                }
              : {}),
          },
        }
      : {}),
    updatedAt: session.updatedAt,
  };
}

export type SessionMcpCompactListRow = ReturnType<typeof compactSessionMcpListRow>;
export type SessionMcpCompactDetail = ReturnType<typeof compactSessionMcpDetail>;
