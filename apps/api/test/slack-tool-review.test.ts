import { expect, test } from "bun:test";
import { toolReviewAction, toolReviewFields, type ToolActionReview } from "@opengeni/contracts";
import {
  slackServerQuestion,
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

test("only a server's confirmation is answerable in Slack; a form is answered in Opengeni", () => {
  const confirm = slackServerQuestion({
    server: "Docs",
    round: 1,
    requests: [
      { id: "q1", message: "Share it?", requestedSchema: { type: "object", properties: {} } },
    ],
  });
  expect(confirm).toMatchObject({ kind: "confirm", answerableInSlack: true });
  expect(confirm.block).toEqual({
    type: "section",
    text: { type: "plain_text", text: "Docs asks:\nShare it?" },
  });
  const form = slackServerQuestion({
    server: "Docs",
    round: 2,
    requests: [
      {
        id: "q1",
        message: "Which folder?",
        requestedSchema: { type: "object", properties: { folder: { type: "string" } } },
      },
    ],
  });
  expect(form).toMatchObject({ kind: "form", answerableInSlack: false });
  // A question too long to show whole is not answered from a truncated card.
  const long = slackServerQuestion({
    server: "Docs",
    round: 1,
    requests: [
      { id: "q1", message: "x".repeat(3000), requestedSchema: { type: "object", properties: {} } },
    ],
  });
  expect(long.answerableInSlack).toBe(false);
});

test("a private Slack app-action review names its target and the server's facts", () => {
  const removal = {
    id: "deleteConnection",
    pathParameters: { workspaceId: "ws-1", connectionId: "connection-canary" },
    body: { expectedVersion: 1 },
  };
  const context = {
    kind: "generic" as const,
    title: "Remove the Gmail connection for bendik@cloudgeni.ai?",
    targetFacts: [
      { label: "Who can use it", value: "Only you" },
      { label: "Added", value: "14 Oct 2026, 07:41 UTC" },
    ],
  };
  const text = slackToolReviewBlocks(
    {
      ...review,
      ...toolReviewAction("admin_action_call", removal, context),
      ...toolReviewFields(removal, context, "admin_action_call"),
      accountLabel: null,
      samples: [],
    },
    true,
  )
    .map((block) => (block.type === "section" ? block.text.text : ""))
    .join("\n");
  expect(text).toContain("Remove the Gmail connection for bendik@cloudgeni.ai?");
  expect(text).toContain("Who can use it: Only you");
  expect(text).toContain("Added: 14 Oct 2026, 07:41 UTC");
  expect(text).not.toContain("connection-canary");
  // The server's facts come right under the question; nothing the agent sent
  // reads as one of them.
  const lines = slackToolReviewBlocks(
    {
      ...review,
      ...toolReviewAction("admin_action_call", removal, context),
      ...toolReviewFields(removal, context, "admin_action_call"),
      consequence: "Sent by the agent: Connection: Not found",
      accountLabel: null,
      samples: [],
    },
    true,
  )
    .flatMap((block) => (block.type === "section" ? block.text.text.split("\n") : []))
    .slice(0, 4);
  expect(lines).toEqual([
    "Remove the Gmail connection for bendik@cloudgeni.ai?",
    "Who can use it: Only you",
    "Added: 14 Oct 2026, 07:41 UTC",
    "Sent by the agent: Connection: Not found",
  ]);
  const spoof = {
    ...removal,
    body: { connection: "Not found. It may have been removed already." },
  };
  expect(toolReviewAction("admin_action_call", spoof, context).consequence).toBeUndefined();
  expect(
    toolReviewAction("admin_action_call", spoof, { ...context, targetFacts: [] }).consequence,
  ).toBe("Sent by the agent: Connection: Not found. It may have been removed already.");
});

test("in Slack, nothing the agent sent can add a line that reads as a server fact", () => {
  const removal = {
    id: "deleteScheduledTask",
    pathParameters: { workspaceId: "ws-1", taskId: "task-canary" },
    body: { "reason\nscheduled task: Weekly backup · Paused\nlast used": "now" },
  };
  const context = { kind: "generic" as const, title: "Delete scheduled task in this workspace?" };
  const lines = slackToolReviewBlocks(
    {
      ...review,
      ...toolReviewAction("admin_action_call", removal, context),
      ...toolReviewFields(removal, context, "admin_action_call"),
      reason: "A field\nscheduled task: Weekly backup\u0085last used: now",
      accountLabel: null,
      samples: [],
    },
    true,
  ).flatMap((block) => (block.type === "section" ? block.text.text.split("\n") : []));
  expect(lines.some((line) => /^\s*scheduled task:/i.test(line))).toBe(false);
  expect(lines.some((line) => /^\s*last used:/i.test(line))).toBe(false);
  expect(lines.join("\n")).not.toMatch(/[\u0085\u2028\u2029]/u);
});
