import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";
import { codexWorkerReadiness } from "../src/routes/codex";

const DELEGATION_SECRET = "codex-routes-delegation-secret";
const STATE_SECRET = "codex-routes-state-secret";
const WS_A = "00000000-0000-4000-8000-0000000000a1";
const WS_B = "00000000-0000-4000-8000-0000000000b2";
const ACCOUNT = "00000000-0000-4000-8000-0000000000c3";

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: Buffer.alloc(32, 17).toString("base64"),
});

// db must never be touched on the paths under test (auth from token; start/poll
// reach the device endpoints, not the database). It throws if it ever is.
const poisonDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db must not be touched on these route paths");
    },
  },
);

function app() {
  return createApp({
    settings,
    db: poisonDb as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    githubStateSecret: STATE_SECRET,
  } as never);
}

async function bearer(workspaceId: string, permissions: Permission[]): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: ACCOUNT,
    workspaceId,
    subjectId: "tester",
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `Bearer ${token}`;
}

const realFetch = globalThis.fetch;
const restores: Array<() => void> = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  while (restores.length) restores.pop()!();
});

describe("Codex status readiness semantics", () => {
  test("session account metadata is authorized separately and never accepts a caller-selected turn or source", async () => {
    const sessionId = crypto.randomUUID();
    const account = {
      id: crypto.randomUUID(),
      source: "workspace",
      label: "Accepted account",
      status: "active",
      isActive: true,
      primaryUsedPercent: 15,
      primaryResetAt: null,
      secondaryUsedPercent: 20,
      secondaryResetAt: null,
      allocatorEnabled: true,
      allocatorVersion: 1,
      connectedBySubjectId: "secret-owner",
      credentialEncrypted: "must-not-leak",
    } as unknown as opengeniDb.CodexAccountStatus;
    const authority = spyOn(opengeniDb, "getSessionAuthorityProjection").mockResolvedValue(null);
    const slack = spyOn(opengeniDb, "getSlackInteractionSessionAccessForSession").mockResolvedValue(
      null,
    );
    const projection = spyOn(opengeniDb, "getSessionCodexAccounts").mockResolvedValue({
      accounts: [account],
      currentAccount: account,
      currentSelection: { credentialId: account.id, waiting: true },
      rotation: {
        activeCredentialId: account.id,
        rotationEnabled: true,
        rotationStrategy: "sharded",
      },
      pinnedAccountId: account.id,
      lastAccountId: null,
    });
    restores.push(
      () => authority.mockRestore(),
      () => slack.mockRestore(),
      () => projection.mockRestore(),
    );
    const path = `/v1/workspaces/${WS_A}/sessions/${sessionId}/codex-accounts`;
    const response = await app().request(
      `${path}?turnId=${crypto.randomUUID()}&source=organization`,
      {
        headers: { authorization: await bearer(WS_A, ["workspace:read", "sessions:read"]) },
      },
    );
    expect(response.status).toBe(200);
    expect(projection).toHaveBeenCalledWith(expect.anything(), WS_A, sessionId);
    const body = await response.json();
    expect(body).toMatchObject({
      accounts: [{ id: account.id, canEnableApps: false, appsDesignated: false }],
      currentAccount: { id: account.id },
      currentSelection: { waiting: true },
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
    expect(JSON.stringify(body)).not.toContain("secret-owner");
    const calls = projection.mock.calls.length;
    for (const permissions of [["workspace:read"], ["sessions:read"]] as Permission[][]) {
      expect(
        (await app().request(path, { headers: { authorization: await bearer(WS_A, permissions) } }))
          .status,
      ).toBe(403);
    }
    expect(projection.mock.calls.length).toBe(calls);
    projection.mockResolvedValue(null);
    expect(
      (
        await app().request(path, {
          headers: { authorization: await bearer(WS_A, ["workspace:read", "sessions:read"]) },
        })
      ).status,
    ).toBe(404);
  });
  const now = new Date("2026-09-03T12:00:00.000Z");
  const healthy = {
    id: "healthy",
    status: "active",
    allocatorEnabled: true,
    primaryUsedPercent: 0,
    primaryResetAt: null,
    secondaryUsedPercent: 0,
    secondaryResetAt: null,
    exhaustedUntil: null,
  } as const;

  test("reports pool readiness separately from rotation-off pointer routability", () => {
    const result = codexWorkerReadiness({
      effectiveSource: "workspace",
      rotationEnabled: false,
      activeCredentialId: "capped",
      accounts: [
        healthy,
        {
          ...healthy,
          id: "capped",
          primaryUsedPercent: 100,
          primaryResetAt: new Date("2026-09-04T12:00:00.000Z"),
        },
      ],
      now,
    });

    expect(result).toEqual({ poolReady: true, workerRoutable: false });
  });

  test("reports disabled sources as neither pool-ready nor worker-routable", () => {
    expect(
      codexWorkerReadiness({
        effectiveSource: "disabled",
        rotationEnabled: true,
        activeCredentialId: healthy.id,
        accounts: [healthy],
        now,
      }),
    ).toEqual({ poolReady: false, workerRoutable: false });
  });

  test("status response keeps active-account probe fields distinct from pool readiness", async () => {
    const active = {
      id: "active",
      source: "workspace" as const,
      chatgptAccountId: "chatgpt-active",
      label: "Active account",
      accountEmail: null,
      planType: "pro",
      status: "active",
      allocatorEnabled: true,
      allocatorVersion: 1,
      allocatorUpdatedBySubjectId: null,
      allocatorUpdatedAt: null,
      resetCreditAvailableCount: null,
      resetCreditsCheckedAt: null,
      connectedBySubjectId: null,
      isActive: true,
      expiresAt: null,
      lastRefreshAt: null,
      lastError: null,
      primaryUsedPercent: 0,
      primaryResetAt: null,
      secondaryUsedPercent: 0,
      secondaryResetAt: null,
      usageCheckedAt: null,
      exhaustedUntil: null,
      exhaustedKind: null,
    } satisfies opengeniDb.CodexAccountStatus;
    const status = spyOn(opengeniDb, "getCodexCredentialStatus").mockResolvedValue({
      connected: true,
      credentialId: active.id,
      chatgptAccountId: active.chatgptAccountId,
      scopes: null,
      planType: active.planType,
      status: active.status,
      expiresAt: null,
      lastRefreshAt: null,
      lastError: null,
    });
    const accounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockResolvedValue([active]);
    const source = spyOn(opengeniDb, "getWorkspaceCodexSubscriptionSource").mockResolvedValue({
      accountId: ACCOUNT,
      workspaceId: WS_A,
      workspaceKind: "shared",
      mode: "workspace",
      effectiveSource: "workspace",
      workspaceAvailable: true,
      organizationAvailable: false,
    });
    const rotation = spyOn(opengeniDb, "getCodexRotationSettings").mockResolvedValue({
      activeCredentialId: active.id,
      rotationEnabled: true,
      rotationStrategy: "sharded",
    });
    const load = spyOn(opengeniDb, "loadCodexCredentialForRun").mockResolvedValue(null);
    restores.push(
      () => status.mockRestore(),
      () => accounts.mockRestore(),
      () => source.mockRestore(),
      () => rotation.mockRestore(),
      () => load.mockRestore(),
    );

    const res = await app().request(`/v1/workspaces/${WS_A}/codex/status`, {
      headers: { authorization: await bearer(WS_A, ["workspace:read"]) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      connected: true,
      valid: false,
      activeAccountValid: false,
      poolReady: true,
      workerRoutable: true,
      activeAccount: {
        id: active.id,
        label: active.label,
        chatgptAccountId: active.chatgptAccountId,
      },
      accountCount: 1,
      models: [
        { id: "codex/gpt-6-sol", label: "GPT-6 Sol" },
        { id: "codex/gpt-6-luna", label: "GPT-6 Luna" },
        { id: "codex/gpt-6-astra", label: "GPT-6 Astra" },
      ],
    });
  });
});

function mockDevice(handlers: {
  usercode?: () => Response;
  token?: () => Response;
  exchange?: () => Response;
}) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/deviceauth/usercode") && handlers.usercode) return handlers.usercode();
    if (url.includes("/deviceauth/token") && handlers.token) return handlers.token();
    if (url.includes("/oauth/token") && handlers.exchange) return handlers.exchange();
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

async function start(
  workspaceId: string,
): Promise<{ status: number; body: { userCode: string; verificationUri: string; state: string } }> {
  const res = await app().request(`/v1/workspaces/${workspaceId}/codex/connect/start`, {
    method: "POST",
    headers: {
      authorization: await bearer(workspaceId, ["connections:write"]),
      "content-type": "application/json",
    },
  });
  return {
    status: res.status,
    body: (await res.json()) as { userCode: string; verificationUri: string; state: string },
  };
}

describe("codex connect routes", () => {
  test("connect/start returns the user code, verification URL and a signed state", async () => {
    mockDevice({
      usercode: () => json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" }),
    });
    const { status, body } = await start(WS_A);
    expect(status).toBe(200);
    expect(body.userCode).toBe("ABCD-1234");
    expect(body.verificationUri).toBe("https://auth.openai.com/codex/device");
    expect(typeof body.state).toBe("string");
  });

  test("connect/poll relays a pending device authorization", async () => {
    mockDevice({
      usercode: () => json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" }),
    });
    const { body } = await start(WS_A);
    mockDevice({ token: () => new Response("", { status: 403 }) }); // still pending
    const res = await app().request(`/v1/workspaces/${WS_A}/codex/connect/poll`, {
      method: "POST",
      headers: {
        authorization: await bearer(WS_A, ["connections:write"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: body.state }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
  });

  test("connect/poll maps an active source cutover fence to 409", async () => {
    mockDevice({
      usercode: () => json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" }),
    });
    const { body } = await start(WS_A);
    mockDevice({
      token: () => json({ authorization_code: "authorization-code", code_verifier: "verifier" }),
      exchange: () =>
        json({
          id_token: jwt({
            email: "connector@example.com",
            "https://api.openai.com/auth": {
              chatgpt_account_id: "provider-account",
              chatgpt_plan_type: "pro",
            },
          }),
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: "refresh-token",
        }),
    });
    const mutation = spyOn(opengeniDb, "withSessionCodexCapacityMutation").mockRejectedValue(
      new Error("Codex subscription source cannot change while active turns are using it"),
    );
    restores.push(() => mutation.mockRestore());

    const res = await app().request(`/v1/workspaces/${WS_A}/codex/connect/poll`, {
      method: "POST",
      headers: {
        authorization: await bearer(WS_A, ["connections:write"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: body.state }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "Codex subscription source cannot change while active turns are using it",
        status: 409,
      },
    });
  });

  for (const mode of ["automatic", "workspace", "organization", "disabled"] as const) {
    test(`connect/poll preserves ${mode} source preference`, async () => {
      mockDevice({
        usercode: () => json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" }),
      });
      const { body } = await start(WS_A);
      mockDevice({
        token: () => json({ authorization_code: "authorization-code", code_verifier: "verifier" }),
        exchange: () =>
          json({
            id_token: jwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: "provider-account",
                chatgpt_plan_type: "pro",
              },
            }),
            access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: "refresh-token",
          }),
      });
      const source = {
        accountId: ACCOUNT,
        workspaceId: WS_A,
        workspaceKind: "shared" as const,
        mode,
        effectiveSource: mode === "automatic" ? ("organization" as const) : mode,
        workspaceAvailable: false,
        organizationAvailable: true,
      };
      const mocks = [
        spyOn(opengeniDb, "getWorkspaceCodexSubscriptionSource").mockResolvedValue(source),
        spyOn(opengeniDb, "upsertCodexSubscriptionCredential").mockResolvedValue({
          kind: "upserted",
          id: "local-account",
          isNew: true,
        }),
        spyOn(opengeniDb, "ensureCodexRotationSettings").mockResolvedValue(undefined),
        spyOn(opengeniDb, "setInitialActiveCodexCredential").mockResolvedValue(true),
        spyOn(opengeniDb, "getCodexRotationSettings").mockResolvedValue(null),
      ];
      const setMode = spyOn(
        opengeniDb,
        "setWorkspaceCodexSubscriptionModeInTransaction",
      ).mockResolvedValue(source);
      const mutation = spyOn(opengeniDb, "withSessionCodexCapacityMutation").mockImplementation(
        async (_db, _input, mutate) => {
          const result = await mutate(poisonDb as never);
          return { result: result.result, wakeTargets: [] };
        },
      );
      restores.push(...[...mocks, setMode, mutation].map((mock) => () => mock.mockRestore()));
      const res = await app().request(`/v1/workspaces/${WS_A}/codex/connect/poll`, {
        method: "POST",
        headers: {
          authorization: await bearer(WS_A, ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ state: body.state }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "connected", accountId: "local-account" });
      expect(setMode.mock.calls[0]?.[1]).toMatchObject({
        mode,
        effectiveSourceBeforeMutation: source.effectiveSource,
      });
    });
  }

  test("connect/poll rejects a state minted for a different workspace", async () => {
    mockDevice({
      usercode: () => json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" }),
    });
    const { body } = await start(WS_A); // state bound to WS_A
    const res = await app().request(`/v1/workspaces/${WS_B}/codex/connect/poll`, {
      method: "POST",
      headers: {
        authorization: await bearer(WS_B, ["connections:write"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: body.state }),
    });
    expect(res.status).toBe(400); // cross-workspace state is rejected before any device call
  });

  test("codex routes are auth-gated (no credentials -> 401/403, route exists)", async () => {
    const res = await app().request(`/v1/workspaces/${WS_A}/codex/status`);
    expect([401, 403]).toContain(res.status);
  });

  test("connect/start rejects a workspace reader without connection-management access", async () => {
    mockDevice({
      usercode: () => json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" }),
    });
    const res = await app().request(`/v1/workspaces/${WS_A}/codex/connect/start`, {
      method: "POST",
      headers: {
        authorization: await bearer(WS_A, ["workspace:read"]),
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(403);
  });
});

describe("codex multi-account routes (auth + validation)", () => {
  test("organization Codex accounts require a managed human session", async () => {
    const res = await app().request(`/v1/organizations/${ACCOUNT}/codex/accounts`);
    expect(res.status).toBe(401);
  });

  test("workspace Codex source reads require workspace access", async () => {
    const res = await app().request(`/v1/workspaces/${WS_A}/codex/source`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET /codex/accounts requires auth (route exists, db untouched on the reject)", async () => {
    const res = await app().request(`/v1/workspaces/${WS_A}/codex/accounts`);
    expect([401, 403]).toContain(res.status);
  });

  test("POST /codex/accounts/:id/activate requires auth", async () => {
    const res = await app().request(`/v1/workspaces/${WS_A}/codex/accounts/acc_1/activate`, {
      method: "POST",
    });
    expect([401, 403]).toContain(res.status);
  });

  test("DELETE /codex/accounts/:id requires auth", async () => {
    const res = await app().request(`/v1/workspaces/${WS_A}/codex/accounts/acc_1`, {
      method: "DELETE",
    });
    expect([401, 403]).toContain(res.status);
  });

  test("PATCH /codex/accounts/:id requires auth", async () => {
    const res = await app().request(`/v1/workspaces/${WS_A}/codex/accounts/acc_1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect([401, 403]).toContain(res.status);
  });

  test("POST /sessions/:id/codex-account rejects a missing target with 400 BEFORE any db touch", async () => {
    const SESSION = "00000000-0000-4000-8000-0000000000d4";
    const res = await app().request(`/v1/workspaces/${WS_A}/sessions/${SESSION}/codex-account`, {
      method: "POST",
      headers: {
        authorization: await bearer(WS_A, ["sessions:control"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400); // target validation happens before setSessionCodexPin (poisonDb untouched)
  });

  test("POST /sessions/:id/codex-account requires auth", async () => {
    const SESSION = "00000000-0000-4000-8000-0000000000d4";
    const res = await app().request(`/v1/workspaces/${WS_A}/sessions/${SESSION}/codex-account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "auto" }),
    });
    expect([401, 403]).toContain(res.status);
  });
});
