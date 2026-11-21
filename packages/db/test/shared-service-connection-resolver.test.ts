// Shared service connections (docs/secrets.md): a workspace-owned API-key
// connection whose stored headers hold vault references. The resolver swaps
// the values in only for a real request, through the injected resolution,
// and fails closed otherwise.
import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildConnectionTokenResolver,
  type ConnectionBrokerDeps,
  type ConnectionCredentialForBroker,
  type CredentialReferenceResolution,
  type Database,
} from "../src/index";

const REFERENCE = "{{secret:Team/Linear key}}";
const settings = testSettings() as Settings;

function sharedKey(overrides: Partial<ConnectionCredentialForBroker> = {}): ConnectionCredentialForBroker {
  return {
    id: "shared-linear",
    accountId: "acct_1",
    workspaceId: "ws_1",
    subjectId: null,
    providerDomain: "mcp.linear.app",
    kind: "api_key",
    status: "active",
    credential: { headers: { Authorization: `Bearer ${REFERENCE}` } },
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    version: 1,
    metadata: {
      mcpUrl: "https://mcp.linear.app/mcp",
      credentialSource: "vault",
      credentialReferences: [REFERENCE],
    },
    ...overrides,
  };
}

function deps(credential: ConnectionCredentialForBroker) {
  const counts = { recordUsed: 0 };
  const value: ConnectionBrokerDeps = {
    withRefreshLock: async (database, _credential, work) => work(database),
    loadCredential: async () => credential,
    recordRefresh: async () => true,
    setStatus: async () => true,
    recordUsed: async () => {
      counts.recordUsed += 1;
    },
    refresh: async () => {
      throw new Error("API keys are never refreshed");
    },
    encrypt: () => "v1:enc",
    keyBytes: () => new Uint8Array(32),
    now: () => new Date(),
  };
  return { deps: value, counts };
}

const input = {
  workspaceId: "ws_1",
  subjectId: "user:a",
  serverId: "linear",
  toolName: "list_issues",
  destinationUrl: "https://mcp.linear.app/mcp",
  connectionRef: {
    providerDomain: "mcp.linear.app",
    kind: "api_key" as const,
    subjectScope: "workspace" as const,
  },
};

describe("shared service connections", () => {
  test("resolve the reference for the request, with the connection's identity", async () => {
    const seen: CredentialReferenceResolution[] = [];
    const { deps: broker, counts } = deps(sharedKey());
    const resolver = buildConnectionTokenResolver({} as Database, settings, broker, {
      resolveCredentialReferences: async (request) => {
        seen.push(request);
        return { Authorization: "Bearer synthetic-value" };
      },
    });
    expect(await resolver(input)).toMatchObject({
      status: "ok",
      connectionId: "shared-linear",
      headers: { Authorization: "Bearer synthetic-value" },
    });
    expect(seen).toEqual([
      {
        connection: {
          id: "shared-linear",
          accountId: "acct_1",
          workspaceId: "ws_1",
          providerDomain: "mcp.linear.app",
        },
        headers: { Authorization: `Bearer ${REFERENCE}` },
        serverId: "linear",
        toolName: "list_issues",
        destinationUrl: "https://mcp.linear.app/mcp",
      },
    ]);
    expect(counts.recordUsed).toBe(1);
  });

  test("the credential-free preflight reads nothing and sends no headers", async () => {
    let calls = 0;
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps(sharedKey()).deps, {
      resolveCredentialReferences: async () => {
        calls += 1;
        return {};
      },
    });
    expect(await resolver({ ...input, credentialResolutionMode: "preflight" })).toMatchObject({
      status: "ok",
      headers: {},
    });
    expect(calls).toBe(0);
  });

  test("fail closed without a resolution or when it throws; never send the reference", async () => {
    const missing = buildConnectionTokenResolver({} as Database, settings, deps(sharedKey()).deps);
    const failing = buildConnectionTokenResolver({} as Database, settings, deps(sharedKey()).deps, {
      resolveCredentialReferences: async () => {
        throw new Error("item not found");
      },
    });
    for (const resolver of [missing, failing]) {
      const result = await resolver(input);
      expect(result).toMatchObject({
        status: "auth_needed",
        reason: "designated_credential_unavailable",
      });
      expect(JSON.stringify(result)).not.toContain("secret:");
      expect(JSON.stringify(result)).not.toContain("item not found");
    }
  });

  test("only a workspace-owned header key may hold references", async () => {
    const resolve = async () => ({ Authorization: "Bearer synthetic-value" });
    for (const credential of [
      sharedKey({ subjectId: "user:a" }),
      sharedKey({ kind: "oauth2" }),
      sharedKey({
        credential: {
          headers: { Authorization: `Bearer ${REFERENCE}` },
          placements: [{ carrier: "query", name: "key", value: REFERENCE }],
        },
      }),
    ]) {
      const resolver = buildConnectionTokenResolver({} as Database, settings, deps(credential).deps, {
        resolveCredentialReferences: resolve,
      });
      const result = await resolver({
        ...input,
        connectionRef: {
          ...input.connectionRef,
          kind: credential.kind,
          subjectScope: credential.subjectId ? ("subject" as const) : ("workspace" as const),
        },
      });
      expect(result.status).toBe("auth_needed");
      expect(JSON.stringify(result)).not.toContain("synthetic-value");
    }
  });

  test("an ordinary API-key connection keeps its literal headers", async () => {
    let calls = 0;
    const literal = sharedKey({
      credential: { headers: { Authorization: "Bearer literal" } },
      metadata: { mcpUrl: "https://mcp.linear.app/mcp" },
    });
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps(literal).deps, {
      resolveCredentialReferences: async () => {
        calls += 1;
        return {};
      },
    });
    expect(await resolver(input)).toMatchObject({
      status: "ok",
      headers: { Authorization: "Bearer literal" },
    });
    expect(calls).toBe(0);
  });
});
