import { expect, test } from "bun:test";
import { CreateFeedbackRequest } from "../src/feedback";
const key = crypto.randomUUID();
test("feedback requires content and validates target relationships", () => {
  for (const payload of [
    { idempotencyKey: key },
    { idempotencyKey: key, comment: "  " },
    { idempotencyKey: key, turnId: key, comment: "good" },
    { idempotencyKey: key, sentiment: "positive" },
    { idempotencyKey: key, comment: "x".repeat(4001) },
    { idempotencyKey: key, comment: "hello", subjectId: "other" },
  ])
    expect(CreateFeedbackRequest.safeParse(payload).success).toBe(false);
  expect(
    CreateFeedbackRequest.parse({ idempotencyKey: key, comment: "  exact\ncomment  " }).comment,
  ).toBe("  exact\ncomment  ");
  expect(
    CreateFeedbackRequest.safeParse({ idempotencyKey: key, sessionId: key, sentiment: "negative" })
      .success,
  ).toBe(true);
});
