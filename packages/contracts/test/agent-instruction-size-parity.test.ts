import { expect, test } from "bun:test";
import {
  AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  AgentInstructionSaveRequest,
  RememberRequest,
  ProposeWorkspaceInstructionPolicyRequest,
  WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
} from "../src";

const operationId = "00000000-0000-4000-8000-000000000001";
const target = { kind: "policy" as const, scope: "global" as const, roleKey: null };
const base = {
  operationId,
  target,
  expectedCurrentRevisionId: null,
  expectedActivationVersion: 0,
  reason: "Preserve the existing rules",
};

test("agent instruction writes use the human editor limit, not a separate rule budget", () => {
  expect(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS).toBe(
    WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  );
  const content = "r".repeat(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS);
  expect(AgentInstructionSaveRequest.parse({ ...base, editMode: "append", content }).content).toBe(
    content,
  );
  expect(
    RememberRequest.parse({ operationId, lane: "instruction_policy", content, reason: base.reason })
      .content,
  ).toBe(content);
  expect(
    ProposeWorkspaceInstructionPolicyRequest.parse({
      ...base,
      kind: "propose_instruction_policy",
      claimId: operationId,
      evidenceId: operationId,
      content,
    }).content,
  ).toBe(content);
});

test("localized edit texts can exceed 600 characters without becoming a whole-policy rewrite", () => {
  const oldText = "a".repeat(700);
  const newText = "b".repeat(900);
  expect(
    AgentInstructionSaveRequest.parse({ ...base, editMode: "edit", oldText, newText }),
  ).toMatchObject({
    oldText,
    newText,
  });
});

test("agent instruction texts still reject values beyond the human editor limit", () => {
  const oversized = "r".repeat(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS + 1);
  for (const request of [
    { ...base, editMode: "append", content: oversized },
    { ...base, editMode: "edit", oldText: oversized, newText: "" },
    { ...base, editMode: "edit", oldText: "rule", newText: oversized },
  ]) {
    expect(AgentInstructionSaveRequest.safeParse(request).success).toBe(false);
  }
});
