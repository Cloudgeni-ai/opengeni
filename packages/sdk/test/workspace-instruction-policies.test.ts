import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const REVISION_A = "00000000-0000-4000-8000-000000000002";
const REVISION_B = "00000000-0000-4000-8000-000000000003";
const DRAFT_OPERATION = "00000000-0000-4000-8000-000000000004";
const IMPORT_OPERATION = "00000000-0000-4000-8000-000000000005";
const ACTIVATE_OPERATION = "00000000-0000-4000-8000-000000000006";
const ROLLBACK_OPERATION = "00000000-0000-4000-8000-000000000007";
const PROPOSAL_OPERATION = "00000000-0000-4000-8000-000000000008";

describe("workspace instruction-policy SDK", () => {
  test("maps the complete backend control surface to stable routes", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    await client.listWorkspaceInstructionPolicies(WORKSPACE_ID, {
      kind: "policy",
      scope: "role",
      roleKey: "incident-responder",
      afterRevision: 42,
      limit: 25,
    });
    await client.getWorkspaceInstructionPolicyRevision(WORKSPACE_ID, REVISION_A);
    await client.createWorkspaceInstructionPolicyDraft(WORKSPACE_ID, {
      operationId: DRAFT_OPERATION,
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "Prefer additive changes.",
      provenanceSource: "onboarding",
    });
    await client.listWorkspaceInstructionPolicyOnboardingProposals(WORKSPACE_ID, { limit: 10 });
    await client.createWorkspaceInstructionPolicyOnboardingProposal(WORKSPACE_ID, {
      operationId: PROPOSAL_OPERATION,
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "Require explicit production approval.",
      sourceId: "guided-onboarding",
      sourceVersion: "2026-08-03",
      confidenceBps: 9_500,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
    });
    await client.importLegacyWorkspaceInstructionPolicyDraft(WORKSPACE_ID, {
      operationId: IMPORT_OPERATION,
    });
    await client.diffWorkspaceInstructionPolicyRevisions(WORKSPACE_ID, {
      fromRevisionId: REVISION_A,
      toRevisionId: REVISION_B,
    });
    await client.activateWorkspaceInstructionPolicyRevision(WORKSPACE_ID, REVISION_A, {
      operationId: ACTIVATE_OPERATION,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      reason: "Initial activation",
    });
    await client.rollbackWorkspaceInstructionPolicyRevision(WORKSPACE_ID, {
      operationId: ROLLBACK_OPERATION,
      targetRevisionId: REVISION_A,
      expectedCurrentRevisionId: REVISION_B,
      expectedActivationVersion: 2,
      reason: "Restore known-good policy",
    });

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/instruction-policies?kind=policy&scope=role&roleKey=incident-responder&afterRevision=42&limit=25`,
      ],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/instruction-policies/${REVISION_A}`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/instruction-policies/drafts`,
      ],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/instruction-policies/onboarding-proposals?limit=10`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/instruction-policies/onboarding-proposals`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/instruction-policies/import-legacy`,
      ],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/instruction-policies/diff?fromRevisionId=${REVISION_A}&toRevisionId=${REVISION_B}`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/instruction-policies/${REVISION_A}/activate`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/instruction-policies/rollback`,
      ],
    ]);
    expect(await requests[2]!.json()).toMatchObject({
      operationId: DRAFT_OPERATION,
      provenanceSource: "onboarding",
    });
    expect(await requests[4]!.json()).toEqual({
      operationId: PROPOSAL_OPERATION,
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "Require explicit production approval.",
      sourceId: "guided-onboarding",
      sourceVersion: "2026-08-03",
      confidenceBps: 9_500,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
    });
    expect(await requests[5]!.json()).toEqual({ operationId: IMPORT_OPERATION });
    expect(await requests[7]!.json()).toEqual({
      operationId: ACTIVATE_OPERATION,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      reason: "Initial activation",
    });
    expect(await requests[8]!.json()).toEqual({
      operationId: ROLLBACK_OPERATION,
      targetRevisionId: REVISION_A,
      expectedCurrentRevisionId: REVISION_B,
      expectedActivationVersion: 2,
      reason: "Restore known-good policy",
    });
  });
});
