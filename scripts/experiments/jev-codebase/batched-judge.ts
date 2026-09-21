import { validateAnswers, type Judge, type Judgment, type Question } from "./core";
import { transientReceipt } from "./transient-failure";

/** Only validated judgments from completed batches survive an explicit metered transient. */
const partials = new WeakMap<Error, Record<string, Judgment>>();
export const partialJudgments = (error: unknown) =>
  error instanceof Error ? partials.get(error) : undefined;

/** Questions are independent; every batch retains the identical full state. */
export function batchedJudge(judge: Judge, maxQuestions = 8): Judge {
  if (!Number.isInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > 32)
    throw new Error("invalid_question_batch");
  return async (state, questions, signal) => {
    const entries = Object.entries(questions),
      answers: Record<string, Judgment> = {};
    for (let offset = 0; offset < entries.length; offset += maxQuestions) {
      signal?.throwIfAborted();
      const batch: Record<string, Question> = Object.fromEntries(
        entries.slice(offset, offset + maxQuestions),
      );
      let result: Record<string, Judgment>;
      try {
        result = await judge(state, batch, signal);
      } catch (error) {
        if (error instanceof Error && transientReceipt(error)) partials.set(error, { ...answers });
        throw error;
      }
      signal?.throwIfAborted();
      validateAnswers(batch, result);
      Object.assign(answers, result);
    }
    validateAnswers(questions, answers);
    return answers;
  };
}
