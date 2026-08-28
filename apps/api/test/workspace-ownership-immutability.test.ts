import { describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";
import { workspaceUpdateRequestsAccountTransfer } from "../src/routes/workspaces";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const DELEGATION_SECRET = "workspace-ownership-immutability-test-secret";

async function authorizedApp() {
  const app = createApp({
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
    }),
    db: new Proxy(
      {},
      {
        get() {
          throw new Error("workspace transfer rejection unexpectedly touched the database");
        },
      },
    ) as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    subjectId: "user:workspace-owner",
    permissions: ["workspace:admin"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 60,
  });
  return { app, authorization: `Bearer ${token}` };
}

describe("immutable workspace organization ownership", () => {
  test("detects accountId by presence, including null and the current organization", () => {
    expect(workspaceUpdateRequestsAccountTransfer({ accountId: OTHER_ACCOUNT_ID })).toBe(true);
    expect(workspaceUpdateRequestsAccountTransfer({ accountId: null })).toBe(true);
    expect(workspaceUpdateRequestsAccountTransfer({ name: "Renamed" })).toBe(false);
    expect(workspaceUpdateRequestsAccountTransfer(null)).toBe(false);
  });

  test("the authorized Hono PATCH rejects accountId before any database write", async () => {
    const { app, authorization } = await authorizedApp();
    const response = await app.request(`http://opengeni.test/v1/workspaces/${WORKSPACE_ID}`, {
      method: "PATCH",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ name: "Moved", accountId: OTHER_ACCOUNT_ID }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "conflict",
        message: expect.stringContaining("permanently owned by one organization"),
        retryable: false,
        details: { code: "workspace_transfer_unsupported" },
      },
    });
  });
});
