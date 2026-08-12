import { describe, expect, test } from "bun:test";
import { verifyDelegatedAccessToken } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { mintSandboxCodemodeToken, sandboxEnvironmentForRun } from "../src/activities/environment";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const authority = {
  sessionId,
  turnId,
  attemptId,
  executionGeneration: 3,
};

describe("codemode token mint and sandbox delivery pointers", () => {
  test("renewal preserves session authority while advancing the signed expiry", async () => {
    const settings = testSettings({
      delegationSecret: "codemode-secret",
    });
    const firstNow = Date.now();
    const secondNow = firstNow + 10 * 60_000;
    const first = await mintSandboxCodemodeToken(
      settings,
      { accountId, workspaceId },
      authority,
      firstNow,
    );
    const second = await mintSandboxCodemodeToken(
      settings,
      { accountId, workspaceId },
      authority,
      secondNow,
    );

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.token).not.toBe(first!.token);
    const firstPayload = await verifyDelegatedAccessToken(settings.delegationSecret!, first!.token);
    const secondPayload = await verifyDelegatedAccessToken(
      settings.delegationSecret!,
      second!.token,
    );
    expect({ ...secondPayload, exp: firstPayload.exp }).toEqual(firstPayload);
    expect(first!.expiresAt.getTime()).toBe(firstPayload.exp! * 1000);
    expect(second!.expiresAt.getTime()).toBe(secondPayload.exp! * 1000);
    expect(secondPayload.exp! - firstPayload.exp!).toBe(10 * 60);
  });

  test("missing signing authority leaves configured deployments without Codemode material", async () => {
    const result = await sandboxEnvironmentForRun(
      testSettings({
        sandboxBackend: "modal",
        productAccessMode: "configured",
        delegationSecret: undefined,
        apiPort: 8000,
      }),
      [],
      {},
      {
        scope: { accountId, workspaceId },
        codemodeAuthority: authority,
      },
    );

    expect(result.codemodeToken).toBeUndefined();
    expect(result.environment.OPENGENI_CODEMODE_TOKEN_FILE).toBeUndefined();
    expect(result.environment.OPENGENI_CODEMODE_URL).toBeUndefined();
  });

  test("mints a narrow delegated token and exposes only stable pointers in env", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      delegationSecret: "codemode-secret",
      apiPort: 8000,
    });
    const result = await sandboxEnvironmentForRun(
      settings,
      [],
      {},
      {
        scope: { accountId, workspaceId },
        codemodeAuthority: authority,
      },
    );

    expect(result.codemodeToken).toMatch(/^ogd_/);
    expect(result.environment.OPENGENI_CODEMODE_TOKEN_FILE).toBe(
      "/workspace/.opengeni/codemode-token",
    );
    expect(result.environment.OPENGENI_CODEMODE_URL).toBe(
      `http://127.0.0.1:8000/v1/workspaces/${workspaceId}/codemode`,
    );
    expect(Object.values(result.environment)).not.toContain(result.codemodeToken);

    const payload = await verifyDelegatedAccessToken(
      settings.delegationSecret!,
      result.codemodeToken!,
    );
    expect(payload).toMatchObject({
      accountId,
      workspaceId,
      subjectId: `sandbox:${attemptId}`,
      subjectLabel: "sandbox Codemode",
      permissions: ["codemode:call"],
      sessionId,
      turnId,
      attemptId,
      executionGeneration: 3,
      principalKind: "agent_attempt",
    });
  });

  test("connected-machine turns mint transient material without manifest pointers", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      delegationSecret: "codemode-secret",
      apiPort: 8000,
    });
    const result = await sandboxEnvironmentForRun(
      settings,
      [],
      {},
      {
        scope: { accountId, workspaceId },
        codemodeAuthority: authority,
        codemodeDelivery: "transient_exec",
      },
    );

    expect(result.codemodeToken).toMatch(/^ogd_/);
    expect(result.codemodeTokenExpiresAt).toBeInstanceOf(Date);
    expect(result.environment.OPENGENI_CODEMODE_URL).toBeUndefined();
    expect(result.environment.OPENGENI_CODEMODE_TOKEN_FILE).toBeUndefined();
    expect(result.environment.OPENGENI_OGTOOL_PACKAGE_SPEC).toBeUndefined();
    expect(Object.values(result.environment)).not.toContain(result.codemodeToken);
  });

  test("explicitly disabled Codemode mints nothing and exposes no pointers", async () => {
    const result = await sandboxEnvironmentForRun(
      testSettings({ sandboxBackend: "modal", delegationSecret: "codemode-secret" }),
      [],
      {},
      {
        scope: { accountId, workspaceId },
        codemodeAuthority: authority,
        codemodeDelivery: "none",
      },
    );
    expect(result.codemodeToken).toBeUndefined();
    expect(result.environment.OPENGENI_CODEMODE_URL).toBeUndefined();
    expect(result.environment.OPENGENI_CODEMODE_TOKEN_FILE).toBeUndefined();
  });

  test("the token targets the public sandbox-routable API URL, never a cluster-internal one", async () => {
    // A remote managed sandbox reaches OpenGeni over the public base, so the URL
    // must never resolve to a loopback or cluster-internal address.
    const settings = testSettings({
      sandboxBackend: "modal",
      delegationSecret: "codemode-secret",
      apiPort: 8000,
      opengeniMcpUrl: "https://app.opengeni.example/v1/workspaces/{workspaceId}/mcp",
    });
    const result = await sandboxEnvironmentForRun(
      settings,
      [],
      {},
      {
        scope: { accountId, workspaceId },
        codemodeAuthority: authority,
      },
    );

    expect(result.environment.OPENGENI_CODEMODE_URL).toBe(
      `https://app.opengeni.example/v1/workspaces/${workspaceId}/codemode`,
    );
    expect(result.environment.OPENGENI_CODEMODE_URL).not.toContain("127.0.0.1");
  });
});
