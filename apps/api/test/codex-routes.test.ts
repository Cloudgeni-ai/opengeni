import { afterEach, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";

const DELEGATION_SECRET = "codex-routes-delegation-secret";
const STATE_SECRET = "codex-routes-state-secret";
const WS_A = "00000000-0000-4000-8000-0000000000a1";
const WS_B = "00000000-0000-4000-8000-0000000000b2";
const ACCOUNT = "00000000-0000-4000-8000-0000000000c3";

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
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
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `Bearer ${token}`;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockDevice(handlers: { usercode?: () => Response; token?: () => Response }) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/deviceauth/usercode") && handlers.usercode) return handlers.usercode();
    if (url.includes("/deviceauth/token") && handlers.token) return handlers.token();
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function start(
  workspaceId: string,
): Promise<{ status: number; body: { userCode: string; verificationUri: string; state: string } }> {
  const res = await app().request(`/v1/workspaces/${workspaceId}/codex/connect/start`, {
    method: "POST",
    headers: {
      authorization: await bearer(workspaceId, ["workspace:admin"]),
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
        authorization: await bearer(WS_A, ["workspace:admin"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: body.state }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
  });

  test("connect/poll rejects a state minted for a different workspace", async () => {
    mockDevice({
      usercode: () => json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" }),
    });
    const { body } = await start(WS_A); // state bound to WS_A
    const res = await app().request(`/v1/workspaces/${WS_B}/codex/connect/poll`, {
      method: "POST",
      headers: {
        authorization: await bearer(WS_B, ["workspace:admin"]),
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
});

describe("codex multi-account routes (auth + validation)", () => {
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
