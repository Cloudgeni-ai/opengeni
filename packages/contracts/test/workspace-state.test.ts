import { describe, expect, test } from "bun:test";
import { WorkspaceStateResponse } from "../src";

const minimalResponse = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  generatedAt: "2026-07-30T12:00:00.000Z",
  truth: {
    current: { source: "read_time_projection", capturedAt: "2026-07-30T12:00:00.000Z" },
    attemptGovernance: { status: "not_requested" },
  },
  policy: {
    authority: "workspace_instruction_policy_heads",
    activeHeads: [],
    activeHeadsTruncated: false,
    latestRevision: null,
    legacyRuntime: { source: "deployment_default", workspaceOverrideConfigured: false },
    runtimeComposition: { status: "not_implemented" },
  },
  knowledge: {
    availability: "unavailable",
    reason: "missing_permission",
    requiredPermission: "documents:search",
  },
} as const;

describe("workspace state contract", () => {
  test("accepts the bounded unavailable projection and rejects undeclared raw fields", () => {
    expect(WorkspaceStateResponse.safeParse(minimalResponse).success).toBe(true);
    expect(
      WorkspaceStateResponse.safeParse({
        ...minimalResponse,
        policy: { ...minimalResponse.policy, content: "must not cross this boundary" },
      }).success,
    ).toBe(false);
    expect(
      WorkspaceStateResponse.safeParse({
        ...minimalResponse,
        knowledge: {
          ...minimalResponse.knowledge,
          hiddenDocumentCount: 7,
        },
      }).success,
    ).toBe(false);
  });
});
