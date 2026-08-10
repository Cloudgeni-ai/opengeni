import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const REVISION_A = "00000000-0000-4000-8000-000000000002";
const REVISION_B = "00000000-0000-4000-8000-000000000003";

describe("company-profile SDK", () => {
  test("maps the complete authority surface to stable workspace-fenced routes", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await client.listCompanyProfile(WORKSPACE_ID, { afterRevision: 12, limit: 10 });
    await client.getCompanyProfileRevision(WORKSPACE_ID, REVISION_A);
    await client.updateCompanyProfile(WORKSPACE_ID, {
      operationId: crypto.randomUUID(),
      profile: {
        identity: "CloudGeni builds OpenGeni.",
        mission: null,
        products: [],
        customers: [],
        goals: [],
        constraints: [],
      },
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      reason: "Initial profile",
    });
    await client.diffCompanyProfileRevisions(WORKSPACE_ID, {
      fromRevisionId: REVISION_A,
      toRevisionId: REVISION_B,
    });
    await client.activateCompanyProfileRevision(WORKSPACE_ID, REVISION_A, {
      expectedCurrentRevisionId: REVISION_B,
      expectedActivationVersion: 2,
      reason: "Activate reviewed proposal",
    });
    await client.rollbackCompanyProfile(WORKSPACE_ID, {
      targetRevisionId: REVISION_A,
      expectedCurrentRevisionId: REVISION_B,
      expectedActivationVersion: 3,
      reason: "Restore known-good profile",
    });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-profile?afterRevision=12&limit=10`,
      ],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-profile/revisions/${REVISION_A}`,
      ],
      ["PUT", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-profile`],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-profile/diff?fromRevisionId=${REVISION_A}&toRevisionId=${REVISION_B}`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-profile/revisions/${REVISION_A}/activate`,
      ],
      ["POST", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-profile/rollback`],
    ]);
  });
});
