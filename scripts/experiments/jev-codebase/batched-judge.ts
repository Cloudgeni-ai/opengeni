import { validateAnswers, type Judge, type Judgment, type Question } from "./core";
import { transientReceipt } from "./transient-failure";

/** Only validated judgments from completed batches survive an explicit metered transient. */
const partials = new WeakMap<Error, Record<string, Judgment>>();
export const partialJudgments = (error: unknown) =>
  error instanceof Error ? partials.get(error) : undefined;

/** Split only when the serialized state+questions would exceed the local cap. */
export function byteBoundedJudge(judge: Judge, maxBytes = 96000): Judge {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("invalid_byte_budget");
  return async (state, questions, signal) => {
    const fits = (qs: Record<string, Question>) =>
      Buffer.byteLength(JSON.stringify({ state, questions: qs })) <= maxBytes;
    const batches: Record<string, Question>[] = [];
    let batch: Record<string, Question> = {};
    // Plan all batches first, so an oversized state/single question fails before spending.
    for (const [id, q] of Object.entries(questions)) {
      if (!fits({ [id]: q })) throw new Error("compact_input_budget");
      if (!fits({ ...batch, [id]: q })) {
        batches.push(batch);
        batch = {};
      }
      batch[id] = q;
    }
    if (Object.keys(batch).length) batches.push(batch);
    const answers: Record<string, Judgment> = {};
    for (const qs of batches) {
      if (signal?.aborted) throw new Error("compact_deadline");
      try {
        const result = await judge(state, qs, signal);
        if (signal?.aborted) throw new Error("compact_deadline");
        validateAnswers(qs, result);
        Object.assign(answers, result);
      } catch (error) {
        if (signal?.aborted && error === signal.reason)
          throw new Error("compact_deadline", { cause: error });
        if (error instanceof Error && transientReceipt(error))
          partials.set(error, { ...answers, ...partialJudgments(error) });
        throw error;
      }
    }
    validateAnswers(questions, answers);
    return answers;
  };
}

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
