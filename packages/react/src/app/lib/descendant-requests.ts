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
export const DESCENDANT_REQUEST_EVENT_LIMIT = 50;

/**
 * A sub-session that waits on a person: blocked on a question, an approval or
 * another human step. Matches the server's `attentionDescendants` count (and
 * the rail's `awaitsPerson`): a session the runtime could not start is Stuck,
 * not waiting on the person.
 */
export function awaitsPersonInTree(session: SessionSummary): boolean {
  return (
    session.status === "requires_action" &&
    session.archived !== true &&
    (session.admissionBlock === undefined || session.admissionBlock === null)
  );
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

/**
 * Whether a workspace session-list hint can change what this tree waits on:
 * a full reconciliation, or a change to the parent or one of its descendants.
 */
export function hintTouchesTree(
  hint: Pick<WorkspaceSessionListEvent, "sessionIds" | "available"> | null | undefined,
  ids: ReadonlySet<string>,
): boolean {
  if (!hint?.available) return false;
  if (hint.sessionIds === null) return true;
  return hint.sessionIds.some((id) => ids.has(id));
}

function toolName(event: SessionEvent): string {
  const payload = event.payload as { name?: unknown; toolName?: unknown } | null | undefined;
  if (typeof payload?.name === "string") return payload.name;
  if (typeof payload?.toolName === "string") return payload.toolName;
  return "";
}

/**
 * The parent's own agent answered a sub-session (`session_human_input_respond`)
 * or steered it onto new work, which closes its open waits: the card must
 * re-read what still waits instead of waiting for the next list hint.
 */
export function isSubSessionResponseEvent(event: SessionEvent): boolean {
  if (event.type !== "agent.toolCall.output") return false;
  const name = toolName(event);
  return name.endsWith("session_human_input_respond") || name.endsWith("session_steer");
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
