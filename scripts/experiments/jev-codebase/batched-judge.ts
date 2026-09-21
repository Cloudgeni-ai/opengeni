import { validateAnswers, type Judge, type Judgment, type Question } from "./core";

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
      const result = await judge(state, batch, signal);
      signal?.throwIfAborted();
      validateAnswers(batch, result);
      Object.assign(answers, result);
    }
    validateAnswers(questions, answers);
    return answers;
  };
}
