import {
  CHILD_PAUSED_REASON_MAX_BYTES,
  CHILD_PROGRESS_NOTE_MAX_BYTES,
  CHILD_REQUIRES_ACTION_MAX_REQUESTS,
  CHILD_REQUIRES_ACTION_PAYLOAD_MAX_BYTES,
  CHILD_REQUIRES_ACTION_QUESTION_PREVIEW_MAX_BYTES,
  approvalIdentifier,
  type ChildPausedPayload,
  type ChildProgressPayload,
  type ChildRequiresActionPayload,
  type ChildRequiresActionRequest,
  type ChildRequiresActionResolvedPayload,
  type ChildWaitingCapacityPayload,
  type HumanInputQuestion,
} from "@opengeni/contracts";

/**
 * Child lifecycle notices (`child_requires_action`,
 * `child_requires_action_resolved`, `child_paused`, `child_waiting_capacity`,
 * `child_progress`) are produced only while this process-global flag is on.
 * The deployment value is `OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED`, parsed
 * once at boot by `@opengeni/config` (`settings.childLifecycleNoticesEnabled`)
 * and installed here by the API app and both worker roles. Rolling hazard: a
 * worker from before these kinds existed throws in `mapSessionSystemUpdate`
 * on an unknown kind, so the flag stays off until the whole fleet runs a new
 * image. Delivery and consumption of an already committed notice never read
 * the flag; only production does.
 */
let childLifecycleNoticesEnabledFlag = false;

export function configureChildLifecycleNotices(input: { enabled: boolean }): void {
  childLifecycleNoticesEnabledFlag = input.enabled === true;
}

export function childLifecycleNoticesEnabled(): boolean {
  return childLifecycleNoticesEnabledFlag;
}

/** Bounded UTF-8 prefix with an explicit marker; never splits a code point. */
export function boundedChildNoticeText(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  const marker = "…";
  const budget = Math.max(0, maxBytes - encoder.encode(marker).byteLength);
  let end = Math.min(budget, bytes.byteLength);
  while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: `${new TextDecoder().decode(bytes.subarray(0, end))}${marker}`, truncated: true };
}

export const CHILD_LIFECYCLE_DEDUPE_PREFIX = {
  requiresAction: "child-requires-action",
  requiresActionResolved: "child-requires-action-resolved",
  paused: "child-paused",
  waitingCapacity: "child-waiting-capacity",
  progress: "child-progress",
} as const;

export function childRequiresActionDedupeKey(input: {
  childSessionId: string;
  turnId: string;
  turnGeneration: number;
}): string {
  return `${CHILD_LIFECYCLE_DEDUPE_PREFIX.requiresAction}:${input.childSessionId}:${input.turnId}:${input.turnGeneration}`;
}

export function childRequiresActionResolvedDedupeKey(input: {
  childSessionId: string;
  turnId: string;
  turnGeneration: number;
  requestId: string | null;
  approvalId: string | null;
}): string {
  return `${CHILD_LIFECYCLE_DEDUPE_PREFIX.requiresActionResolved}:${input.childSessionId}:${input.turnId}:${input.turnGeneration}:${input.requestId ?? input.approvalId ?? "unknown"}`;
}

export function childPausedDedupeKey(input: { childSessionId: string; receiptId: string }): string {
  return `${CHILD_LIFECYCLE_DEDUPE_PREFIX.paused}:${input.childSessionId}:${input.receiptId}`;
}

export function childWaitingCapacityDedupeKey(input: {
  childSessionId: string;
  waiterId: string;
}): string {
  return `${CHILD_LIFECYCLE_DEDUPE_PREFIX.waitingCapacity}:${input.childSessionId}:${input.waiterId}`;
}

export function childProgressDedupeKey(input: {
  childSessionId: string;
  receiptId: string;
}): string {
  return `${CHILD_LIFECYCLE_DEDUPE_PREFIX.progress}:${input.childSessionId}:${input.receiptId}`;
}

/** Bounded, secret-free tool name of a serialized SDK approval interruption. */
function approvalToolName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const approval = value as Record<string, unknown>;
  const rawItem =
    approval.rawItem && typeof approval.rawItem === "object"
      ? (approval.rawItem as Record<string, unknown>)
      : null;
  const candidate = rawItem?.name ?? approval.name;
  return typeof candidate === "string" && candidate.length > 0
    ? boundedChildNoticeText(candidate, 128).text
    : null;
}

/**
 * Build the bounded child_requires_action payload from the child's frozen
 * human-input requests and pending approvals. Only typed, content-free facts
 * plus one bounded first-question preview per request cross to the parent:
 * never subject ids, credentials, or raw tool arguments. The whole payload
 * stays within CHILD_REQUIRES_ACTION_PAYLOAD_MAX_BYTES by dropping trailing
 * requests and recording `truncated`.
 */
export function buildChildRequiresActionPayload(input: {
  childSessionId: string;
  childTurnId: string;
  childTurnGeneration: number;
  humanInputRequests: ReadonlyArray<{
    id: string;
    questions: readonly HumanInputQuestion[];
    allowSkip: boolean;
    expiresAt?: Date | null;
  }>;
  pendingApprovals: readonly unknown[];
}): ChildRequiresActionPayload {
  const requests: ChildRequiresActionRequest[] = [];
  for (const request of input.humanInputRequests) {
    const first = request.questions[0];
    requests.push({
      kind: "human_input",
      requestId: request.id,
      questionCount: request.questions.length,
      firstQuestion: boundedChildNoticeText(
        typeof first?.prompt === "string" ? first.prompt : "",
        CHILD_REQUIRES_ACTION_QUESTION_PREVIEW_MAX_BYTES,
      ).text,
      allowSkip: request.allowSkip,
      expiresAt: request.expiresAt ? request.expiresAt.toISOString() : null,
    });
  }
  const seenApprovals = new Set<string>();
  for (const pending of input.pendingApprovals) {
    const approvalId = approvalIdentifier(pending);
    if (!approvalId || seenApprovals.has(approvalId)) continue;
    seenApprovals.add(approvalId);
    requests.push({
      kind: "approval",
      approvalId: boundedChildNoticeText(approvalId, 256).text,
      toolName: approvalToolName(pending),
    });
  }
  let truncated = requests.length > CHILD_REQUIRES_ACTION_MAX_REQUESTS;
  let bounded = requests.slice(0, CHILD_REQUIRES_ACTION_MAX_REQUESTS);
  const build = (): ChildRequiresActionPayload => ({
    type: "child_requires_action",
    childSessionId: input.childSessionId,
    childTurnId: input.childTurnId,
    childTurnGeneration: input.childTurnGeneration,
    requests: bounded,
    truncated,
  });
  let payload = build();
  while (
    bounded.length > 0 &&
    Buffer.byteLength(JSON.stringify(payload)) > CHILD_REQUIRES_ACTION_PAYLOAD_MAX_BYTES
  ) {
    bounded = bounded.slice(0, -1);
    truncated = true;
    payload = build();
  }
  return payload;
}

export function childRequiresActionSummary(
  childSessionId: string,
  payload: ChildRequiresActionPayload,
): string {
  const humanInputs = payload.requests.filter((request) => request.kind === "human_input");
  const approvals = payload.requests.filter((request) => request.kind === "approval");
  const first = humanInputs[0];
  const lines = [
    `Worker ${childSessionId} is blocked and needs input (turn ${payload.childTurnId}).`,
  ];
  if (first && first.kind === "human_input") {
    lines.push(
      `It asked: ${first.firstQuestion}${first.questionCount > 1 ? ` (+${first.questionCount - 1} more question${first.questionCount > 2 ? "s" : ""})` : ""}${humanInputs.length > 1 ? ` [${humanInputs.length} open requests]` : ""}.`,
    );
  }
  if (approvals.length > 0) {
    const names = approvals
      .map((request) => (request.kind === "approval" ? request.toolName : null))
      .filter((name): name is string => name !== null);
    lines.push(
      `${approvals.length} tool approval${approvals.length > 1 ? "s are" : " is"} waiting for a human${names.length > 0 ? ` (${names.join(", ")})` : ""}.`,
    );
  }
  if (payload.truncated) lines.push("The request list was truncated.");
  return lines.join(" ");
}

export function childRequiresActionResolvedSummary(
  childSessionId: string,
  payload: ChildRequiresActionResolvedPayload,
): string {
  const subject = payload.requestId ? "input request" : "approval";
  return `Worker ${childSessionId}: its ${subject} was ${payload.outcome} (by ${payload.respondedByKind.replace("_", " ")}); the worker is no longer blocked on it.`;
}

export function childPausedSummary(childSessionId: string, payload: ChildPausedPayload): string {
  const base = `Worker ${childSessionId} was paused by ${payload.actorKind === "agent" ? "an agent" : payload.actorKind === "api" ? "the API" : "a human"}.`;
  return payload.reason ? `${base} Reason: ${payload.reason}` : base;
}

export function childWaitingCapacitySummary(
  childSessionId: string,
  payload: ChildWaitingCapacityPayload,
): string {
  return `Worker ${childSessionId} is waiting for ${payload.provider === "codex" ? "Codex" : "xAI"} provider capacity${payload.nextCheckAt ? ` (next check ${payload.nextCheckAt})` : ""}; its turn resumes automatically.`;
}

export function childProgressSummary(
  childSessionId: string,
  payload: ChildProgressPayload,
): string {
  return `Worker ${childSessionId} progress: ${payload.progressNote}`;
}

export function boundedChildPausedReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined || reason.length === 0) return null;
  return boundedChildNoticeText(reason, CHILD_PAUSED_REASON_MAX_BYTES).text;
}

export function boundedChildProgressNote(note: string): string {
  return boundedChildNoticeText(note, CHILD_PROGRESS_NOTE_MAX_BYTES).text;
}
