import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { WorkspaceStateExportResponse, WorkspaceStateResponse } from "@opengeni/contracts";

import {
  canonicalWorkspaceStateJson,
  createWorkspaceStateExport,
  serializeWorkspaceStateExport,
} from "../src/workspace-state-export";

const GENERATED_AT = "2026-08-04T04:00:00.000Z";

function state() {
  return WorkspaceStateResponse.parse({
    workspaceId: "00000000-0000-4000-8000-000000000001",
    generatedAt: GENERATED_AT,
    truth: {
      current: { source: "read_time_projection", capturedAt: GENERATED_AT },
      attemptGovernance: { status: "not_requested" },
    },
    policy: {
      authority: "workspace_instruction_policy_heads",
      activeHeads: [],
      activeHeadsTruncated: false,
      latestRevision: null,
      legacyRuntime: { source: "workspace_override", workspaceOverrideConfigured: true },
      runtimeComposition: { status: "not_implemented" },
    },
    preferences: {
      authority: "preference_registry_preferences",
      activeDescriptorCount: 0,
      activeDescriptorHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      scopeCounts: { organization: 0, workspace: 0, user: 0 },
      truncated: false,
    },
    knowledge: {
      availability: "unavailable",
      reason: "missing_permission",
      requiredPermission: "documents:search",
    },
  });
}

describe("sanitized Workspace State export", () => {
  test("canonicalizes key order and emits a stable digest for identical sanitized state", () => {
    expect(canonicalWorkspaceStateJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      canonicalWorkspaceStateJson({ a: { b: 3, y: 2 }, z: 1 }),
    );
    const projected = state();
    const first = serializeWorkspaceStateExport(projected);
    const second = serializeWorkspaceStateExport(structuredClone(projected));
    expect(second).toBe(first);

    const exported = WorkspaceStateExportResponse.parse(JSON.parse(first));
    expect(exported.stateSha256).toBe(
      createHash("sha256")
        .update(canonicalWorkspaceStateJson(projected), "utf8")
        .digest("hex"),
    );
    expect(exported.generatedAt).toBe(projected.generatedAt);
  });

  test("declares every sensitive class omitted by the sanitized boundary", () => {
    const exported = createWorkspaceStateExport(state());
    expect(exported.omissions).toEqual([
      "hidden_platform_prompts",
      "policy_bodies",
      "preference_content",
      "document_content_and_private_metadata",
      "memory_content_and_provenance",
      "secret_values_and_credentials",
      "session_messages_and_tool_outputs",
    ]);
    expect(JSON.stringify(exported)).not.toContain("PRIVATE LEGACY WORKSPACE INSTRUCTIONS");
  });
});
