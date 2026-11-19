import { describe, expect, test } from "bun:test";
import {
  agentFileToDefinition,
  defineAgent,
  OpenGeniClient,
  organizationAgents,
  type CreateSessionRequest,
  type Session,
} from "../src/index";
import * as subpath from "../src/organization-agents";
import { WORKSPACE_ID } from "./helpers";

const ORG = "1f0e2d3c-4b5a-4968-8776-655443322110";

function recordingClient(respond: (method: string, path: string) => unknown = () => ({})) {
  const requests: { method: string; path: string; search: string; body: unknown }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "og_org_key",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text =
        request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
      requests.push({
        method: request.method,
        path: url.pathname,
        search: url.search,
        body: text ? JSON.parse(text) : undefined,
      });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(respond(request.method, url.pathname));
    },
  });
  return { client, requests };
}

const support = defineAgent({
  key: "support",
  name: "Customer support",
  instructions: "Help customers.",
  model: "gpt-5.5",
  toolServers: [
    { server: "helpdesk", tools: { mode: "selected", enabled: ["search"] }, newTools: "on" },
  ],
  workers: { shareInstructions: true },
});

describe("organization agents", () => {
  test("defineAgent keeps the literal and agentFileToDefinition splits it like the CLI", () => {
    expect(support.key).toBe("support");
    expect(agentFileToDefinition(support)).toEqual({
      key: "support",
      definition: {
        name: "Customer support",
        instructions: "Help customers.",
        config: {
          model: "gpt-5.5",
          toolServers: [
            {
              server: "helpdesk",
              tools: { mode: "selected", enabled: ["search"] },
              newTools: "on",
            },
          ],
          workers: { shareInstructions: true },
        },
      },
    });
  });

  test("deploy and apply call PUT .../agents/by-key/:key/apply", async () => {
    const { client, requests } = recordingClient(() => ({
      outcome: "created",
      dryRun: true,
      configHash: `sha256:${"0".repeat(64)}`,
      version: null,
      published: false,
      agent: null,
      operation: null,
    }));
    const agents = organizationAgents(client, ORG);
    const result = await agents.deploy(support, { dryRun: true, publish: true });
    expect(result.outcome).toBe("created");
    await agents.apply("triage", { name: "Triage" }, { moveRunningChats: true, publish: true });
    expect(requests).toEqual([
      {
        method: "PUT",
        path: `/v1/organizations/${ORG}/agents/by-key/support/apply`,
        search: "",
        body: { ...agentFileToDefinition(support).definition, dryRun: true, publish: true },
      },
      {
        method: "PUT",
        path: `/v1/organizations/${ORG}/agents/by-key/triage/apply`,
        search: "",
        body: { name: "Triage", moveRunningChats: true, publish: true },
      },
    ]);
  });

  test("management, versions, publish, tool servers and end-user logins use the documented routes", async () => {
    const operationId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const { client, requests } = recordingClient((method, path) =>
      method === "GET" && path.endsWith("/publish-operations")
        ? { operations: [{ id: operationId, status: "succeeded" }] }
        : {},
    );
    const agents = organizationAgents(client, ORG);
    const agentId = "5d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a";
    await agents.list({ includeArchived: true });
    await agents.get("support");
    await agents.get(agentId);
    await agents.create({ key: "triage", name: "Triage" });
    await agents.update(agentId, { expectedVersion: 2, workspaceIds: [] });
    await agents.saveDraft(agentId, { name: "Triage", expectedVersion: 3 });
    await agents.versions(agentId);
    await agents.version(agentId, 2);
    await agents.publish(agentId, { version: 2, expectedVersion: 4, moveRunningChats: true });
    expect((await agents.publishOperation(agentId, operationId)).operation.id).toBe(operationId);
    await expect(agents.publishOperation(agentId, "missing")).rejects.toThrow(
      "Publish operation missing was not found",
    );
    await agents.setManagement(agentId, { managedBy: "console", expectedVersion: 5 });
    await agents.archive(agentId);
    await agents.sessions(agentId, { version: 2, limit: 50 });
    await agents.usage(agentId, { range: "30d" });
    await agents.toolServers.list();
    await agents.toolServers.get("helpdesk");
    await agents.toolServers.tools("helpdesk");
    await agents.toolServers.delete("helpdesk");
    await agents.toolCredentials.put(WORKSPACE_ID, "user 1", "helpdesk", {
      kind: "headers",
      headers: { authorization: "Bearer end-user-token" },
    });
    await agents.toolCredentials.get(WORKSPACE_ID, "user 1", "helpdesk");
    await agents.toolCredentials.delete(WORKSPACE_ID, "user 1", "helpdesk");
    const base = `/v1/organizations/${ORG}`;
    const login = `/v1/workspaces/${WORKSPACE_ID}/end-users/user%201/tool-credentials/helpdesk`;
    expect(requests.map((request) => `${request.method} ${request.path}${request.search}`)).toEqual(
      [
        `GET ${base}/agents?includeArchived=true`,
        `GET ${base}/agents/by-key/support`,
        `GET ${base}/agents/${agentId}`,
        `POST ${base}/agents`,
        `PATCH ${base}/agents/${agentId}`,
        `PUT ${base}/agents/${agentId}/draft`,
        `GET ${base}/agents/${agentId}/versions`,
        `GET ${base}/agents/${agentId}/versions/2`,
        `POST ${base}/agents/${agentId}/publish`,
        `GET ${base}/agents/${agentId}/publish-operations`,
        `GET ${base}/agents/${agentId}/publish-operations`,
        `POST ${base}/agents/${agentId}/management`,
        `POST ${base}/agents/${agentId}/archive`,
        `GET ${base}/agents/${agentId}/sessions?version=2&limit=50`,
        `GET ${base}/agents/${agentId}/usage?range=30d`,
        `GET ${base}/agents/tool-servers`,
        `GET ${base}/agents/tool-servers/helpdesk`,
        `GET ${base}/agents/tool-servers/helpdesk/tools`,
        `DELETE ${base}/agents/tool-servers/helpdesk`,
        `PUT ${login}`,
        `GET ${login}`,
        `DELETE ${login}`,
      ],
    );
    expect(requests[19]!.body).toEqual({
      kind: "headers",
      headers: { authorization: "Bearer end-user-token" },
    });
  });

  test("the subpath export matches the root export", () => {
    expect(subpath.organizationAgents).toBe(organizationAgents);
    expect(subpath.defineAgent).toBe(defineAgent);
  });

  test("session create accepts an organization agent and Session carries orgAgent", () => {
    const byKey: CreateSessionRequest = { initialMessage: "Hi", agent: "support" };
    const withChanges: CreateSessionRequest = {
      initialMessage: "Hi",
      model: "gpt-5.5",
      agent: {
        ref: "support",
        instructions: "The user is on the Pro plan.",
        toolServers: [
          {
            server: "crm",
            disableTools: ["delete_contact"],
            headers: { authorization: "Bearer x" },
          },
        ],
      },
      agentOverrides: "reject",
    };
    const today: CreateSessionRequest = {
      initialMessage: "Hi",
      agent: { identity: null, renderer: "markdown" },
    };
    const orgAgent: NonNullable<Session["orgAgent"]> = {
      id: "5d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a",
      key: "support",
      version: 3,
      overrides: { model: { agent: "gpt-5.4", chat: "gpt-5.5" } },
    };
    expect([byKey, withChanges, today, orgAgent]).toHaveLength(4);
  });
});
