import { describe, expect, test } from "bun:test";

import {
  COMPANY_BRAIN_GUIDANCE_MAX_CONTENT_BYTES,
  COMPANY_BRAIN_GUIDANCE_MAX_ENTRIES,
  CompanyBrainOkfPackage,
} from "../src/company-brain";

describe("Company Brain OKF contract", () => {
  test("represents authorized-empty guidance separately from unavailable Knowledge", () => {
    const parsed = CompanyBrainOkfPackage.parse({
      kind: "opengeni.company_brain.okf",
      schemaVersion: 1,
      workspaceId: "00000000-0000-4000-8000-000000000001",
      generatedAt: "2026-08-15T10:00:00.000Z",
      permissions: { guidance: "available", knowledge: "unavailable" },
      guidance: { entries: [], truncated: false, truncationReasons: [] },
      knowledge: {
        availability: "unavailable",
        reason: "missing_permission",
        requiredPermission: "documents:search",
      },
      omissions: [
        "inaccessible_knowledge",
        "document_bodies_use_documents_export",
        "memory_bodies_and_provenance",
        "secret_values_and_credentials",
        "session_messages_and_task_notes",
        "policy_and_preference_actor_identifiers",
      ],
    });
    expect(parsed.permissions).toEqual({ guidance: "available", knowledge: "unavailable" });
    expect(parsed.guidance.entries).toEqual([]);
    expect(parsed.knowledge.availability).toBe("unavailable");
  });

  test("publishes stable aggregate safety bounds", () => {
    expect(COMPANY_BRAIN_GUIDANCE_MAX_ENTRIES).toBe(512);
    expect(COMPANY_BRAIN_GUIDANCE_MAX_CONTENT_BYTES).toBe(4 * 1024 * 1024);
  });
});
