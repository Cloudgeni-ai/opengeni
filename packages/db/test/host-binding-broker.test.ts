import { expect, test } from "bun:test";
import {
  buildHostConnectionTokenResolver,
  type HostMcpCredentialResolverContext,
  type ResolveConnectionCredentialInput,
} from "../src/connection-token-resolver";
import type { McpCredentialsRequest, McpCredentialResolution } from "@opengeni/contracts";

const context: HostMcpCredentialResolverContext = {
  accountId: "account",
  workspaceId: "workspace",
  sessionId: "session",
  rootSessionId: "root",
  turnId: "turn",
  attemptId: "attempt",
  executionGeneration: 1,
  initiator: { kind: "subject", subjectId: "external-owner" },
  initiatorContext: {},
  surface: "model",
};
function request(): ResolveConnectionCredentialInput {
  return {
    workspaceId: "workspace",
    serverId: "host",
    destinationUrl: "https://mcp.example/tools",
    connectionRef: {
      authoritySource: "host",
      connectionId: "opaque",
      providerDomain: "mcp.example",
      hostBinding: { bindingId: "ac94f59b-5a1e-4c56-a733-e5133b525b12", generation: 1 },
    },
  };
}
const credential = (input: McpCredentialsRequest): McpCredentialResolution => ({
  status: "ok",
  accountId: input.accountId,
  workspaceId: input.workspaceId,
  sessionId: input.sessionId,
  connectionId: "opaque",
  providerDomain: "mcp.example",
  headers: { authorization: "Bearer synthetic" },
});

test("durable host refs never call the provider without an explicit live validator", async () => {
  let calls = 0;
  const resolve = buildHostConnectionTokenResolver(async (input) => {
    calls++;
    return credential(input);
  }, context);
  expect(await resolve(request())).toMatchObject({
    status: "auth_needed",
    reason: "unsupported_auth",
  });
  expect(calls).toBe(0);
  const legacy = request();
  delete legacy.connectionRef.hostBinding;
  expect(await resolve(legacy)).toMatchObject({ status: "ok" });
  expect(calls).toBe(1);
});

test("revocation during host resolution discards credentials and validation receives immutable snapshots", async () => {
  const input = request();
  let active = true;
  const generations: number[] = [];
  const resolve = buildHostConnectionTokenResolver(
    async (hostRequest) => {
      active = false;
      hostRequest.connectionRef.hostBinding!.generation = 99;
      input.connectionRef.hostBinding!.generation = 88;
      return credential(hostRequest);
    },
    {
      ...context,
      authorizeDurableBinding: async (snapshot) => {
        generations.push(snapshot.connectionRef.hostBinding!.generation);
        snapshot.connectionRef.hostBinding!.generation = 77;
        return active;
      },
    },
  );
  expect(await resolve(input)).toMatchObject({
    status: "auth_needed",
    reason: "personal_authority_unavailable",
  });
  expect(generations).toEqual([1, 1]);
});

test("validator exceptions fail closed before provider effects", async () => {
  let called = false;
  const resolve = buildHostConnectionTokenResolver(
    async (input) => {
      called = true;
      return credential(input);
    },
    {
      ...context,
      authorizeDurableBinding: async () => {
        throw new Error("database unavailable");
      },
    },
  );
  expect(await resolve(request())).toMatchObject({
    status: "auth_needed",
    reason: "refresh_failed",
  });
  expect(called).toBe(false);
});

test("constructor mutation cannot retarget accepted authority or replace the live validator", async () => {
  let active = true;
  const snapshots: McpCredentialsRequest[] = [];
  const supplied = {
    ...context,
    initiator: { ...context.initiator },
    initiatorContext: {},
    authorizeDurableBinding: async (snapshot: McpCredentialsRequest) => {
      snapshots.push(structuredClone(snapshot));
      return active;
    },
  };
  const resolve = buildHostConnectionTokenResolver(async (snapshot) => {
    active = false;
    supplied.authorizeDurableBinding = async () => true;
    supplied.accountId = "retargeted-account";
    return credential(snapshot);
  }, supplied);
  supplied.initiator.subjectId = "retargeted-owner";
  supplied.rootSessionId = "retargeted-root";
  expect(await resolve(request())).toMatchObject({
    status: "auth_needed",
    reason: "personal_authority_unavailable",
  });
  expect(snapshots).toHaveLength(2);
  for (const snapshot of snapshots) {
    expect(snapshot.accountId).toBe("account");
    expect(snapshot.rootSessionId).toBe("root");
    expect(snapshot.initiator).toEqual(context.initiator);
  }
});

test("each physical request rechecks durable authority after credential resolution", async () => {
  let active = true;
  let unavailable = false;
  const generations: number[] = [];
  const input = request();
  const resolve = buildHostConnectionTokenResolver(async (snapshot) => credential(snapshot), {
    ...context,
    authorizeDurableBinding: async (snapshot) => {
      generations.push(snapshot.connectionRef.hostBinding!.generation);
      snapshot.connectionRef.hostBinding!.generation = 99;
      if (unavailable) throw new Error("database unavailable");
      return active;
    },
  });
  const result = await resolve(input);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("expected credential resolution");
  expect(result.authorizeProviderRequest).toBeTypeOf("function");
  input.connectionRef.hostBinding!.generation = 88;
  expect(await result.authorizeProviderRequest!()).toBe(true);
  active = false;
  expect(await result.authorizeProviderRequest!()).toBe(false);
  active = true;
  unavailable = true;
  expect(await result.authorizeProviderRequest!()).toBe(false);
  expect(generations).toEqual([1, 1, 1, 1, 1]);
});

test("host refs without durable binding preserve the existing transport contract", async () => {
  const input = request();
  delete input.connectionRef.hostBinding;
  const resolve = buildHostConnectionTokenResolver(
    async (snapshot) => credential(snapshot),
    context,
  );
  const result = await resolve(input);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("expected credential resolution");
  expect(result.authorizeProviderRequest).toBeUndefined();
});
