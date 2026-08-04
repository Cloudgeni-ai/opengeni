import { describe, expect, test } from "bun:test";
import { WorkspaceStateExportResponse, WorkspaceStateResponse } from "../src";

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
  preferences: {
    authority: "preference_registry_preferences",
    activeDescriptorCount: 0,
    activeDescriptorHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    scopeCounts: { organization: 0, workspace: 0, user: 0 },
    truncated: false,
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

  test("accepts only the explicit sanitized export envelope", () => {
    const exported = {
      kind: "opengeni.workspace_state.sanitized_export",
      schemaVersion: 1,
      generatedAt: minimalResponse.generatedAt,
      stateSha256: "a".repeat(64),
      omissions: [
        "hidden_platform_prompts",
        "policy_bodies",
        "preference_content",
        "document_content_and_private_metadata",
        "memory_content_and_provenance",
        "secret_values_and_credentials",
        "session_messages_and_tool_outputs",
      ],
      state: minimalResponse,
    } as const;
    expect(WorkspaceStateExportResponse.safeParse(exported).success).toBe(true);
    expect(
      WorkspaceStateExportResponse.safeParse({ ...exported, rawAuditLog: "must not export" })
        .success,
    ).toBe(false);
  });
});
