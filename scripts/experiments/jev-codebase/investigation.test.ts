import { expect, test } from "bun:test";
import { entryPaths, fileEvidence, investigateV3 } from "./investigation";
import type { Judge, Question, Snapshot } from "./core";

const snapshot: Snapshot = {
  revision: "fixed",
  digest: "fixed",
  excluded: 0,
  limited: false,
  chunks: [
    {
      id: "e0",
      path: "entry.ts",
      startLine: 1,
      endLine: 2,
      text: "import { send } from './send';\nexport function replay() { return send(); }",
    },
    {
      id: "e1",
      path: "send.ts",
      startLine: 1,
      endLine: 1,
      text: "export function send() { return 204; }",
    },
    {
      id: "e2",
      path: "persist.ts",
      startLine: 1,
      endLine: 1,
      text: "export function persist(store) { return store.save(); }",
    },
  ],
};
const answers = (questions: Record<string, Question>, values: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [
      id,
      {
        choice: values[id],
        probabilities: Object.fromEntries(
          Object.keys(q.criteria).map((key) => [key, key === values[id] ? 1 : 0]),
        ),
      },
    ]),
  );
const makeJudge =
  (answer = "no", support = "supported"): Judge =>
  async (_, questions) =>
    answers(
      questions,
      Object.fromEntries(
        Object.keys(questions).map((id) => [
          id,
          id === "scope"
            ? "source"
            : id === "answer"
              ? answer
              : id === "support"
                ? support
                : "keep",
        ]),
      ),
    );

test("v3 reassembles overlapping windows without duplicated source lines", () => {
  const s = {
    ...snapshot,
    chunks: [
      { id: "e0", path: "x.ts", startLine: 1, endLine: 3, text: "a\nb\nc" },
      { id: "e1", path: "x.ts", startLine: 3, endLine: 4, text: "c\nd" },
    ],
  };
  expect(fileEvidence(s)[0].text).toBe("a\nb\nc\nd");
});
test("v3 recognizes arrow-function and constant entry names", () => {
  const f = { ...snapshot.chunks[0], text: "export const useThing = () => true;" };
  expect(entryPaths([f], { question: "Does useThing return true?" })).toEqual(["entry.ts"]);
});
test("v3 gathers dependency evidence before answering and embeds actual question", async () => {
  const question = "Does replay persist its response?";
  let answerCalls = 0;
  const delegate = makeJudge();
  const r = await investigateV3(snapshot, { question }, async (state, qs, signal) => {
    if (qs.answer) {
      answerCalls++;
      expect(qs.answer.instructions.startsWith(question)).toBe(true);
      expect((state as any).evidence.map((e: any) => e.path)).toContain("send.ts");
      expect((state as any).entryPaths).toEqual(["entry.ts"]);
    }
    return delegate(state, qs, signal);
  });
  expect(answerCalls).toBe(1);
  expect(r.answer).toBe("no");
  expect(r.evidence.length).toBe(3);
});
test("v3 verification blocks a wrong-path answer and returns evidence", async () => {
  const r = await investigateV3(
    snapshot,
    { question: "Does replay persist?" },
    makeJudge("yes", "wrong_path"),
  );
  expect(r.answer).toBe("indecisive");
  expect(r.reasonCode).toBe("answer_not_verified");
  expect(r.evidence.length).toBeGreaterThan(0);
});
test("v3 missing imports block decisive answers", async () => {
  const r = await investigateV3(
    { ...snapshot, chunks: [snapshot.chunks[0]] },
    { question: "Does replay send?" },
    makeJudge("yes"),
  );
  expect(r.answer).toBe("indecisive");
  expect(r.coverage.unresolvedLocalPaths).toContain("send");
});
test("v3 evidence-only mode never asks answer or verification", async () => {
  const delegate = makeJudge();
  const r = await investigateV3(
    snapshot,
    { question: "Trace replay", requestedOutput: "evidence" },
    async (s, qs, signal) => {
      expect(qs.answer).toBeUndefined();
      expect(qs.support).toBeUndefined();
      return delegate(s, qs, signal);
    },
  );
  expect(r.answer).toBe("indecisive");
  expect(r.status).toBe("evidence_ready");
});
test("v3 explicit live configuration needs external evidence", async () => {
  const r = await investigateV3(
    snapshot,
    { question: "Does the live production deployment invoke replay?" },
    makeJudge("yes"),
  );
  expect(r.status).toBe("needs_guidance");
  expect(r.answer).toBe("indecisive");
});
test("v3 failure cannot score as a negative answer", async () => {
  const r = await investigateV3(snapshot, { question: "Does replay save?" }, async () => {
    throw new Error("offline");
  });
  expect(r.status).toBe("error");
  expect(r.answer).toBe("indecisive");
});
