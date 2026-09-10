import { describe, expect, test } from "bun:test";
import {
  CompanyProfileContent,
  CompanyProfileAgentPolicy,
  CompanyProfileAgentProposalReceipt,
  CompanyProfileLearningWrite,
  UpdateCompanyProfileAgentPolicyRequest,
  normalizeCompanyProfileStableKey,
} from "../src";

describe("company-profile contracts", () => {
  test("normalizes stable keys and rejects duplicate or empty profiles", () => {
    expect(normalizeCompanyProfileStableKey("  North Star  Platform ")).toBe("north-star-platform");
    const profile = CompanyProfileContent.parse({
      identity: "CloudGeni builds OpenGeni.",
      mission: "Make durable autonomous work dependable.",
      products: [{ key: " OpenGeni ", content: "An autonomous-work platform." }],
      customers: [],
      goals: [{ key: " Reliable   Runs ", content: "Agents complete long-running work safely." }],
      constraints: [],
    });
    expect(profile.products[0]?.key).toBe("opengeni");
    expect(profile.goals[0]?.key).toBe("reliable-runs");

    expect(
      CompanyProfileContent.safeParse({
        identity: null,
        mission: null,
        products: [],
        customers: [],
        goals: [],
        constraints: [],
      }).success,
    ).toBe(false);
    expect(
      CompanyProfileContent.safeParse({
        identity: "Company",
        mission: null,
        products: [
          { key: "same", content: "A" },
          { key: "same", content: "B" },
        ],
        customers: [],
        goals: [],
        constraints: [],
      }).success,
    ).toBe(false);
  });

  test("defines the fail-closed durable-learning authority-native write seam", () => {
    const base = {
      operationId: "00000000-0000-4000-8000-000000000001",
      accountId: "00000000-0000-4000-8000-000000000002",
      workspaceId: "00000000-0000-4000-8000-000000000003",
      actorSubjectId: "agent:session",
      actorKind: "agent" as const,
      authority: "proposal" as const,
      sourceId: "durable-learning-attempt:00000000-0000-4000-8000-000000000001",
    };
    expect(
      CompanyProfileLearningWrite.parse({
        ...base,
        subject: {
          kind: "company_goal",
          content: "Reach dependable same-turn recovery.",
          stableKey: " Recovery   Goal ",
        },
      }),
    ).toMatchObject({ authority: "proposal", subject: { stableKey: "recovery-goal" } });
    expect(
      CompanyProfileLearningWrite.safeParse({
        ...base,
        subject: {
          kind: "company_goal",
          content: "Reach dependable same-turn recovery.",
          stableKey: null,
        },
      }).success,
    ).toBe(false);
    expect(
      CompanyProfileLearningWrite.safeParse({
        ...base,
        subject: {
          kind: "company_identity",
          content: "x".repeat(2_048),
          stableKey: null,
        },
      }).success,
    ).toBe(true);
    expect(
      CompanyProfileLearningWrite.safeParse({
        ...base,
        subject: {
          kind: "company_identity",
          content: "x".repeat(2_049),
          stableKey: null,
        },
      }).success,
    ).toBe(false);
  });

  test("keeps organization agent autonomy explicit and receipt outcomes unambiguous", () => {
    expect(
      CompanyProfileAgentPolicy.parse({
        organizationId: "00000000-0000-4000-8000-000000000001",
        mode: "automatic",
        version: 2,
        updatedAt: "2026-08-29T12:00:00.000Z",
      }),
    ).toMatchObject({ mode: "automatic", version: 2 });
    expect(
      UpdateCompanyProfileAgentPolicyRequest.safeParse({
        mode: "automatic",
        expectedVersion: 1,
        operationId: "00000000-0000-4000-8000-000000000002",
        workspaceMode: "automatic",
      }).success,
    ).toBe(false);
    expect(
      CompanyProfileAgentProposalReceipt.safeParse({
        status: "activated",
        operationId: "00000000-0000-4000-8000-000000000003",
        proposalReceiptId: "00000000-0000-4000-8000-000000000004",
        automaticActivationReceiptId: "00000000-0000-4000-8000-000000000005",
        policyMode: "automatic",
        mutation: { revision: null, head: null, event: null },
        replayed: false,
      }).success,
    ).toBe(true);
    expect(
      CompanyProfileAgentProposalReceipt.safeParse({
        status: "confirmation_required",
        operationId: "00000000-0000-4000-8000-000000000003",
        proposalReceiptId: "00000000-0000-4000-8000-000000000004",
        policyMode: "automatic",
      }).success,
    ).toBe(false);
  });
});
