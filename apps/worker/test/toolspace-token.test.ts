import { describe, expect, test } from "bun:test";
import { verifyDelegatedAccessToken } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { mintSandboxToolspaceToken, sandboxEnvironmentForRun } from "../src/activities/environment";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

describe("toolspace token mint and sandbox delivery pointers", () => {
  test("renewal preserves frozen authority while advancing the signed expiry", async () => {
    const settings = testSettings({
      delegationSecret: "toolspace-secret",
      toolspaceEnabled: true,
    });
    const firstNow = Date.now();
    const secondNow = firstNow + 10 * 60_000;
    const first = await mintSandboxToolspaceToken(
      settings,
      { accountId, workspaceId },
      sessionId,
      "run-1",
      firstNow,
    );
    const second = await mintSandboxToolspaceToken(
      settings,
      { accountId, workspaceId },
      sessionId,
      "run-1",
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

  test("feature off leaves the sandbox env byte-identical: no token, file path, or URL", async () => {
    const result = await sandboxEnvironmentForRun(
      testSettings({
        sandboxBackend: "modal",
        delegationSecret: "toolspace-secret",
        toolspaceEnabled: false,
        apiPort: 8000,
      }),
      [],
      {},
      {
        scope: { accountId, workspaceId },
        sessionId,
        runId: "run-1",
      },
    );

    expect(result.toolspaceToken).toBeUndefined();
    expect(result.environment.OPENGENI_TOOLSPACE_TOKEN_FILE).toBeUndefined();
    expect(result.environment.OPENGENI_TOOLSPACE_URL).toBeUndefined();
  });

  test("feature on mints a narrow delegated token and exposes only stable pointers in env", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      delegationSecret: "toolspace-secret",
      toolspaceEnabled: true,
      apiPort: 8000,
    });
    const result = await sandboxEnvironmentForRun(
      settings,
      [],
      {},
      {
        scope: { accountId, workspaceId },
        sessionId,
        runId: "run-1",
      },
    );

    expect(result.toolspaceToken).toMatch(/^ogd_/);
    expect(result.environment.OPENGENI_TOOLSPACE_TOKEN_FILE).toBe(
      "/workspace/.opengeni/toolspace-token",
    );
    expect(result.environment.OPENGENI_TOOLSPACE_URL).toBe(
      `http://127.0.0.1:8000/v1/workspaces/${workspaceId}/mcp`,
    );
    expect(Object.values(result.environment)).not.toContain(result.toolspaceToken);

    const payload = await verifyDelegatedAccessToken(
      settings.delegationSecret!,
      result.toolspaceToken!,
    );
    expect(payload).toMatchObject({
      accountId,
      workspaceId,
      subjectId: "sandbox:run-1",
      subjectLabel: "sandbox toolspace",
      permissions: ["toolspace:call"],
      sessionId,
    });
  });

  test("connected-machine (selfhosted) turns mint the token too — there is no skip path", async () => {
    // Selfhosted parity: the toolspace token is minted on every backend. Unlike
    // the platform GitHub token (inert on a connected machine), the toolspace
    // token is the machine's only path to programmatic tool calling and grants no
    // more than the owner's own authority, so the previous skip is gone entirely.
    // `sandboxEnvironmentForRun` is backend-agnostic; the removed option means a
    // connected-machine turn mints exactly like a modal turn.
    const settings = testSettings({
      sandboxBackend: "modal",
      delegationSecret: "toolspace-secret",
      toolspaceEnabled: true,
      apiPort: 8000,
    });
    const result = await sandboxEnvironmentForRun(
      settings,
      [],
      {},
      {
        scope: { accountId, workspaceId },
        sessionId,
        runId: "run-1",
      },
    );

    expect(result.toolspaceToken).toMatch(/^ogd_/);
    expect(result.environment.OPENGENI_TOOLSPACE_TOKEN_FILE).toBe(
      "/workspace/.opengeni/toolspace-token",
    );
    // The token VALUE stays off-manifest (delivered via the exec-channel seed).
    expect(Object.values(result.environment)).not.toContain(result.toolspaceToken);
  });

  test("the token targets the PUBLIC, machine-routable API URL, never a cluster-internal one", async () => {
    // A connected machine enrolled against the public base and reaches OpenGeni
    // over the internet, so OPENGENI_TOOLSPACE_URL must resolve to the same
    // sandbox-routable base every remote backend uses (OPENGENI_MCP_URL), not the
    // loopback default that only works for a co-located box.
    const settings = testSettings({
      sandboxBackend: "modal",
      delegationSecret: "toolspace-secret",
      toolspaceEnabled: true,
      apiPort: 8000,
      opengeniMcpUrl: "https://app.opengeni.example/v1/workspaces/{workspaceId}/mcp",
    });
    const result = await sandboxEnvironmentForRun(
      settings,
      [],
      {},
      {
        scope: { accountId, workspaceId },
        sessionId,
        runId: "run-1",
      },
    );

    expect(result.environment.OPENGENI_TOOLSPACE_URL).toBe(
      `https://app.opengeni.example/v1/workspaces/${workspaceId}/mcp`,
    );
    expect(result.environment.OPENGENI_TOOLSPACE_URL).not.toContain("127.0.0.1");
  });
});
