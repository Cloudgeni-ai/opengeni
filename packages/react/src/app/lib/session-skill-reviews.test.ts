import { expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { sessionSkillReviews } from "./session-skill-reviews";

const operationId = "11111111-1111-4111-8111-111111111111";
const skillId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const skillReview = {
  sourceOperationId: operationId,
  skillId,
  revisionId,
  expectedRevisionId: null,
  expectedScopeVersion: 1,
};
const receipt = {
  operationId,
  skillId,
  revisionId,
  outcome: "pending",
  replayed: false,
  skillReview,
};
const event = (output: unknown) =>
  ({ type: "agent.toolCall.output", payload: { output } }) as SessionEvent;

test("discovers native, JSON, and MCP receipts and deduplicates replay", () => {
  expect(
    sessionSkillReviews([
      event(receipt),
      event(JSON.stringify(receipt)),
      event({ structuredContent: receipt }),
      event({ content: [{ type: "text", text: JSON.stringify(receipt) }] }),
    ]),
  ).toEqual([skillReview]);
});

test("ignores malformed, failed, automatic, rejected, and mismatched receipts", () => {
  expect(
    sessionSkillReviews([
      event("not json"),
      event(null),
      event({ ...receipt, outcome: "applied" }),
      event({ ...receipt, decision: "rejected" }),
      event({ isError: true, structuredContent: receipt }),
      event({ ...receipt, revisionId: operationId }),
      { type: "agent.message.completed", payload: { output: receipt } } as SessionEvent,
    ]),
  ).toEqual([]);
});

test("preserves exact removal bindings and separate proposed revisions", () => {
  const removal = { ...skillReview, revisionId: operationId, removalOperationId: operationId };
  expect(
    sessionSkillReviews([
      event(receipt),
      event({ ...receipt, revisionId: operationId, skillReview: removal }),
    ]),
  ).toEqual([skillReview, removal]);
});
