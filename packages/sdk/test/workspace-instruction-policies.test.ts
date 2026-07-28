import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const REVISION_A = "00000000-0000-4000-8000-000000000002";
const REVISION_B = "00000000-0000-4000-8000-000000000003";

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
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "Prefer additive changes.",
      provenanceSource: "onboarding",
    });
    await client.importLegacyWorkspaceInstructionPolicyDraft(WORKSPACE_ID);
    await client.diffWorkspaceInstructionPolicyRevisions(WORKSPACE_ID, {
      fromRevisionId: REVISION_A,
      toRevisionId: REVISION_B,
    });
    await client.activateWorkspaceInstructionPolicyRevision(WORKSPACE_ID, REVISION_A, {
      expectedCurrentRevisionId: null,
      reason: "Initial activation",
    });
    await client.rollbackWorkspaceInstructionPolicyRevision(WORKSPACE_ID, {
      targetRevisionId: REVISION_A,
      expectedCurrentRevisionId: REVISION_B,
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
    expect(await requests[2]!.json()).toMatchObject({ provenanceSource: "onboarding" });
    expect(await requests[3]!.json()).toEqual({});
    expect(await requests[5]!.json()).toEqual({
      expectedCurrentRevisionId: null,
      reason: "Initial activation",
    });
  });
});
