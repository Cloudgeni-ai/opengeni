import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import {
  browseCompanyBrainKnowledge,
  getCompanyBrainKnowledge,
  listCompanyBrainContextReceipts,
  listCompanyBrainKnowledgeProposals,
  searchCompanyBrainKnowledge,
  type CompanyBrainOkfPackage,
} from "../src/company-brain";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

describe("Company Brain SDK", () => {
  test("maps JSON inspection and Markdown export to authenticated GET routes", async () => {
    const requests: Request[] = [];
    const payload: CompanyBrainOkfPackage = {
      kind: "opengeni.company_brain.okf",
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      generatedAt: "2026-08-15T12:00:00.000Z",
      permissions: { guidance: "available", knowledge: "unavailable" },
      guidance: { entries: [], truncated: false, truncationReasons: [] },
      knowledge: {
        availability: "unavailable",
        reason: "missing_permission",
        requiredPermission: "documents:search",
      },
      omissions: ["inaccessible_knowledge"],
    };
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/export")) {
          return new Response("# package", {
            headers: {
              "content-type": "text/markdown; charset=utf-8",
              "content-disposition": `attachment; filename="company-brain-${WORKSPACE_ID}.okf.md"`,
            },
          });
        }
        return Response.json(payload);
      }) as typeof fetch,
    });

    expect(await client.getCompanyBrain(WORKSPACE_ID)).toEqual(payload);
    expect(await client.exportCompanyBrainOkf(WORKSPACE_ID)).toEqual({
      content: "# package",
      contentType: "text/markdown; charset=utf-8",
      filename: `company-brain-${WORKSPACE_ID}.okf.md`,
    });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-brain`],
      ["GET", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-brain/export`],
    ]);
  });

  test("maps bounded Knowledge, receipt, and proposal inspection without using legacy search", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.includes("/knowledge/search")) return Response.json({ results: [] });
        if (request.url.includes("/knowledge/record"))
          return Response.json({ record: { id: "record" } });
        if (request.url.includes("/knowledge/browse")) return Response.json({ records: [] });
        if (request.url.includes("/context-receipts")) {
          return Response.json({ receipts: [], nextCursor: null, hasMore: false });
        }
        return Response.json({
          proposals: [],
          truncatedForCount: false,
          truncatedForResponseBytes: false,
          responseBytes: 0,
        });
      }) as typeof fetch,
    });

    await searchCompanyBrainKnowledge(client, WORKSPACE_ID, { query: "mission", limit: 7 });
    await getCompanyBrainKnowledge(
      client,
      WORKSPACE_ID,
      "document:00000000-0000-4000-8000-000000000010",
    );
    await browseCompanyBrainKnowledge(client, WORKSPACE_ID, { limit: 9 });
    await listCompanyBrainContextReceipts(client, WORKSPACE_ID, {
      attemptId: "00000000-0000-4000-8000-000000000011",
      limit: 1,
    });
    await listCompanyBrainKnowledgeProposals(client, WORKSPACE_ID, { limit: 13 });

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-brain/knowledge/search`,
      ],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-brain/knowledge/record?id=document%3A00000000-0000-4000-8000-000000000010`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-brain/knowledge/browse`,
      ],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-brain/context-receipts?attemptId=00000000-0000-4000-8000-000000000011&limit=1`,
      ],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/company-brain/knowledge-proposals?limit=13`,
      ],
    ]);
    expect(await requests[0]!.json()).toEqual({ query: "mission", limit: 7 });
    expect(await requests[2]!.json()).toEqual({ limit: 9 });
  });
});
