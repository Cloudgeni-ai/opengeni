import { describe, expect, test } from "bun:test";

import { deriveBrainAttention, type BrainAttentionInput } from "./agent-brain-overview";

function cleanInput(): BrainAttentionInput {
  return {
    companyProfileStatus: { label: "Configured" },
    workspaceInstructionsMissing: false,
    policyRevisionPending: false,
    policyInventoryPartial: false,
    preferenceInventoryPartial: false,
    inventoryRefreshFailed: false,
    knowledge: { availability: "available", gaps: [] },
    proposals: {
      status: "ready",
      pendingCount: 0,
      staleCount: 0,
      partial: false,
    },
  };
}

describe("Company Brain attention derivation", () => {
  test("reports a clean state only after every visible review authority is ready", () => {
    expect(deriveBrainAttention(cleanInput())).toEqual([]);

    for (const status of ["loading", "unavailable"] as const) {
      const input = cleanInput();
      input.proposals.status = status;
      expect(deriveBrainAttention(input)).toContain(
        status === "loading"
          ? "Proposal review is still loading"
          : "Proposal review is unavailable",
      );
    }
  });

  test("surfaces pending memory review and every other deterministic Knowledge gap", () => {
    const input = cleanInput();
    input.knowledge = {
      availability: "available",
      gaps: [
        { code: "pending_memory_review", relatedCount: 2 },
        { code: "failed_documents", relatedCount: 1 },
        { code: "partial_inventory", relatedCount: null },
      ],
    };
    expect(deriveBrainAttention(input)).toEqual([
      "Some learned memories await review (2)",
      "Some documents failed indexing (1)",
      "Knowledge review is partial",
    ]);
  });

  test("does not claim clean state when company or Knowledge authority is unavailable", () => {
    const input = cleanInput();
    input.companyProfileStatus = { label: "Unavailable", tone: "warning" };
    input.knowledge = { availability: "unavailable" };
    expect(deriveBrainAttention(input)).toEqual([
      "Company profile review is unavailable",
      "Knowledge review is unavailable",
    ]);
  });

  test("surfaces pending, stale and partial proposal evidence", () => {
    const input = cleanInput();
    input.proposals = { status: "ready", pendingCount: 3, staleCount: 1, partial: true };
    expect(deriveBrainAttention(input)).toEqual([
      "3 proposals await review",
      "1 proposal has a stale baseline",
      "Proposal review is partial",
    ]);
  });

  test("surfaces stale refresh, inactive policy and bounded governance projections", () => {
    const input = cleanInput();
    input.inventoryRefreshFailed = true;
    input.policyRevisionPending = true;
    input.policyInventoryPartial = true;
    input.preferenceInventoryPartial = true;
    expect(deriveBrainAttention(input)).toEqual([
      "Company Brain refresh failed",
      "An inactive policy revision needs review",
      "Policy review is partial",
      "Preference summaries are partially shown",
    ]);
  });
});
