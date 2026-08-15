import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import type { CompanyBrainOkfPackage } from "../src/company-brain";

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
});
