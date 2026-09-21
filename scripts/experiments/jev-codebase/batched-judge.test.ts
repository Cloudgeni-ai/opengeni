import { test, expect } from "bun:test";
import { batchedJudge, byteBoundedJudge, partialJudgments } from "./batched-judge";
import { journaledTransientFailure } from "./transient-failure";
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
test("byte-bounded batches preserve full state and cover every question exactly once", async () => {
  const state = { source: "x".repeat(100) },
    seen: string[] = [];
  const r = await byteBoundedJudge(async (s, qs) => {
    expect(s).toBe(state);
    expect(Buffer.byteLength(JSON.stringify({ state: s, questions: qs }))).toBeLessThanOrEqual(550);
    seen.push(...Object.keys(qs));
    return answer(qs);
  }, 550)(state, questions);
  expect(seen).toEqual(Object.keys(questions));
  expect(Object.keys(r)).toEqual(seen);
});
test("byte budget is preflighted before any call, even when a later question is too large", async () => {
  let calls = 0;
  await expect(
    byteBoundedJudge(async (_, qs) => {
      calls++;
      return answer(qs);
    }, 550)({}, { ...questions, huge: { ...questions.q0, instructions: "x".repeat(1000) } }),
  ).rejects.toThrow("compact_input_budget");
  expect(calls).toBe(0);
});
test("nested byte/count batches retain only completed judgments on a branded failure", async () => {
  const error = journaledTransientFailure(
    "nested",
    [
      { id: "nested", kind: "started", reservedUsd: 0.01 },
      { id: "nested", kind: "failed", statusCode: 503 },
      { kind: "transient_reserved", failedId: "nested", reservedUsd: 0.01 },
    ],
    new Error("503"),
  );
  let calls = 0;
  await expect(
    byteBoundedJudge(
      batchedJudge(async (_, qs) => {
        if (++calls === 4) throw error;
        return answer(qs);
      }, 1),
      420,
    )({}, questions),
  ).rejects.toBe(error);
  expect(Object.keys(partialJudgments(error)!)).toEqual(["q0", "q1", "q2"]);
});
test("cancellation after a completed byte batch yields before another call", async () => {
  const ac = new AbortController();
  let calls = 0;
  await expect(
    byteBoundedJudge(async (_, qs) => {
      calls++;
      ac.abort();
      return answer(qs);
    }, 420)({}, questions, ac.signal),
  ).rejects.toThrow("compact_deadline");
  expect(calls).toBe(1);
});
test("nested cancellation becomes a controller deadline without another call", async () => {
  const ac = new AbortController();
  let calls = 0;
  await expect(
    byteBoundedJudge(
      batchedJudge(async (_, qs) => {
        calls++;
        ac.abort();
        return answer(qs);
      }, 1),
      420,
    )({}, questions, ac.signal),
  ).rejects.toThrow("compact_deadline");
  expect(calls).toBe(1);
});
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
