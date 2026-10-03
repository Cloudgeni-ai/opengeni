import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ToolGatewayApprovalResponse,
  ToolGatewayCallResponse,
  ToolGatewayCatalog,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  startTestMcpServer,
  testSettings,
  type SharedTestDatabase,
  type TestMcpServer,
} from "@opengeni/testing";
import { createApp } from "../src/app";

let shared: SharedTestDatabase;
let client: DbClient;
let mcp: TestMcpServer;
let humanApp: ReturnType<typeof createApp>;
let serviceApp: ReturnType<typeof createApp>;
let workspaceId: string;
let serviceSubjectId: string;
let serviceHeaders: Record<string, string>;
let catalog: ToolGatewayCatalog;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-tool-gateway-routes");
  if (!acquired) throw new Error("Workspace tool gateway routes require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
  mcp = startTestMcpServer();

  // Use the exact local browser identity so createApp's real access resolver,
  // rather than a forged human_session grant, supplies canonical authority.
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:local",
    accountExternalId: "default",
    accountName: "Local",
    workspaceExternalSource: "opengeni:local",
    workspaceExternalId: "default",
    workspaceName: "Local",
    subjectId: "dev",
    subjectLabel: "Local dev",
  });
  const grant = access.workspaceGrants[0];
  if (!grant) throw new Error("Local workspace bootstrap returned no grant");
  workspaceId = grant.workspaceId;
  const token = randomBytes(32).toString("base64url");
  const key = await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "SEC-03 service route regression",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:read"],
  });
  serviceSubjectId = `api_key:${key.id}`;
  serviceHeaders = { authorization: `Bearer ${token}` };
  const settings = testSettings({
    mcpServers: [
      {
        id: "protected-fixture",
        url: mcp.url,
        cacheToolsList: false,
        requireApproval: true,
      },
      {
        id: "ordinary-fixture",
        url: mcp.url,
        cacheToolsList: false,
        requireApproval: false,
      },
    ],
  });
  const deps = {
    db: client.db,
    bus: new MemoryEventBus(),
    // These routes never dispatch a session workflow.
    workflowClient: {} as never,
    managedAuth: null,
  };
  humanApp = createApp({ ...deps, settings });
  serviceApp = createApp({ ...deps, settings: { ...settings, productAccessMode: "managed" } });

  const serviceCatalog = await serviceApp.request(toolsPath("catalog"), {
    headers: serviceHeaders,
  });
  expect(serviceCatalog.status).toBe(200);
  catalog = ToolGatewayCatalog.parse(await serviceCatalog.json());
  // Both entries must actually be exposed: an empty/filtered catalog would
  // make a 403 or 404 an unrelated denial, not approval-authority coverage.
  expect(catalog.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        identity: { serverId: "protected-fixture", toolName: "search_documents" },
        approval: "human",
      }),
      expect.objectContaining({
        identity: { serverId: "ordinary-fixture", toolName: "search_documents" },
        approval: "none",
      }),
    ]),
  );
  const humanCatalog = await humanApp.request(toolsPath("catalog"));
  expect(humanCatalog.status).toBe(200);
  expect(ToolGatewayCatalog.parse(await humanCatalog.json()).digest).toBe(catalog.digest);
}, 180_000);

afterAll(async () => {
  mcp?.close();
  await client?.close();
  await shared?.release();
}, 60_000);

function toolsPath(route: string): string {
  return `/v1/workspaces/${workspaceId}/tools/${route}`;
}

function callRequest(serverId = "protected-fixture") {
  return {
    operationId: randomUUID(),
    catalogDigest: catalog.digest,
    identity: { serverId, toolName: "search_documents" },
    arguments: { query: "SEC-03 route regression" },
  };
}

async function post(
  app: ReturnType<typeof createApp>,
  route: "approvals" | "calls",
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request(toolsPath(route), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectHumanAuthorityDenied(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  expect(await response.text()).toContain("canonical human session required for tool approval");
}

async function approvalRows(operationId: string) {
  return await shared.admin<{ subject_id: string; consumed_at: Date | null }[]>`
    select subject_id, consumed_at from tool_gateway_approval_capabilities
    where workspace_id = ${workspaceId} and operation_id = ${operationId}
    order by subject_id
  `;
}

describe("workspace tool gateway approval authority through registered routes", () => {
  test("organization service key cannot issue approval or execute a protected tool", async () => {
    const request = callRequest();
    const before = mcp.calls.length;
    await expectHumanAuthorityDenied(await post(serviceApp, "approvals", request, serviceHeaders));
    expect(await approvalRows(request.operationId)).toEqual([]);
    await expectHumanAuthorityDenied(await post(serviceApp, "calls", request, serviceHeaders));
    expect(await approvalRows(request.operationId)).toEqual([]);
    expect(mcp.calls).toHaveLength(before);
  });

  test("service key cannot consume a human token, which remains usable once by its human", async () => {
    const request = callRequest();
    const before = mcp.calls.length;
    const unapproved = await post(humanApp, "calls", request);
    expect(unapproved.status).toBe(409);
    expect(await unapproved.text()).toContain("tool_gateway_approval_required");
    expect(mcp.calls).toHaveLength(before);
    const approval = await post(humanApp, "approvals", request);
    expect(approval.status).toBe(201);
    const approved = ToolGatewayApprovalResponse.parse(await approval.json());
    const approvedCall = { ...request, approvalToken: approved.approvalToken };
    expect(await approvalRows(request.operationId)).toEqual([
      { subject_id: "dev", consumed_at: null },
    ]);
    expect(mcp.calls).toHaveLength(before);

    await expectHumanAuthorityDenied(await post(serviceApp, "calls", approvedCall, serviceHeaders));
    expect(await approvalRows(request.operationId)).toEqual([
      { subject_id: "dev", consumed_at: null },
    ]);
    expect(mcp.calls).toHaveLength(before);

    const called = await post(humanApp, "calls", approvedCall);
    expect(called.status).toBe(200);
    const result = ToolGatewayCallResponse.parse(await called.json());
    expect(result.result.isError).not.toBe(true);
    expect(mcp.calls.slice(before)).toEqual([
      { tool: request.identity.toolName, args: request.arguments },
    ]);
    expect(await approvalRows(request.operationId)).toEqual([
      { subject_id: "dev", consumed_at: expect.any(Date) },
    ]);
    const replay = await post(humanApp, "calls", approvedCall);
    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("tool_gateway_approval_required");
    expect(mcp.calls).toHaveLength(before + 1);
  });

  test("service key cannot consume even a pre-existing approval bound to its own subject", async () => {
    const request = callRequest();
    const approval = await post(humanApp, "approvals", request);
    expect(approval.status).toBe(201);
    const approved = ToolGatewayApprovalResponse.parse(await approval.json());
    // Model a capability issued before SEC-03. Matching the service subject
    // rules out subject mismatch as the reason consumption is denied.
    await shared.admin`
      update tool_gateway_approval_capabilities set subject_id = ${serviceSubjectId}
      where workspace_id = ${workspaceId} and operation_id = ${request.operationId}
    `;
    const before = mcp.calls.length;
    await expectHumanAuthorityDenied(
      await post(
        serviceApp,
        "calls",
        {
          ...request,
          approvalToken: approved.approvalToken,
        },
        serviceHeaders,
      ),
    );
    expect(await approvalRows(request.operationId)).toEqual([
      { subject_id: serviceSubjectId, consumed_at: null },
    ]);
    expect(mcp.calls).toHaveLength(before);
  });

  test("organization service key can still execute a tool that needs no approval", async () => {
    const request = callRequest("ordinary-fixture");
    const before = mcp.calls.length;
    const response = await post(serviceApp, "calls", request, serviceHeaders);
    expect(response.status).toBe(200);
    const result = ToolGatewayCallResponse.parse(await response.json());
    expect(result.result.isError).not.toBe(true);
    expect(mcp.calls.slice(before)).toEqual([
      { tool: request.identity.toolName, args: request.arguments },
    ]);
    expect(await approvalRows(request.operationId)).toEqual([]);
  });
});
