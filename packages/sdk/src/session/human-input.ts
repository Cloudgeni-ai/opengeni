import type {
  HumanInputAnswer,
  HumanInputQuestion,
  SessionEvent,
  SessionHumanInputRequest,
} from "../types";

export type HumanInputAnswerDraft = Readonly<{
  values: readonly string[];
  other: string;
  otherSelected: boolean;
}>;

export type HumanInputValidationMessages = Readonly<{
  required: string;
  otherRequired: string;
  minSelections(count: number): string;
  maxSelections(count: number): string;
}>;

export const DEFAULT_HUMAN_INPUT_VALIDATION_MESSAGES: HumanInputValidationMessages = Object.freeze({
  required: "This question is required.",
  otherRequired: "Enter a value for Other.",
  minSelections: (count) => `Choose at least ${count} option${count === 1 ? "" : "s"}.`,
  maxSelections: (count) => `Choose no more than ${count} option${count === 1 ? "" : "s"}.`,
});

export type HumanInputValidationResult = Readonly<{
  answers: HumanInputAnswer[];
  errors: Readonly<Record<string, string>>;
}>;

/**
 * Validate framework-owned drafts without normalizing away exact answer text.
 * Optional unanswered questions are omitted; selected Other text is retained
 * byte-for-byte after whitespace is used only to decide whether it is present.
 */
export function answersFromHumanInputDrafts(
  questions: readonly HumanInputQuestion[],
  drafts: Readonly<Record<string, HumanInputAnswerDraft | undefined>>,
  messageOverrides: Partial<HumanInputValidationMessages> = {},
): HumanInputValidationResult {
  const messages = { ...DEFAULT_HUMAN_INPUT_VALIDATION_MESSAGES, ...messageOverrides };
  const answers: HumanInputAnswer[] = [];
  const errors: Record<string, string> = {};
  for (const question of questions) {
    const draft = drafts[question.id] ?? emptyHumanInputAnswerDraft();
    const values = question.kind === "text" ? draft.values.filter(Boolean) : [...draft.values];
    const other = draft.otherSelected ? draft.other : "";
    const hasOther = Boolean(other.trim());
    const supplied = values.length + (hasOther ? 1 : 0);

    if (question.kind !== "text" && draft.otherSelected && !hasOther) {
      errors[question.id] = messages.otherRequired;
      continue;
    }
    if (question.required && supplied === 0) {
      errors[question.id] = messages.required;
      continue;
    }
    if (question.kind !== "text") {
      const min = question.validation?.minSelections;
      const max = question.kind === "single_select" ? 1 : question.validation?.maxSelections;
      if (min != null && supplied < min) {
        errors[question.id] = messages.minSelections(min);
        continue;
      }
      if (max != null && supplied > max) {
        errors[question.id] = messages.maxSelections(max);
        continue;
      }
    }
    if (supplied > 0) {
      answers.push({
        questionId: question.id,
        values,
        ...(hasOther ? { other } : {}),
      });
    }
  }
  return Object.freeze({ answers, errors: Object.freeze(errors) });
}

export function emptyHumanInputAnswerDraft(): HumanInputAnswerDraft {
  return Object.freeze({ values: Object.freeze([]), other: "", otherSelected: false });
}

/** Minimal actionable request shape available from the durable event log. */
export type PendingHumanInputRequest = {
  id: string;
  turnId: string | null;
  questions: HumanInputQuestion[];
  allowSkip: boolean;
  expiresAt: string | null;
};

/** A pending row stops being actionable at its durable deadline, even before refresh. */
export function isActionableHumanInputRequest(
  request: Pick<SessionHumanInputRequest, "status" | "expiresAt">,
  nowMs = Date.now(),
): boolean {
  if (request.status !== "pending") return false;
  if (!request.expiresAt) return true;
  const deadline = Date.parse(request.expiresAt);
  return Number.isFinite(deadline) && deadline > nowMs;
}

/** Parse one generic `session.humanInput.requested` event defensively. */
export function humanInputRequestFromEvent(
  event: Pick<SessionEvent, "type" | "payload" | "turnId">,
): PendingHumanInputRequest | null {
  if (event.type !== "session.humanInput.requested" || !isRecord(event.payload)) return null;
  const request = event.payload.request;
  if (!isRecord(request) || typeof request.id !== "string" || !Array.isArray(request.questions)) {
    return null;
  }
  return {
    id: request.id,
    turnId: event.turnId ?? null,
    questions: request.questions as HumanInputQuestion[],
    allowSkip: request.allowSkip === true,
    expiresAt: typeof request.expiresAt === "string" ? request.expiresAt : null,
  };
}

/**
 * Fold a durable event log into the structured requests that are actionable
 * now. Responses remove one request; a terminal owning turn clears any
 * unresolved requests that died with it. Replaying history cannot resurrect a
 * previously answered card.
 */
export function projectPendingHumanInputRequests(
  events: SessionEvent[],
): PendingHumanInputRequest[] {
  const pending = new Map<string, PendingHumanInputRequest>();
  for (const event of events) {
    const requested = humanInputRequestFromEvent(event);
    if (requested) {
      pending.set(requested.id, requested);
      continue;
    }
    if (event.type === "user.humanInputResponse" && isRecord(event.payload)) {
      if (typeof event.payload.requestId === "string") pending.delete(event.payload.requestId);
      continue;
    }
    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled"
    ) {
      for (const [id, request] of pending) {
        if (
          request.turnId === null ||
          event.turnId === null ||
          event.turnId === undefined ||
          request.turnId === event.turnId
        ) {
          pending.delete(id);
        }
      }
    }
  }
  return [...pending.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
