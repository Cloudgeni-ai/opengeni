import { expect, test } from "bun:test";
import { SessionApprovalForbiddenError } from "@opengeni/db";
import { approvalForbiddenHttpError } from "../src/http/api-error";

test("approving another person's own-login action answers 403 saying who can approve", () => {
  const named = approvalForbiddenHttpError(
    new SessionApprovalForbiddenError({ subjectId: "user:alice", label: "Alice Example" }),
  );
  expect(named?.status).toBe(403);
  expect(named?.code).toBe("forbidden");
  expect(named?.retryable).toBe(false);
  expect(named?.message).toBe(
    "Only Alice Example can approve this action, because it runs on their own account. Ask them to approve it, or decline it.",
  );
  // The stable code tells clients this 403 from others; the owner's id never leaves.
  expect(named?.details).toEqual({
    code: "APPROVAL_REQUIRES_ACCOUNT_OWNER",
    accountOwnerLabel: "Alice Example",
  });

  const unnamed = approvalForbiddenHttpError(
    new SessionApprovalForbiddenError({ subjectId: "user:alice", label: null }),
  );
  expect(unnamed?.details).toEqual({ code: "APPROVAL_REQUIRES_ACCOUNT_OWNER" });
  expect(unnamed?.message).toContain("Only the person whose own account runs this action");

  expect(approvalForbiddenHttpError(new Error("something else"))).toBeNull();
});
