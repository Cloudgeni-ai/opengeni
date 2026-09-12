import { expect, test } from "bun:test";
import { hostMcpCredentialUseGuard, type McpCredentialsRequest } from "@opengeni/contracts";
import type { HostMcpResolverRoute } from "@opengeni/db";
import { createRemoteMcpCredentialsPort } from "../src/remote-mcp-credentials";

const accountId = "11111111-1111-4111-8111-111111111111";
const request: McpCredentialsRequest = {
  accountId,
  workspaceId: "workspace",
  sessionId: "session",
  rootSessionId: "session",
  turnId: "turn",
  attemptId: "attempt",
  executionGeneration: 1,
  initiator: { kind: "subject", subjectId: "external:alice" },
  initiatorContext: {},
  surface: "model",
  serverId: "tools",
  destinationUrl: "https://tools.example/mcp",
  forceRefresh: false,
  connectionRef: {
    authoritySource: "host",
    providerDomain: "tools.example",
    connectionId: "alice-account",
  },
};
const settings = {
  environment: "test",
  integrationsAllowPrivateNetworkTargets: false,
  hostMcpCredentialResolversJson: JSON.stringify([
    { accountId, url: "https://legacy.example/credentials", bearerToken: "legacy" },
  ]),
};
const initial: HostMcpResolverRoute = {
  mode: "namespace",
  id: "registration",
  generation: 1,
  accountId,
  workspaceId: "workspace",
  externalSource: "instance",
  url: "https://one.example/credentials",
  bearerToken: "one",
  timeoutMs: 10_000,
};

test("native routing coalesces only within a generation; every waiter retains its local use guard", async () => {
  let route = { ...initial };
  let calls = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const port = createRemoteMcpCredentialsPort(
    settings,
    async (_url, init) => {
      calls++;
      const envelope = JSON.parse(String(init?.body));
      if (new Headers(init?.headers).get("Authorization") === "Bearer one") {
        entered.resolve();
        await release.promise;
      }
      return Response.json({
        version: 1,
        requestId: envelope.requestId,
        destinationUrl: request.destinationUrl,
        resolution: {
          status: "ok",
          accountId,
          workspaceId: "workspace",
          sessionId: "session",
          providerDomain: "tools.example",
          connectionId: "alice-account",
          headers: { authorization: "Bearer provider" },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    },
    {
      resolve: async () => ({ ...route }),
      isCurrent: async (_request, captured) =>
        captured.mode === "namespace" &&
        captured.generation === route.generation &&
        captured.id === route.id,
    },
  );
  const first = port.mcpCredentials!(request);
  await entered.promise;
  const second = port.mcpCredentials!(request);
  // Let the second resolver capture N before updating to N+1.
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(1);
  route = { ...route, generation: 2, url: "https://two.example/credentials", bearerToken: "two" };
  const fresh = await port.mcpCredentials!(request);
  expect(calls).toBe(2);
  expect(fresh.status).toBe("ok");
  release.resolve();
  expect((await first).status).toBe("auth_needed");
  expect((await second).status).toBe("auth_needed");
  if (fresh.status !== "ok") throw new Error("expected fresh resolution");
  expect(await fresh[hostMcpCredentialUseGuard]!()).toBe(true);
  expect(JSON.stringify(fresh)).not.toContain("hostMcpCredentialUseGuard");
  route = { ...route, generation: 3 };
  expect(await fresh[hostMcpCredentialUseGuard]!()).toBe(false);
});

test("missing/revoked namespace and database failure never use static fallback", async () => {
  let calls = 0;
  for (const failure of [false, true]) {
    const port = createRemoteMcpCredentialsPort(
      settings,
      async () => {
        calls++;
        throw new Error("must not dispatch");
      },
      {
        resolve: async () => {
          if (failure) throw new Error("database unavailable");
          return { mode: "denied" };
        },
        isCurrent: async () => false,
      },
    );
    expect((await port.mcpCredentials!(request)).status).toBe("auth_needed");
  }
  expect(calls).toBe(0);
});

test("native registrations retain the real pinned transport's private-network and HTTPS policy", async () => {
  for (const url of [
    "https://127.0.0.1/credentials",
    "https://169.254.169.254/credentials",
    "http://127.0.0.1/credentials",
  ]) {
    const port = createRemoteMcpCredentialsPort(
      { ...settings, environment: "production" },
      undefined,
      {
        resolve: async () => ({ ...initial, url }),
        isCurrent: async () => true,
      },
    );
    expect(await port.mcpCredentials!(request)).toMatchObject({
      status: "auth_needed",
      reason: "refresh_failed",
    });
  }
});
