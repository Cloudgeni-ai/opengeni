import { expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

const organizationId = "11111111-1111-4111-8111-111111111111";
const connectorId = "22222222-2222-4222-8222-222222222222";
const connector = {
  id: connectorId,
  organizationId,
  capabilityId: "mcp:organization-team-docs-0123456789",
  name: "Team docs",
  description: null,
  endpointUrl: "https://docs.example.test/mcp",
  source: "custom",
  login: "each_person",
  headerNames: [],
  allowedTools: null,
  availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: false },
  status: "active",
  available: true,
  generation: 1,
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
};

test("organization connector methods use the organization's connector routes", async () => {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test/",
    apiKey: "og_test_key",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      requests.push({
        method: request.method,
        url: request.url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const body = request.method === "GET" ? { connectors: [connector] } : connector;
      return new Response(JSON.stringify(body), {
        status: request.method === "POST" ? 201 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });
  const create = {
    custom: { name: "Team docs", endpointUrl: "https://docs.example.test/mcp" },
    login: "each_person" as const,
    availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: false },
  };
  const update = { expectedGeneration: 1, status: "disabled" as const };

  expect(await client.listOrganizationConnectors(organizationId)).toEqual([connector] as never);
  expect(await client.createOrganizationConnector(organizationId, create)).toEqual(
    connector as never,
  );
  expect(await client.updateOrganizationConnector(organizationId, connectorId, update)).toEqual(
    connector as never,
  );
  await client.deleteOrganizationConnector(organizationId, connectorId);

  const base = `https://api.example.test/v1/organizations/${organizationId}/connectors`;
  expect(requests).toEqual([
    { method: "GET", url: base, body: null },
    { method: "POST", url: base, body: create },
    { method: "PATCH", url: `${base}/${connectorId}`, body: update },
    { method: "DELETE", url: `${base}/${connectorId}`, body: null },
  ]);
});
