import { siteSessionEventProjection } from "./session-events";

/**
 * Site-safe views of the session reads and command results a published
 * Site's viewer gets back: the conversation's own text, states and versions,
 * never the workspace behind it (account and workspace ids, workflow and
 * attempt ids, tools, sandboxes, metadata, lineage, initiators, people's
 * subject ids, pause reasons, credentials or human-input answers). Each view
 * keeps the field shapes the SDK expects, with empty lists and objects where
 * a field is withheld. Event pages and streams use the event projection in
 * `session-events.ts`; sessions use `siteSessionProjection`.
 */

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pick(value: Fields, keys: readonly string[]): Fields {
  const out: Fields = {};
  for (const key of keys) if (Object.hasOwn(value, key)) out[key] = value[key];
  return out;
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

const CONTROL_FIELDS = [
  "state",
  "controlVersion",
  "controlEtag",
  "directState",
  "additionalBlockerCount",
  "settlement",
  "backgroundCommandSettlement",
] as const;

/** What holds a conversation, without who did it, why, or which other sessions. */
function siteControlBlocker(value: unknown): Fields | null {
  const blocker = fields(value);
  if (!blocker) return null;
  const workspace = blocker.kind === "workspace";
  return {
    kind: workspace ? "workspace" : "session",
    displayName: workspace ? "Workspace" : "Conversation",
    actor: null,
    reason: null,
    changedAt: typeof blocker.changedAt === "string" ? blocker.changedAt : null,
    revision: typeof blocker.revision === "number" ? blocker.revision : 0,
  };
}

/** A conversation's effective control: its state and versions, and a resume of itself only. */
export function siteControlView(value: unknown): Fields | null {
  const control = fields(value);
  if (!control) return null;
  const resumeOptions = list(control.resumeOptions)
    .map(fields)
    .filter(present)
    .filter((option) => option.scope === "session")
    .map((option) => ({
      scope: "session",
      selectedStateAfter: option.selectedStateAfter,
      impactCopy: "Resume this conversation.",
    }));
  return {
    ...pick(control, CONTROL_FIELDS),
    primaryBlocker: siteControlBlocker(control.primaryBlocker),
    blockers: list(control.blockers).map(siteControlBlocker).filter(present),
    resumeOptions,
    override: null,
  };
}

const TURN_FIELDS = [
  "id",
  "sessionId",
  "status",
  "source",
  "position",
  "prompt",
  "model",
  "reasoningEffort",
  "latencyMode",
  "version",
  "startedAt",
  "finishedAt",
  "createdAt",
  "updatedAt",
] as const;

/** A turn: its message text, model, place and state. */
export function siteTurnView(value: unknown): Fields | null {
  const turn = fields(value);
  if (!turn) return null;
  return {
    ...pick(turn, TURN_FIELDS),
    annotations: [],
    resources: [],
    tools: [],
    metadata: {},
    lineage: {},
    personalConnections: [],
    personalResources: null,
    cancelledBy: null,
    cancelReason: null,
  };
}

/** The conversation's queue: its own turns, without machine inputs. */
export function siteQueueView(value: unknown): Fields | null {
  const queue = fields(value);
  if (!queue) return null;
  return {
    version: queue.version,
    effectiveControl: siteControlView(queue.effectiveControl),
    activePersonalConnections: [],
    stoppingPreviousAttempt: queue.stoppingPreviousAttempt === true,
    items: list(queue.items).map(siteTurnView).filter(present),
    pendingInputs: [],
    pendingInputAttachment: null,
  };
}

const DRAFT_FIELDS = [
  "revision",
  "text",
  "model",
  "reasoningEffort",
  "latencyMode",
  "sourceTurnId",
  "sourceTurnVersion",
  "updatedAt",
] as const;

/** A composer draft: text and model only (Site drafts carry nothing else). */
export function siteDraftView(value: unknown): Fields | null {
  const draft = fields(value);
  if (!draft) return null;
  return { ...pick(draft, DRAFT_FIELDS), annotations: [], resources: [] };
}

const RECEIPT_FIELDS = [
  "id",
  "action",
  "operationKey",
  "targetSessionId",
  "targetTurnId",
  "appliedControlRevision",
  "appliedQueueVersion",
  "appliedTurnVersion",
  "appliedDraftRevision",
  "createdAt",
] as const;

function siteReceiptView(value: unknown): Fields | null {
  const receipt = fields(value);
  return receipt ? pick(receipt, RECEIPT_FIELDS) : null;
}

const QUESTION_FIELDS = [
  "id",
  "kind",
  "prompt",
  "label",
  "helpText",
  "options",
  "required",
  "allowOther",
  "validation",
] as const;

const HUMAN_INPUT_FIELDS = [
  "id",
  "sessionId",
  "turnId",
  "status",
  "allowSkip",
  "respondedAt",
  "expiresAt",
  "createdAt",
  "updatedAt",
] as const;

/**
 * A human-input request: its questions without secret specs or review
 * references, and never the answers or who gave them (a Site does not
 * answer; answers belong to whoever did, in the console).
 */
export function siteHumanInputRequestView(value: unknown): Fields | null {
  const request = fields(value);
  if (!request) return null;
  return {
    ...pick(request, HUMAN_INPUT_FIELDS),
    questions: list(request.questions)
      .map(fields)
      .filter(present)
      .map((question) => pick(question, QUESTION_FIELDS)),
    response: null,
    respondedBy: null,
  };
}

/** `{ requests }` from the human-input list. */
export function siteHumanInputListView(value: unknown): Fields {
  return {
    requests: list(fields(value)?.requests).map(siteHumanInputRequestView).filter(present),
  };
}

/** A queue command result (move, edit, delete, steer). */
export function siteQueueMutationView(value: unknown): Fields | null {
  const result = fields(value);
  if (!result) return null;
  return {
    receipt: siteReceiptView(result.receipt),
    snapshot: siteQueueView(result.snapshot),
    ...(result.draft === undefined ? {} : { draft: siteDraftView(result.draft) }),
  };
}

/** An accepted message (composer submit, steer): the event, turn and routing. */
export function siteAcceptedMessageView(value: unknown): Fields | null {
  const result = fields(value);
  if (!result) return null;
  return {
    accepted: siteSessionEventProjection(result.accepted),
    turn: siteTurnView(result.turn),
    ...(result.draft === undefined ? {} : { draft: siteDraftView(result.draft) }),
    receipt: siteReceiptView(result.receipt),
    ...pick(result, ["routing", "interruptionCount", "replay"]),
  };
}

/** A control result: the receipt and the conversation's control. */
export function siteControlResultView(value: unknown): Fields | null {
  const result = fields(value);
  if (!result) return null;
  return {
    receipt: siteReceiptView(result.receipt),
    effectiveControl: siteControlView(result.effectiveControl),
    ...pick(result, [
      "interruptionCount",
      "wakeCount",
      "cancelledSessionCount",
      "cancelledTurnCount",
    ]),
  };
}

/** An accepted event (`POST /events`): the Site event projection. */
export function siteAcceptedEventView(value: unknown): Fields | null {
  return siteSessionEventProjection(value);
}
