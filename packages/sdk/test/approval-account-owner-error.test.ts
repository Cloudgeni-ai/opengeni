import { expect, test } from "bun:test";
import {
  APPROVAL_REQUIRES_ACCOUNT_OWNER_CODE,
  isApprovalRequiresAccountOwnerError,
  OpenGeniApiError,
  OpenGeniClient,
  type FetchLike,
} from "../src";

// The API's error envelope for an approve refused because only the owner of
// the personal login the action runs on can approve it.
const REFUSED = JSON.stringify({
  error: {
    code: "forbidden",
    message:
      "Only Alice Example can approve this action, because it runs on their own account. Ask them to approve it, or decline it.",
    retryable: false,
    outcomeUnknown: false,
    details: { code: "APPROVAL_REQUIRES_ACCOUNT_OWNER", accountOwnerLabel: "Alice Example" },
  },
});

test("a refused approve is recognized by its code, not its text", async () => {
  const fetch: FetchLike = async () =>
    new Response(REFUSED, { status: 403, headers: { "content-type": "application/json" } });
  const client = new OpenGeniClient({ baseUrl: "https://api.example.test", apiKey: "key", fetch });
  const refused = await client
    .sendApprovalDecision(crypto.randomUUID(), crypto.randomUUID(), {
      approvalId: "approval-1",
      decision: "approve",
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(isApprovalRequiresAccountOwnerError(refused)).toBe(true);
  expect((refused as OpenGeniApiError).details).toMatchObject({
    code: APPROVAL_REQUIRES_ACCOUNT_OWNER_CODE,
    accountOwnerLabel: "Alice Example",
  });
  expect((refused as OpenGeniApiError).message).toContain("Only Alice Example can approve");

  expect(isApprovalRequiresAccountOwnerError(new OpenGeniApiError(403, "{}"))).toBe(false);
  expect(isApprovalRequiresAccountOwnerError(new Error("forbidden"))).toBe(false);
});
