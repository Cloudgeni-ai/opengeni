import { expect, test } from "bun:test";
import { approvalArgumentsText } from "../src/approval-review-model";
import type { PendingApproval } from "../src/approvals";

function approval(fields: Partial<PendingApproval>): PendingApproval {
  return { id: "call-1", name: "example_tool", ...fields };
}

test("details show object arguments indented", () => {
  expect(approvalArgumentsText(approval({ arguments: { email: "anna@example.com" } }))).toBe(
    '{\n  "email": "anna@example.com"\n}',
  );
});

test("details decode JSON-encoded arguments once instead of showing an escaped string", () => {
  const text = approvalArgumentsText(
    approval({ arguments: JSON.stringify({ body: { role: "member" } }) }),
  );
  expect(text).toBe('{\n  "body": {\n    "role": "member"\n  }\n}');
  expect(text).not.toContain('\\"');
});

test("details keep text that is not JSON as it came", () => {
  expect(approvalArgumentsText(approval({ arguments: "plain words" }))).toBe("plain words");
});
