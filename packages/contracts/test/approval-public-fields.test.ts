import { describe, expect, test } from "bun:test";
import { approvalIdentifier, withPublicApprovalFields } from "../src/index";

// Both historical `session.requiresAction` entry shapes expose the same
// top-level `id` (the approvalId to send back), `name`, and `arguments`.
describe("withPublicApprovalFields", () => {
  test("first pause of a turn (SDK toJSON shape) gains the stable fields", () => {
    const first = {
      type: "tool_approval_item",
      rawItem: {
        type: "function_call",
        id: "fc_provider_item",
        callId: "call_1",
        name: "umami__update_website",
        arguments: '{"id":"w1"}',
      },
      agent: { name: "OpenGeni" },
      toolName: "umami__update_website",
    };
    const projected = withPublicApprovalFields(first);
    expect(projected).toMatchObject({
      ...first,
      id: "call_1",
      name: "umami__update_website",
      arguments: '{"id":"w1"}',
    });
    expect(approvalIdentifier(projected)).toBe("call_1");
  });

  test("later pauses (open-suffix projection) keep their fields and identity", () => {
    const later = {
      id: "call_2",
      name: "umami__delete_website",
      arguments: "{}",
      raw: { type: "function_call", callId: "call_2", name: "umami__delete_website" },
    };
    expect(withPublicApprovalFields(later)).toEqual(later);
    expect(approvalIdentifier(withPublicApprovalFields(later))).toBe("call_2");
  });

  test("an entry without a stable identity is left untouched", () => {
    expect(withPublicApprovalFields({ rawItem: {} })).toEqual({ rawItem: {} });
    expect(withPublicApprovalFields(null)).toBeNull();
  });
});
