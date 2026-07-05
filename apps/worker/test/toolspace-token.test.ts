import { describe, expect, test } from "bun:test";
import { verifyDelegatedAccessToken } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { sandboxEnvironmentForRun } from "../src/activities/environment";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

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
    const result = await sandboxEnvironmentForRun(settings, [], {}, {
      scope: { accountId, workspaceId },
      sessionId,
      runId: "run-1",
    });

    expect(result.toolspaceToken).toMatch(/^ogd_/);
    expect(result.environment.OPENGENI_TOOLSPACE_TOKEN_FILE).toBe("/workspace/.opengeni/toolspace-token");
    expect(result.environment.OPENGENI_TOOLSPACE_URL).toBe(`http://127.0.0.1:8000/v1/workspaces/${workspaceId}/mcp`);
    expect(Object.values(result.environment)).not.toContain(result.toolspaceToken);

    const payload = await verifyDelegatedAccessToken(settings.delegationSecret!, result.toolspaceToken!);
    expect(payload).toMatchObject({
      accountId,
      workspaceId,
      subjectId: "sandbox:run-1",
      subjectLabel: "sandbox toolspace",
      permissions: ["toolspace:call"],
      sessionId,
    });
  });

  test("skipToolspaceToken suppresses the credential mint for connected-machine turns", async () => {
    const result = await sandboxEnvironmentForRun(
      testSettings({
        sandboxBackend: "modal",
        delegationSecret: "toolspace-secret",
        toolspaceEnabled: true,
        apiPort: 8000,
      }),
      [],
      {},
      {
        scope: { accountId, workspaceId },
        sessionId,
        runId: "run-1",
        skipToolspaceToken: true,
      },
    );

    expect(result.toolspaceToken).toBeUndefined();
    expect(result.environment.OPENGENI_TOOLSPACE_TOKEN_FILE).toBe("/workspace/.opengeni/toolspace-token");
    expect(result.environment.OPENGENI_TOOLSPACE_URL).toBe(`http://127.0.0.1:8000/v1/workspaces/${workspaceId}/mcp`);
  });
});
