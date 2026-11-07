import { z } from "zod";
import type { DecisionQuestion, DecisionResult, DecisionUsage } from "@opengeni/decisions";

const Instructions = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);
const Question = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("predicate"),
      instructions: Instructions,
      criteria: z
        .object({ true: Instructions.optional(), false: Instructions.optional() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("choice"),
      instructions: Instructions,
      criteria: z
        .record(z.string().min(1), Instructions.nullable())
        .refine((value) => Object.keys(value).length > 0, "At least one choice is required"),
    })
    .strict(),
  z
    .object({
      type: z.literal("score"),
      instructions: Instructions,
      criteria: z.array(Instructions).min(1),
    })
    .strict(),
]);

/** No model/credential override: these endpoints use the deployment's configured categories. */
export const ModelDecisionRequest = z
  .object({
    input: z.unknown().refine((value) => value !== undefined, "input is required"),
    questions: z
      .record(z.string().min(1), Question)
      .refine((value) => Object.keys(value).length > 0, "At least one question is required"),
  })
  .strict();
export type ModelDecisionRequest<
  Q extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>,
> = {
  input: unknown;
  questions: Q;
};
export type ModelDecisionResponse<
  Q extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>,
> = {
  id: string;
  object: "decision";
  model: string;
  answers: DecisionResult<Q>["answers"];
  usage: DecisionUsage;
};

export const ModelEmbeddingsRequest = z
  .object({
    input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  })
  .strict();
export type ModelEmbeddingsRequest = z.infer<typeof ModelEmbeddingsRequest>;
export type ModelEmbeddingsResponse = {
  id: string;
  object: "list";
  model: string;
  dimensions: number;
  data: Array<{ object: "embedding"; index: number; embedding: number[] }>;
  usage: {
    inputTokens: number | null;
    totalTokens: number | null;
    requests: number;
    costUsd: number | null;
    costSource: "unknown";
  };
};
export type {
  DecisionQuestion,
  DecisionResult,
  DecisionUsage,
  DecisionAnswer,
  DecisionAnswerFor,
  DecisionRefusal,
  DecisionPredicateQuestion,
  DecisionChoiceQuestion,
  DecisionScoreQuestion,
} from "@opengeni/decisions";
