import { expect, test } from "bun:test";
import type {
  McpGatewayCredentialsRequest,
  McpGatewayCredentialResolution,
} from "@opengeni/contracts";
import { buildHostGatewayConnectionTokenResolver } from "../src/connection-token-resolver";

const context = {
  accountId: "account",
  workspaceId: "workspace",
  authority: { kind: "external_user" as const, subjectId: "external-owner", permissions: [] },
};
const input = () => ({
  workspaceId: "workspace",
  serverId: "host",
  destinationUrl: "https://mcp.example/tools",
  connectionRef: {
    authoritySource: "host" as const,
    connectionId: "opaque",
    providerDomain: "mcp.example",
  },
});
function credential(request: McpGatewayCredentialsRequest): McpGatewayCredentialResolution {
  return {
    status: "ok",
    accountId: request.accountId,
    workspaceId: request.workspaceId,
    requestId: request.requestId,
    connectionId: "opaque",
    providerDomain: "mcp.example",
    headers: { authorization: "Bearer synthetic" },
  };
}

test("gateway host requests carry real non-turn authority and recheck physical use", async () => {
  let live = true;
  let received: McpGatewayCredentialsRequest | undefined;
  const supplied = structuredClone(context);
  const resolve = buildHostGatewayConnectionTokenResolver(
    async (request) => {
      received = structuredClone(request);
      return credential(request);
    },
    supplied,
    async () => {
      if (!live) throw new Error("revoked");
    },
  );
  supplied.authority.subjectId = "retargeted";
  const result = await resolve(input());
  expect(received?.authority.subjectId).toBe("external-owner");
  expect(received?.surface).toBe("workspace_gateway");
  expect(received).not.toHaveProperty("sessionId");
  expect(received).not.toHaveProperty("turnId");
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("expected credentials");
  expect(await result.authorizeProviderRequest?.()).toBe(true);
  live = false;
  expect(await result.authorizeProviderRequest?.()).toBe(false);
});

test("gateway denies revocation during resolution and does not admit durable refs", async () => {
  let live = true;
  let calls = 0;
  const resolve = buildHostGatewayConnectionTokenResolver(
    async (request) => {
      calls++;
      live = false;
      return credential(request);
    },
    context,
    async () => {
      if (!live) throw new Error("revoked");
    },
  );
  const durable = input();
  expect(
    await resolve({
      ...durable,
      connectionRef: {
        ...durable.connectionRef,
        hostBinding: { bindingId: crypto.randomUUID(), generation: 1 },
      },
    }),
  ).toMatchObject({ status: "auth_needed", reason: "unsupported_auth" });
  expect(calls).toBe(0);
  await expect(resolve(input())).rejects.toThrow("revoked");
  expect(calls).toBe(1);
});

test("gateway response cannot retarget correlation or return MCP query credentials", async () => {
  for (const field of ["requestId", "accountId", "workspaceId", "connectionId"] as const) {
    const resolve = buildHostGatewayConnectionTokenResolver(
      async (request) => ({
        ...credential(request),
        [field]: "other",
      }),
      context,
      async () => {},
    );
    await expect(resolve(input())).rejects.toThrow();
  }
  const resolve = buildHostGatewayConnectionTokenResolver(
    async (request) => ({
      ...credential(request),
      status: "ok",
      connectionId: "opaque",
      headers: {},
      placements: [{ carrier: "query", name: "key", value: "synthetic" }],
    }),
    context,
    async () => {},
  );
  await expect(resolve(input())).rejects.toThrow("credentialPlacements");
});
