import { test, expect } from "bun:test";
import { batchedJudge } from "./batched-judge";
import type { Question } from "./core";
const questions: Record<string, Question> = Object.fromEntries(
  Array.from({ length: 26 }, (_, i) => [
    `q${i}`,
    {
      type: "choice",
      instructions: "Select relevant evidence",
      criteria: { keep: "Relevant", drop: "Irrelevant" },
    },
  ]),
);
const answer = (qs: Record<string, Question>) =>
  Object.fromEntries(
    Object.keys(qs).map((id) => [id, { choice: "keep", probabilities: { keep: 1, drop: 0 } }]),
  );
test("batches retain full state and evaluate each question once", async () => {
  const state = { source: "full source and dependencies" },
    calls: string[][] = [];
  const result = await batchedJudge(async (s, qs) => {
    expect(s).toBe(state);
    calls.push(Object.keys(qs));
    return answer(qs);
  })(state, questions);
  expect(calls.map((c) => c.length)).toEqual([8, 8, 8, 2]);
  expect(calls.flat()).toEqual(Object.keys(questions));
  expect(Object.keys(result)).toEqual(Object.keys(questions));
});
test("failed batches do not silently fabricate missing judgments", async () => {
  let calls = 0;
  await expect(
    batchedJudge(async (_, qs) => {
      if (++calls === 2) throw new Error("transient_provider_unavailable");
      return answer(qs);
    })({}, questions),
  ).rejects.toThrow("transient_provider_unavailable");
  expect(calls).toBe(2);
});
test("deadline cancellation stops before another batch", async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(
    batchedJudge(async (_, qs) => {
      calls++;
      controller.abort();
      return answer(qs);
    })({}, questions, controller.signal),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
test("invalid answers and invalid batch limits fail closed", async () => {
  expect(() => batchedJudge(async () => ({}), 0)).toThrow();
  await expect(batchedJudge(async () => ({}))({}, questions)).rejects.toThrow();
});

test("cancellation during the final batch rejects late valid answers", async () => {
  const controller = new AbortController();
  await expect(
    batchedJudge(async (_, qs) => {
      controller.abort();
      return answer(qs);
    })({}, { q0: questions.q0! }, controller.signal),
  ).rejects.toThrow();
});
