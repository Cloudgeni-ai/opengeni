import { describe, expect, test } from "bun:test";
import {
  CreatePreferenceRegistryProposalRequest,
  PREFERENCE_REGISTRY_CONTENT_MAX_CHARS,
  PreferenceRegistryScopeTarget,
  normalizePreferenceRegistryStableKey,
} from "../src";

describe("preference registry contracts", () => {
  test("normalizes stable keys while preserving a strict portable identifier", () => {
    expect(normalizePreferenceRegistryStableKey("  Review   Style -- Concise  ")).toBe(
      "review-style-concise",
    );
    const parsed = CreatePreferenceRegistryProposalRequest.parse({
      stableKey: "  Review   Style -- Concise  ",
      scope: "user",
      title: "Review style",
      description: "Prefer concise reviews",
      content: "Prefer concise reviews with concrete evidence.",
    });
    expect(parsed.stableKey).toBe("review-style-concise");
  });

  test("requires provenance links for imported and knowledge-derived proposals", () => {
    for (const provenanceSource of [
      "knowledge_proposal",
      "imported_document",
      "slack",
      "meeting_transcript",
      "call_transcript",
    ] as const) {
      const result = CreatePreferenceRegistryProposalRequest.safeParse({
        stableKey: `source-${provenanceSource}`,
        scope: "workspace",
        title: "Imported proposal",
        description: "Inactive until reviewed",
        content: "Untrusted source text",
        provenanceSource,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["provenanceSourceId"]);
    }

    expect(
      CreatePreferenceRegistryProposalRequest.parse({
        stableKey: "source-slack",
        scope: "workspace",
        title: "Imported proposal",
        description: "Inactive until reviewed",
        content: "Untrusted source text",
        provenanceSource: "slack",
        provenanceSourceId: "channel:C1:message:42",
      }),
    ).toMatchObject({
      provenanceSource: "slack",
      provenanceSourceId: "channel:C1:message:42",
    });
  });

  test("enforces full-content and scope-target boundaries", () => {
    expect(
      CreatePreferenceRegistryProposalRequest.safeParse({
        stableKey: "oversized",
        scope: "user",
        title: "Oversized",
        description: "Rejected at the wire boundary",
        content: "x".repeat(PREFERENCE_REGISTRY_CONTENT_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      PreferenceRegistryScopeTarget.safeParse({
        scope: "user",
        workspaceId: crypto.randomUUID(),
        subjectId: "user:a",
      }).success,
    ).toBe(false);
  });
});
