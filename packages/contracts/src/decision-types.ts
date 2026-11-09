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
export type DecisionResult<
  Q extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>,
> = {
  answers: { [K in keyof Q]: DecisionAnswerFor<Q[K]> };
  usage: DecisionUsage;
};
