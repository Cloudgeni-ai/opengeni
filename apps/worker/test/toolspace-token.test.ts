import { describe, expect, test } from "bun:test";
import { verifyDelegatedAccessToken } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { sandboxEnvironmentForRun } from "../src/activities/environment";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";

const toolspaceScope = {
  scope: { accountId, workspaceId },
  sessionId,
  turnId,
  attemptId,
  executionGeneration: 3,
} as const;

describe("toolspace token mint and sandbox delivery pointers", () => {
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
      toolspaceScope,
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
    const result = await sandboxEnvironmentForRun(settings, [], {}, toolspaceScope);

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
      subjectId: `sandbox:${turnId}`,
      subjectLabel: "sandbox toolspace",
      permissions: ["toolspace:call"],
      sessionId,
      turnId,
      attemptId,
      executionGeneration: 3,
    });
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 59 * 60);
    expect(payload!.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60 * 60);
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
    const result = await sandboxEnvironmentForRun(settings, [], {}, toolspaceScope);

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
    const result = await sandboxEnvironmentForRun(settings, [], {}, toolspaceScope);

    expect(result.environment.OPENGENI_TOOLSPACE_URL).toBe(
      `https://app.opengeni.example/v1/workspaces/${workspaceId}/mcp`,
    );
    expect(result.environment.OPENGENI_TOOLSPACE_URL).not.toContain("127.0.0.1");
  });

  test("omitting any attempt fence claim fails closed without minting", async () => {
    const settings = testSettings({
      delegationSecret: "toolspace-secret",
      toolspaceEnabled: true,
    });
    for (const missing of ["turnId", "attemptId", "executionGeneration"] as const) {
      const options: Parameters<typeof sandboxEnvironmentForRun>[3] = { ...toolspaceScope };
      delete options[missing];
      const result = await sandboxEnvironmentForRun(settings, [], {}, options);
      expect(result.toolspaceToken).toBeUndefined();
    }
  });
});
