import { describe, expect, test } from "bun:test";
import {
  AGENT_AUTHORED_COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES,
  AGENT_AUTHORED_COMPANY_PROFILE_ENTRY_MAX_CHARS,
  AGENT_AUTHORED_COMPANY_PROFILE_SCALAR_MAX_CHARS,
  AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE,
  AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS,
  AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE,
  AgentAuthoredCompanyProfileContent,
  COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES,
  COMPANY_PROFILE_ENTRY_MAX_CHARS,
  COMPANY_PROFILE_SCALAR_MAX_CHARS,
  CompanyProfileContent,
  PREFERENCE_REGISTRY_CONTENT_MAX_CHARS,
  ProposeWorkspaceInstructionPolicyRequest,
  ProposeWorkspacePreferenceRequest,
  REMEMBER_CONTENT_MAX_CHARS,
  RememberRequest,
  WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  agentAuthoredDurableTextTooLongMessage,
} from "../src";

const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
const CLAIM_ID = "00000000-0000-4000-8000-000000000002";
const EVIDENCE_ID = "00000000-0000-4000-8000-000000000003";

function contentIssue(result: ReturnType<typeof RememberRequest.safeParse>): string | undefined {
  if (result.success) return undefined;
  return result.error.issues.find((issue) => issue.path.join(".") === "content")?.message;
}

function rule(content: string) {
  return { operationId: OPERATION_ID, lane: "instruction_policy", content, reason: "user asked" };
}

function preference(content: string) {
  return {
    operationId: OPERATION_ID,
    lane: "preference",
    content,
    reason: "user asked",
    stableKey: "track-work-in-linear",
    title: "Track work in Linear",
    description: "Use Linear as the source of truth for planned work.",
  };
}

describe("agent-authored durable-text budgets", () => {
  test("a concise mandatory rule is accepted", () => {
    const concise = "Always track work in Linear so we do not duplicate work.";
    const parsed = RememberRequest.parse(rule(concise));
    expect(parsed.content).toBe(concise);
    expect(concise.length).toBeLessThan(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS);
  });

  test("an over-long mandatory rule is rejected with the actionable message", () => {
    const result = RememberRequest.safeParse(
      rule("x".repeat(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS + 1)),
    );
    expect(result.success).toBe(false);
    expect(contentIssue(result)).toBe(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE);
    // Accurate about reach: a role policy composes only for its own sessions.
    expect(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE).toContain(
      "every session it applies to",
    );
    expect(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE).toContain(
      "every session bound to the role for a role policy",
    );
    expect(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE).toContain(
      `under ${AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS} characters`,
    );
  });

  test("the numbered procedural rule that motivated this budget is rejected", () => {
    const essay = [
      "1. Before starting any work, search Linear for an existing issue that covers it.",
      "2. If no issue exists, create one with a clear title and a short description.",
      "3. Move the issue into In Progress as soon as implementation begins.",
      "4. Comment on the issue with what changed and what was verified.",
      "5. Only move the issue to Done when its full scope is genuinely complete.",
    ]
      .join(" ")
      .repeat(5);
    expect(essay.length).toBeGreaterThan(1_800);
    const result = RememberRequest.safeParse(rule(essay));
    expect(result.success).toBe(false);
    expect(contentIssue(result)).toBe(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE);
  });

  test("preferences carry a larger budget because only the descriptor is composed", () => {
    expect(
      RememberRequest.safeParse(preference("y".repeat(AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS)))
        .success,
    ).toBe(true);
    const result = RememberRequest.safeParse(
      preference("y".repeat(AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS + 1)),
    );
    expect(result.success).toBe(false);
    expect(contentIssue(result)).toBe(AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE);
    expect(AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS).toBeGreaterThan(
      AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
    );
    // The honest reason for the larger budget: shortening `content` does not
    // shrink the prompt, because only the descriptor pair is composed.
    expect(AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE).toContain("retrieve on demand");
    expect(AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE).toContain(
      "retrieval cost rather than standing prompt cost",
    );
    expect(AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE).not.toContain(
      "its descriptor is injected",
    );
  });

  test("the knowledge lane keeps its retrieval-evidence ceiling", () => {
    const fact = (content: string) => ({
      operationId: OPERATION_ID,
      lane: "knowledge",
      content,
      reason: "user asked",
      subject: "Acme",
    });
    expect(RememberRequest.safeParse(fact("z".repeat(REMEMBER_CONTENT_MAX_CHARS))).success).toBe(
      true,
    );
    expect(
      RememberRequest.safeParse(fact("z".repeat(REMEMBER_CONTENT_MAX_CHARS + 1))).success,
    ).toBe(false);
  });

  test("agent instruction-policy and preference proposals share the same budgets", () => {
    const proposal = (content: string) => ({
      kind: "propose_instruction_policy",
      operationId: OPERATION_ID,
      claimId: CLAIM_ID,
      evidenceId: EVIDENCE_ID,
      target: { kind: "policy", scope: "global", roleKey: null },
      content,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      reason: "user asked",
    });
    expect(
      ProposeWorkspaceInstructionPolicyRequest.safeParse(
        proposal("x".repeat(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS)),
      ).success,
    ).toBe(true);
    const tooLong = ProposeWorkspaceInstructionPolicyRequest.safeParse(
      proposal("x".repeat(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS + 1)),
    );
    expect(tooLong.success).toBe(false);
    expect(
      tooLong.success
        ? undefined
        : tooLong.error.issues.find((issue) => issue.path.join(".") === "content")?.message,
    ).toBe(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE);

    const preferenceProposal = (content: string) => ({
      kind: "propose_preference",
      operationId: OPERATION_ID,
      claimId: CLAIM_ID,
      evidenceId: EVIDENCE_ID,
      stableKey: "track-work-in-linear",
      title: "Track work in Linear",
      description: "Use Linear as the source of truth for planned work.",
      content,
      reason: "user asked",
    });
    expect(
      ProposeWorkspacePreferenceRequest.safeParse(
        preferenceProposal("y".repeat(AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS)),
      ).success,
    ).toBe(true);
    expect(
      ProposeWorkspacePreferenceRequest.safeParse(
        preferenceProposal("y".repeat(AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS + 1)),
      ).success,
    ).toBe(false);
  });

  test("the company profile is bounded for an agent and unchanged for a human", () => {
    const profile = (identity: string) => ({
      identity,
      mission: null,
      products: [],
      customers: [],
      goals: [],
      constraints: [],
    });
    const concise = "We build managed agents that do long-running infrastructure work.";
    expect(AgentAuthoredCompanyProfileContent.safeParse(profile(concise)).success).toBe(true);

    const essay = "x".repeat(AGENT_AUTHORED_COMPANY_PROFILE_SCALAR_MAX_CHARS + 1);
    const rejected = AgentAuthoredCompanyProfileContent.safeParse(profile(essay));
    expect(rejected.success).toBe(false);
    expect(rejected.success ? "" : rejected.error.issues[0]!.message).toContain(
      "mandatory prompt context in every root session across the organization",
    );
    // The same profile still passes the human `account:admin` contract.
    expect(CompanyProfileContent.safeParse(profile(essay)).success).toBe(true);

    const longEntry = {
      identity: concise,
      mission: null,
      products: [
        {
          key: "flagship",
          content: "y".repeat(AGENT_AUTHORED_COMPANY_PROFILE_ENTRY_MAX_CHARS + 1),
        },
      ],
      customers: [],
      goals: [],
      constraints: [],
    };
    expect(AgentAuthoredCompanyProfileContent.safeParse(longEntry).success).toBe(false);
    expect(CompanyProfileContent.safeParse(longEntry).success).toBe(true);

    const manyEntries = {
      identity: null,
      mission: null,
      products: [],
      customers: [],
      goals: Array.from({ length: 16 }, (_, index) => ({
        key: `goal-${index}`,
        content: "z".repeat(AGENT_AUTHORED_COMPANY_PROFILE_ENTRY_MAX_CHARS),
      })),
      constraints: Array.from({ length: 16 }, (_, index) => ({
        key: `constraint-${index}`,
        content: "w".repeat(AGENT_AUTHORED_COMPANY_PROFILE_ENTRY_MAX_CHARS),
      })),
    };
    // Each entry is legal on its own; the whole-profile byte ceiling is what
    // stops sixteen of them becoming standing prompt weight.
    expect(AgentAuthoredCompanyProfileContent.safeParse(manyEntries).success).toBe(false);
    expect(CompanyProfileContent.safeParse(manyEntries).success).toBe(true);
  });

  test("human editor limits are untouched", () => {
    expect(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS).toBe(262_144);
    expect(PREFERENCE_REGISTRY_CONTENT_MAX_CHARS).toBe(262_144);
    expect(COMPANY_PROFILE_SCALAR_MAX_CHARS).toBe(2_048);
    expect(COMPANY_PROFILE_ENTRY_MAX_CHARS).toBe(1_024);
    expect(COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES).toBe(28_672);
    expect(AGENT_AUTHORED_COMPANY_PROFILE_SCALAR_MAX_CHARS).toBeLessThan(
      COMPANY_PROFILE_SCALAR_MAX_CHARS,
    );
    expect(AGENT_AUTHORED_COMPANY_PROFILE_ENTRY_MAX_CHARS).toBeLessThan(
      COMPANY_PROFILE_ENTRY_MAX_CHARS,
    );
    expect(AGENT_AUTHORED_COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES).toBeLessThan(
      COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES,
    );
    expect(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS).toBeLessThan(
      WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
    );
    expect(AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS).toBeLessThan(
      PREFERENCE_REGISTRY_CONTENT_MAX_CHARS,
    );
  });

  test("the over-budget message reports how long the text actually is", () => {
    expect(
      agentAuthoredDurableTextTooLongMessage({ kind: "instruction_policy", actualChars: 1_900 }),
    ).toBe(
      `This rule is 1900 characters. ${AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE}`,
    );
    expect(agentAuthoredDurableTextTooLongMessage({ kind: "preference", actualChars: 2_400 })).toBe(
      `This preference is 2400 characters. ${AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE}`,
    );
  });
});
