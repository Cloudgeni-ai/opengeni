import {
  DecisionRequestError,
  DecisionUnavailableError,
  validateDecisionAnswers,
  type DecisionModel,
  type DecisionQuestion,
  type DecisionUsage,
} from "@opengeni/decisions";
import { JevClient, JevRequestError, JevUnavailableError, type JevQuestion } from "./client";

/** Adapt the existing typed client without duplicating its transport/chunking policy. */
export function createJevDecisionModel(client: JevClient): DecisionModel {
  return {
    warmUp: (connections) => client.warmUp(connections),
    async decide(input, questions, options = {}) {
      const translated = Object.fromEntries(
        Object.entries(questions).map(([name, question]: [string, DecisionQuestion]) => [
          name,
          { ...question, type: question.type === "predicate" ? "noul" : question.type },
        ]),
      ) as Record<string, JevQuestion>;
      let result;
      try {
        result = await client.ask(input, translated, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.tag ? { tag: options.tag } : {}),
        });
      } catch (cause) {
        options.signal?.throwIfAborted();
        if (cause instanceof JevRequestError || cause instanceof JevUnavailableError) {
          const ErrorType =
            cause instanceof JevRequestError ? DecisionRequestError : DecisionUnavailableError;
          throw new ErrorType(
            `Decision provider could not complete the judgment${cause.status === undefined ? "" : ` (HTTP ${cause.status})`}`,
            {
              cause,
              ...(cause.status === undefined ? {} : { status: cause.status }),
              ...(cause.code === undefined ? {} : { code: cause.code }),
            },
          );
        }
        throw cause;
      }
      const usage: DecisionUsage = {
        model: result.model || client.model,
        provider: "typesafe",
        requests: result.requests,
        inputTokens: result.usage.inputTokensReported === true ? result.usage.inputTokens : null,
        outputTokens: null,
        costUsd: result.usage.inputTokensReported === true ? result.costUsd : null,
        costSource: result.usage.inputTokensReported === true ? "estimate" : "unknown",
      };
      await options.onUsage?.(usage);
      options.signal?.throwIfAborted();
      const answers = Object.fromEntries(
        Object.entries(result.answers).map(([name, answer]) => [
          name,
          answer.type === "noul"
            ? { type: "predicate", probability: answer.probability }
            : answer.type === "choice"
              ? { ...answer, choice: answer.option }
              : answer,
        ]),
      );
      return { usage, answers: validateDecisionAnswers(questions, answers) };
    },
  };
}
