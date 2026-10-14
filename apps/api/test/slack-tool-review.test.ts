import { expect, test } from "bun:test";
import { toolReviewAction, toolReviewFields, type ToolActionReview } from "@opengeni/contracts";
import {
  slackToolReviewBlocks,
  slackToolReviewCanDecide,
} from "../src/integrations/slack-tool-review";
const args = {
  messageIds: ["synthetic-1", "synthetic-2"],
  addLabelIds: ["TRASH", "STARRED"],
  removeLabelIds: ["INBOX"],
  apiKey: "secret-canary",
};
const review: ToolActionReview = {
  version: 1,
  id: "synthetic",
  revision: "1",
  actionDigest: "a".repeat(64),
  status: "pending",
  ...toolReviewAction("batch_modify_messages", args, { kind: "gmail" }),
  ...toolReviewFields(args),
  reason: "Your permission setting is Ask.",
  accountLabel: "Private account canary",
  createdAt: "",
  updatedAt: "",
  availableActions: ["approve", "reject"],
  detailsAvailable: true,
  samples: [
    { id: "synthetic-1", title: "<@everyone> synthetic subject", provenance: "provider_metadata" },
  ],
};
test("private Slack projection keeps shared consequences and treats mail as plain text", () => {
  const blocks = slackToolReviewBlocks(review, true);
  const json = JSON.stringify(blocks);
  for (const text of [
    "Move 2 messages to Trash",
    "Add star",
    "Remove from Inbox",
    "Private account canary",
  ])
    expect(json).toContain(text);
  expect(json).not.toContain("secret-canary");
  expect(
    blocks.every((block) => block.type === "section" && block.text.type === "plain_text"),
  ).toBe(true);
});
test("shared Slack conversations reveal no account, selected item or tool facts", () => {
  const json = JSON.stringify(slackToolReviewBlocks(review, false));
  for (const value of ["Private account canary", "synthetic", "TRASH", "Move 2 messages"])
    expect(json).not.toContain(value);
  expect(json).toContain("private details");
});
test("review post facts and eligibility remain stable after a decision", () => {
  const settled: ToolActionReview = {
    ...review,
    status: "rejected",
    availableActions: [],
    revision: "new",
    updatedAt: "later",
  };
  expect(slackToolReviewCanDecide(settled)).toBe(slackToolReviewCanDecide(review));
  expect(slackToolReviewBlocks(settled, true)).toEqual(slackToolReviewBlocks(review, true));
});
test("a single oversized fact links to complete review rather than truncating or failing delivery", () => {
  const oversized = { ...review, effects: ["x".repeat(2801)] };
  expect(slackToolReviewCanDecide(oversized)).toBe(false);
  expect(JSON.stringify(slackToolReviewBlocks(oversized, true))).not.toContain("x".repeat(2801));
});
