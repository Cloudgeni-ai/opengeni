/** Shared typed judgments. Consumers own rubrics and thresholds; providers own inference. */
export type DecisionInstructions = string | Record<string, unknown> | unknown[];
export type DecisionPredicateQuestion = {
  type: "predicate";
  instructions: DecisionInstructions;
  criteria?: { true?: DecisionInstructions; false?: DecisionInstructions };
};
export type DecisionChoiceQuestion = {
  type: "choice";
  instructions: DecisionInstructions;
  criteria: Record<string, DecisionInstructions | null>;
};
export type DecisionScoreQuestion = {
  type: "score";
  instructions: DecisionInstructions;
  criteria: DecisionInstructions[];
};
export type DecisionQuestion =
  | DecisionPredicateQuestion
  | DecisionChoiceQuestion
  | DecisionScoreQuestion;
export type DecisionRefusal = { type: "refusal"; reason?: string };
export type DecisionPredicateAnswer = { type: "predicate"; probability: number };
export type DecisionChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};
export type DecisionScoreAnswer = {
  type: "score";
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
};
export type DecisionAnswer =
  | DecisionPredicateAnswer
  | DecisionChoiceAnswer
  | DecisionScoreAnswer
  | DecisionRefusal;
export type DecisionAnswerFor<Q> =
  | DecisionRefusal
  | (Q extends DecisionPredicateQuestion
      ? DecisionPredicateAnswer
      : Q extends DecisionChoiceQuestion
        ? DecisionChoiceAnswer
        : DecisionScoreAnswer);

export type DecisionUsage = {
  model: string;
  provider: string;
  requestId?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Successful chunks, not retry attempts. */
  requests: number;
  costUsd: number | null;
  costSource: "provider-reported" | "estimate" | "unknown";
};
export type DecisionOptions = {
  signal?: AbortSignal;
  tag?: string;
  /** Called even when a received answer is invalid. Never reconstructed on history replay. */
  onUsage?: (usage: DecisionUsage) => void | Promise<void>;
};
export type DecisionResult<
  Q extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>,
> = {
  answers: { [K in keyof Q]: DecisionAnswerFor<Q[K]> };
  usage: DecisionUsage;
};
export interface DecisionModel {
  decide<Q extends Record<string, DecisionQuestion>>(
    input: unknown,
    questions: Q,
    options?: DecisionOptions,
  ): Promise<DecisionResult<Q>>;
  /** Optional provider preparation; existing code-search behavior, not required by callers. */
  warmUp?(connections: number): void;
}

export function predicate(
  instructions: DecisionInstructions,
  criteria?: DecisionPredicateQuestion["criteria"],
): DecisionPredicateQuestion {
  return criteria
    ? { type: "predicate", instructions, criteria }
    : { type: "predicate", instructions };
}

export class DecisionError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
  }
}
export class DecisionUnavailableError extends DecisionError {}
export class DecisionRequestError extends DecisionError {}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const probability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Validate the complete named answer set, not a convenient partial selection. */
export function validateDecisionAnswers<Q extends Record<string, DecisionQuestion>>(
  questions: Q,
  answers: unknown,
): DecisionResult<Q>["answers"] {
  const invalid = () => {
    throw new DecisionUnavailableError("Decision model returned invalid typed answers");
  };
  if (!isRecord(answers)) return invalid();
  const names = Object.keys(questions);
  if (Object.keys(answers).length !== names.length) return invalid();
  for (const name of names) {
    const answer = answers[name];
    const question = questions[name]!;
    if (!isRecord(answer)) return invalid();
    if (answer.type === "refusal") {
      if (answer.reason !== undefined && typeof answer.reason !== "string") return invalid();
      continue;
    }
    if (answer.type !== question.type) return invalid();
    if (question.type === "predicate" && !probability(answer.probability)) return invalid();
    if (
      question.type === "choice" &&
      (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice))
    )
      return invalid();
    if (
      question.type === "score" &&
      (typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.criteria.length - 1)
    )
      return invalid();
    if (answer.confidence !== undefined && !probability(answer.confidence)) return invalid();
    if (answer.probabilities !== undefined) {
      if (
        !isRecord(answer.probabilities) ||
        Object.values(answer.probabilities).some((p) => !probability(p))
      )
        return invalid();
      const allowed =
        question.type === "choice"
          ? Object.keys(question.criteria)
          : question.type === "score"
            ? question.criteria.map((_, i) => String(i))
            : [];
      if (Object.keys(answer.probabilities).some((key) => !allowed.includes(key))) return invalid();
    }
  }
  return answers as DecisionResult<Q>["answers"];
}
