// What a parent session shows of its sub-sessions' waits: which descendants
// are blocked on the person (the same `requires_action` state that puts the
// orange dot on the parent), and the questions and approvals each one holds.
// A leaf module so the session route can decide cheaply whether to load the
// card at all.
import type {
  LineageNode,
  SessionEvent,
  SessionEventType,
  SessionSummary,
  WorkspaceSessionListEvent,
} from "@opengeni/sdk";
import { projectPendingApprovals, type PendingApproval } from "../../approvals";
import { humanInputRequestFromEvent } from "../../human-input";
import { awaitsPerson } from "./needs-you";

/**
 * Every event that opens or closes a question or an approval. A sub-session's
 * newest page of these is enough to rebuild what it waits on, exactly as its
 * own page projects it from the full log.
 */
export const DESCENDANT_REQUEST_EVENT_TYPES: SessionEventType[] = [
  "session.humanInput.requested",
  "user.humanInputResponse",
  "session.requiresAction",
  "user.approvalDecision",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
];

/** Newest request events read per waiting sub-session. */
export const DESCENDANT_REQUEST_EVENT_LIMIT = 20;

/**
 * A sub-session that waits on a person: blocked on a question, an approval or
 * another human step. The rail's `awaitsPerson` (a session the runtime could
 * not start is Stuck, not waiting on the person), minus archived sessions,
 * which the parent page does not offer to act on.
 */
export function awaitsPersonInTree(session: SessionSummary): boolean {
  return session.archived !== true && awaitsPerson(session);
}

/** Every descendant that waits on the person, the longest-waiting first. */
export function waitingDescendants(nodes: readonly LineageNode[]): SessionSummary[] {
  const waiting: SessionSummary[] = [];
  const visit = (level: readonly LineageNode[]) => {
    for (const node of level) {
      if (awaitsPersonInTree(node.session)) waiting.push(node.session);
      visit(node.children);
    }
  };
  visit(nodes);
  const since = (session: SessionSummary) =>
    session.requiresActionSince ?? session.updatedAt ?? session.createdAt ?? "";
  return waiting.sort(
    (left, right) => since(left).localeCompare(since(right)) || left.id.localeCompare(right.id),
  );
}

/** The ids of every session in a lineage tree. */
export function lineageSessionIds(nodes: readonly LineageNode[]): Set<string> {
  const ids = new Set<string>();
  const visit = (level: readonly LineageNode[]) => {
    for (const node of level) {
      ids.add(node.session.id);
      visit(node.children);
    }
  };
  visit(nodes);
  return ids;
}

/** Whether a descendant is running, and so may spawn or start waiting. */
export function descendantsRunning(nodes: readonly LineageNode[]): boolean {
  return nodes.some(
    (node) => node.session.status === "running" || descendantsRunning(node.children),
  );
}

/**
 * Whether a workspace session-list hint can change what this tree waits on:
 * a full reconciliation, or a change to one of the descendants (`ids`).
 */
export function hintTouchesTree(
  hint: Pick<WorkspaceSessionListEvent, "sessionIds" | "available"> | null | undefined,
  ids: ReadonlySet<string>,
): boolean {
  if (!hint?.available) return false;
  if (hint.sessionIds === null) return true;
  return hint.sessionIds.some((id) => ids.has(id));
}

type ToolCallPayload = { id?: unknown; name?: unknown; toolName?: unknown; arguments?: unknown };

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const RESPONSE_TOOLS = ["session_human_input_respond", "session_steer"];

function isResponseToolName(name: unknown): boolean {
  return typeof name === "string" && RESPONSE_TOOLS.some((tool) => name.endsWith(tool));
}

/**
 * The call id of a tool call this session's agent made to answer a
 * sub-session (`session_human_input_respond`) or steer it onto new work
 * (`session_steer`), directly or through `tool_invoke`. Null otherwise.
 */
export function subSessionResponseCallId(event: SessionEvent): string | null {
  if (event.type !== "agent.toolCall.created") return null;
  const payload = record(event.payload) as ToolCallPayload | null;
  if (typeof payload?.id !== "string") return null;
  const name = typeof payload.name === "string" ? payload.name : payload.toolName;
  if (isResponseToolName(name)) return payload.id;
  if (typeof name === "string" && name.endsWith("tool_invoke")) {
    const args = payload.arguments;
    // `tool_invoke` arguments arrive as JSON text; parse only a likely match.
    if (typeof args === "string" && !RESPONSE_TOOLS.some((tool) => args.includes(tool))) {
      return null;
    }
    return isResponseToolName(record(args)?.name) ? payload.id : null;
  }
  return null;
}

// Events are immutable once delivered: scan each one once, however often the
// feed is re-read.
const responseCallIdCache = new WeakMap<SessionEvent, string | null>();

/** Every call in a feed that answers or steers a sub-session, by call id. */
export function subSessionResponseCallIds(events: readonly SessionEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "agent.toolCall.created") continue;
    let id = responseCallIdCache.get(event);
    if (id === undefined) {
      id = subSessionResponseCallId(event);
      responseCallIdCache.set(event, id);
    }
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The output of one of those calls: the call has run, so the sub-session's
 * open waits may have closed and the card must re-read what still waits.
 * Outputs carry only the call id, so they are matched to their created event.
 */
export function isSubSessionResponseOutput(
  event: SessionEvent,
  callIds: ReadonlySet<string>,
): boolean {
  if (event.type !== "agent.toolCall.output") return false;
  const id = record(event.payload)?.id;
  return typeof id === "string" && callIds.has(id);
}

export type DescendantRequestActivity = {
  /** Approvals still awaiting a decision, as the sub-session's page shows them. */
  approvals: PendingApproval[];
  /** Where the open approvals were raised, to open the sub-session there. */
  approvalSequence: number | null;
  /** Where each question was asked, by request id. */
  requestSequences: ReadonlyMap<string, number>;
};

export const EMPTY_DESCENDANT_ACTIVITY: DescendantRequestActivity = {
  approvals: [],
  approvalSequence: null,
  requestSequences: new Map(),
};

/**
 * Rebuild what a sub-session waits on from its newest request events (any
 * order). Uses the same approval projection as the sub-session's own page, so
 * a decided approval never reappears as a live one.
 */
export function descendantRequestActivity(
  events: readonly SessionEvent[],
): DescendantRequestActivity {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const approvals = projectPendingApprovals(ordered);
  let approvalSequence: number | null = null;
  const requestSequences = new Map<string, number>();
  for (const event of ordered) {
    if (event.type === "session.requiresAction") approvalSequence = event.sequence;
    const request = humanInputRequestFromEvent(event);
    if (request) requestSequences.set(request.id, event.sequence);
  }
  return {
    approvals,
    approvalSequence: approvals.length > 0 ? approvalSequence : null,
    requestSequences,
  };
}

/** The collapsed stack's one line. */
export function subSessionsNeedYouLabel(count: number): string {
  return count === 1 ? "1 sub-session needs you" : `${count} sub-sessions need you`;
}
