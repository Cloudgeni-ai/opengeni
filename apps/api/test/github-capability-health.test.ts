import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GitHubCapabilityHealth, type AccessGrant } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  upsertGitHubInstallation,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps } from "@opengeni/core";

import { buildOpenGeniMcpServer, githubCredentialHealthForBindings } from "../src/mcp/server";
import {
  githubRepositoryCapabilityHealth,
  githubWorkspaceCapabilityHealth,
} from "../src/routes/github";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_github_capability_health");
  if (!shared) {
    available = false;
    console.warn("[github-capability-health] docker unavailable, skipping DB payload test");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("GitHub capability health", () => {
  test("workspace and repository projections distinguish configuration, binding, and readiness", () => {
    expect(githubWorkspaceCapabilityHealth({ configured: false, installationCount: 0 })).toEqual({
      state: "unavailable",
      reason: "not_configured",
      action: "configure",
      renewal: "inactive",
    });
    expect(githubWorkspaceCapabilityHealth({ configured: true, installationCount: 0 })).toEqual({
      state: "unavailable",
      reason: "no_repository_binding",
      action: "connect",
      renewal: "inactive",
    });
    expect(githubRepositoryCapabilityHealth(2)).toEqual({
      state: "ready",
      reason: null,
      action: "none",
      renewal: "automatic",
    });
    expect(githubRepositoryCapabilityHealth(0)).toEqual({
      state: "unavailable",
      reason: "no_repository_binding",
      action: "reconnect",
      renewal: "inactive",
    });
  });

  test("session projection reports host renewal or an exact connect/rebind action", () => {
    expect(
      githubCredentialHealthForBindings({
        configured: true,
        workspaceInstallationCount: 1,
        sessionInstallationIds: [41, 41],
      }),
    ).toEqual({ state: "ready", reason: null, action: "none", renewal: "automatic" });
    expect(
      githubCredentialHealthForBindings({
        configured: true,
        workspaceInstallationCount: 1,
        sessionInstallationIds: [],
      }),
    ).toEqual({
      state: "unavailable",
      reason: "session_repository_binding_required",
      action: "rebind",
      renewal: "inactive",
    });
    expect(
      githubCredentialHealthForBindings({
        configured: true,
        workspaceInstallationCount: 0,
        sessionInstallationIds: [],
      }),
    ).toEqual({
      state: "unavailable",
      reason: "no_repository_binding",
      action: "connect",
      renewal: "inactive",
    });
  });

  test("permissioned sessions see only the secret-safe status tool, never github_token", () => {
    const server = buildOpenGeniMcpServer(deps(), grant(["workspace:read", "github:use"]));
    const tools = Object.keys(
      (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
    );
    expect(tools).toContain("github_connect_link");
    expect(tools).toContain("github_credential_status");
    expect(tools).not.toContain("github_token");

    const narrowed = buildOpenGeniMcpServer(deps(), grant(["workspace:read"]));
    const narrowedTools = Object.keys(
      (narrowed as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ??
        {},
    );
    expect(narrowedTools).not.toContain("github_connect_link");
    expect(narrowedTools).not.toContain("github_credential_status");
  });

  test("credential status returns strict secret-safe truth for real session bindings", async () => {
    if (!available) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "opengeni:test",
      accountExternalId: `github-health-${suffix}`,
      accountName: "GitHub health",
      workspaceExternalSource: "opengeni:test",
      workspaceExternalId: `github-health-${suffix}`,
      workspaceName: "GitHub health",
      subjectId: "user:github-health",
    });
    const accountId = access.defaultAccountId!;
    const workspaceId = access.defaultWorkspaceId!;
    await upsertGitHubInstallation(client.db, {
      accountId,
      workspaceId,
      installationId: 41,
      accountLogin: "opengeni-test",
      accountType: "Organization",
    });
    const unbound = await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "unbound",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    const bound = await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "bound",
      resources: [
        {
          kind: "repository",
          uri: "https://github.com/opengeni-test/repo.git",
          ref: "main",
          githubInstallationId: 41,
          githubRepositoryId: 99,
        },
      ],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    const settings = testSettings({
      githubAppId: "1",
      githubClientId: "client-id",
      githubClientSecret: "client-secret",
      githubAppSlug: "opengeni-test",
      githubAppPrivateKey: "test-private-key",
    });
    const status = async (sessionId: string) =>
      await callMcpTool<{
        provider: string;
        credentialDelivery: string;
        health: unknown;
        repositoryBindings: number;
      }>(
        buildOpenGeniMcpServer(
          { ...deps(), settings, db: client.db } as never,
          grant(["workspace:read", "github:use"], { accountId, workspaceId, sessionId }),
        ),
        "github_credential_status",
      );

    const unboundStatus = await status(unbound.id);
    expect(GitHubCapabilityHealth.parse(unboundStatus.health)).toEqual({
      state: "unavailable",
      reason: "session_repository_binding_required",
      action: "rebind",
      renewal: "inactive",
    });
    const boundStatus = await status(bound.id);
    expect(GitHubCapabilityHealth.parse(boundStatus.health)).toEqual({
      state: "ready",
      reason: null,
      action: "none",
      renewal: "automatic",
    });
    expect(boundStatus).toMatchObject({
      provider: "github",
      credentialDelivery: "host_managed",
      repositoryBindings: 1,
    });
    expect(JSON.stringify([unboundStatus, boundStatus])).not.toMatch(/token/i);
  }, 180_000);
});

function deps(): ApiRouteDeps {
  return {
    settings: testSettings({}),
    db: {} as never,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as never;
}

function grant(
  permissions: AccessGrant["permissions"],
  ids: { accountId?: string; workspaceId?: string; sessionId?: string } = {},
): AccessGrant {
  return {
    accountId: ids.accountId ?? "00000000-0000-4000-8000-000000000001",
    workspaceId: ids.workspaceId ?? "00000000-0000-4000-8000-000000000002",
    subjectId: "user:github-health",
    permissions,
    metadata: { sessionId: ids.sessionId ?? "00000000-0000-4000-8000-000000000003" },
  };
}

async function callMcpTool<T>(server: unknown, name: string): Promise<T> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  const result = await tool.handler({}, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) throw new Error(`MCP tool returned no text: ${name}`);
  return JSON.parse(text) as T;
}
