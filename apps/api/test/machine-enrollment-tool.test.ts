import { expect, test } from "bun:test";
import {
  verifyEnrollToken,
  type AccessGrant,
  type FirstPartyMcpToolName,
} from "@opengeni/contracts";
import { testSettings, MemoryEventBus } from "@opengeni/testing";
import type { ApiRouteDeps } from "@opengeni/core";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

const name = "connected_machine_enroll_token";
const secret = "synthetic-enrollment-signing-secret";
const grant: AccessGrant = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  subjectId: "user:test",
  principalKind: "human_session",
  permissions: ["enrollments:manage"],
};
function setup(overrides: Record<string, unknown> = {}, authority = grant) {
  const deps = {
    settings: testSettings({
      sandboxSelfhostedEnabled: true,
      publicBaseUrl: "https://control.example.test/",
      enrollmentSigningSecret: secret,
      ...overrides,
    }),
    db: {},
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
  } as unknown as ApiRouteDeps;
  const server = buildOpenGeniMcpServer(deps, authority);
  return (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
            extra: unknown,
          ) => Promise<{ content: { text: string }[] }>;
        }
      >;
    }
  )._registeredTools[name];
}

test("enrollment tool uses existing permission and feature gates", () => {
  expect(setup()).toBeDefined();
  expect(setup({}, { ...grant, permissions: ["sessions:control"] })).toBeUndefined();
  expect(setup({ sandboxSelfhostedEnabled: false })).toBeUndefined();
});

test("agent enrollment tool respects exact signed selection without widening permissions", () => {
  const agent: AccessGrant = {
    ...grant,
    principalKind: "agent_attempt",
    metadata: {
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      firstPartyMcpTools: [name as FirstPartyMcpToolName],
    },
  };
  expect(setup({}, agent)).toBeDefined();
  expect(setup({}, { ...agent, permissions: ["sessions:control"] })).toBeUndefined();
  expect(
    setup({}, { ...agent, metadata: { ...agent.metadata, firstPartyMcpTools: [] } }),
  ).toBeUndefined();
});

test("enrollment tool returns bound expiring token and exact deployment commands", async () => {
  for (const allowScreenControl of [false, true]) {
    const result = await setup()!.handler(
      { allowScreenControl, workspaceId: crypto.randomUUID() },
      {},
    );
    const output = JSON.parse(result.content[0]!.text);
    const claims = await verifyEnrollToken(secret, output.token);
    expect(claims).toMatchObject({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      allowScreenControl,
    });
    expect(output.expiresInSeconds).toBe(3600);
    expect(Date.parse(output.expiresAt)).toBe(claims!.exp * 1000);
    expect(await verifyEnrollToken(secret, output.token, claims!.exp + 1)).toBeNull();
    expect(output.installCommandUnix).toContain("https://control.example.test/install.sh");
    expect(output.installCommandUnix).toContain(output.token);
    expect(output.installCommandWindows).toContain("https://control.example.test/install.ps1");
    expect(output.installCommandWindows).toContain(output.token);
  }
});

test("screen control defaults off and tokens cannot be verified with another secret", async () => {
  const result = await setup()!.handler({}, {});
  const output = JSON.parse(result.content[0]!.text);
  expect(await verifyEnrollToken(secret, output.token)).toMatchObject({
    allowScreenControl: false,
  });
  expect(await verifyEnrollToken("other-deployment-secret", output.token)).toBeNull();
});

test("enrollment tool fails without signing configuration", async () => {
  await expect(
    setup({ enrollmentSigningSecret: undefined, delegationSecret: undefined })!.handler({}, {}),
  ).rejects.toThrow("enrollment credential plane is not configured");
});
