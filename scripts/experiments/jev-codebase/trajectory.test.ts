import { expect, test } from "bun:test";
import {
  SourceTools,
  spanCovered,
  scoreTrajectory,
  nonnegativeAmount,
  remainingTime,
  validateCases,
  type BenchmarkCase,
} from "./trajectory";
const snapshot = {
  revision: "fixed",
  digest: "fixed",
  limited: false,
  excluded: 0,
  chunks: [
    {
      id: "e0",
      path: "a.ts",
      startLine: 1,
      endLine: 3,
      text: "const needle = 1;\nconst value = 2;\nexport { value };",
    },
  ],
};
test("source tools paginate paths and return exact bounded lines", () => {
  const t = new SourceTools(snapshot);
  expect(t.list("a", 0).paths).toEqual(["a.ts"]);
  expect(t.read("../secret", 1, 5)).toEqual({ error: "path_or_range_not_in_snapshot" });
  expect(t.read("a.ts", 2, 100)).toEqual({
    path: "a.ts",
    startLine: 2,
    endLine: 3,
    text: "const value = 2;\nexport { value };",
  });
});
test("snapshot physical blank lines are not normalized a second time", () => {
  const t = new SourceTools({
    ...snapshot,
    chunks: [{ id: "e0", path: "a.ts", startLine: 1, endLine: 3, text: "one\ntwo\n" }],
  });
  expect(t.files[0].endLine).toBe(3);
  expect(t.read("a.ts", 3, 3)).toEqual({ path: "a.ts", startLine: 3, endLine: 3, text: "" });
});
test("search is literal and no-match does not become absence proof", () => {
  const t = new SourceTools(snapshot);
  expect(t.search(["needle"]).hits[0].line).toBe(1);
  expect(t.search([".*"]).hits).toEqual([]);
});
test("span audit accepts combined ranges and rejects holes", () => {
  const span = { path: "a", startLine: 1, endLine: 3 };
  expect(
    spanCovered(span, [
      { ...span, endLine: 1 },
      { ...span, startLine: 2 },
    ]),
  ).toBe(true);
  expect(
    spanCovered(span, [
      { ...span, endLine: 1 },
      { ...span, startLine: 3 },
    ]),
  ).toBe(false);
});
test("matching abstention without evidence or a final response is not success", () => {
  const t = new SourceTools(snapshot);
  const c: BenchmarkCase = {
    id: "x",
    question: "x",
    context: "",
    mode: "evidence",
    expectedAnswer: "indecisive",
    requiredSpans: [{ path: "a.ts", startLine: 2, endLine: 3 }],
    acceptableConclusion: "value",
    category: "evidence",
    oracleRationale: "source",
  };
  expect(scoreTrajectory(c, null, [], t).evidenceAndLabelPass).toBe(false);
  expect(
    scoreTrajectory(c, { answer: "indecisive", explanation: "unknown", citations: [] }, [], t)
      .evidenceAndLabelPass,
  ).toBe(false);
  t.read("a.ts", 2, 3);
  expect(
    scoreTrajectory(
      c,
      { answer: "indecisive", explanation: "arbitrary", citations: [] },
      t.returned,
      t,
    ).evidenceAndLabelPass,
  ).toBe(false);
  expect(
    scoreTrajectory(
      c,
      {
        answer: "indecisive",
        explanation: "arbitrary",
        citations: [{ path: "a.ts", startLine: 2, endLine: 2 }],
      },
      t.returned,
      t,
    ).evidenceAndLabelPass,
  ).toBe(false);
  expect(
    scoreTrajectory(
      c,
      { answer: "indecisive", explanation: "value", citations: c.requiredSpans },
      t.returned,
      t,
    ).evidenceAndLabelPass,
  ).toBe(true);
});
test("cost fields fail closed for absent or invalid values", () => {
  for (const raw of [null, undefined, "", " ", NaN, Infinity, -1, {}, "no"])
    expect(() => nonnegativeAmount(raw)).toThrow();
  expect(nonnegativeAmount(0)).toBe(0);
  expect(nonnegativeAmount("0.002")).toBe(0.002);
});
test("absolute remaining time rejects late completion", () => {
  expect(remainingTime(100, 200, 200)).toBe(100);
  expect(() => remainingTime(100, 300, 200)).toThrow("trajectory_deadline");
});
test("empty oracle spans and duplicate cases are rejected", () => {
  const valid: BenchmarkCase = {
    id: "valid",
    question: "question",
    context: "context",
    mode: "binary",
    expectedAnswer: "no",
    requiredSpans: [{ path: "a.ts", startLine: 1, endLine: 1 }],
    category: "negative",
    acceptableConclusion: "no",
    oracleRationale: "source",
  };
  expect(() => validateCases([valid, valid])).toThrow("invalid_case");
  expect(() => validateCases([{ ...valid, mode: "evidence" }])).toThrow("invalid_case");
  expect(() => validateCases([])).toThrow();
  expect(() =>
    validateCases([
      {
        id: "x",
        question: "x",
        context: "",
        mode: "binary",
        expectedAnswer: "no",
        requiredSpans: [],
        category: "x",
        oracleRationale: "x",
        acceptableConclusion: "x",
      },
    ]),
  ).toThrow();
});
