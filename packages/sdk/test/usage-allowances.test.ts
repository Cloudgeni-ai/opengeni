import { describe, expect, test } from "bun:test";
import {
  OpenGeniClient,
  OpenGeniApiError,
  OpenGeniAllowanceExhaustedError,
  createSessionProxyHandler,
  signOpenGeniPayload,
  verifyWebhookEvent,
} from "../src/index";

const workspaceId = "11111111-1111-4111-8111-111111111111";

function fixture() {
  const calls: { method: string; url: URL; body: unknown; actor: unknown }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.test",
    apiKey: "service-key",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const actor = request.headers.get("x-opengeni-external-actor");
      const text = await request.text();
      calls.push({
        method: request.method,
        url: new URL(request.url),
        body: text ? JSON.parse(text) : undefined,
        actor: actor ? JSON.parse(decodeURIComponent(actor)) : null,
      });
      return Response.json({ fixture: true });
    },
  });
  return { client, calls };
}

describe("allowance SDK helpers", () => {
  test("all methods forward exact requests, encoded targets, query and asUser attribution", async () => {
    const { client, calls } = fixture();
    const config = { includedCredits: 1_000_000, period: "monthly" as const, expectedVersion: 0 };
    await client.setWorkspaceAllowance("workspace/a", config);
    await client.getWorkspaceAllowance("workspace/a");
    await client.clearWorkspaceAllowance("workspace/a", { expectedVersion: 1 });
    await client.grantWorkspaceCredits("workspace/a", {
      operationId: "once",
      credits: 20,
      expiresAt: null,
    });
    await client.setMemberAllowance("workspace/a", "user:a/b", {
      rule: { share: 2 },
      expectedVersion: 0,
    });
    await client.setMemberAllowance(
      "workspace/a",
      { source: "product/a", externalId: "Person/b" },
      { rule: null, expectedVersion: 2 },
    );
    await client.getUsage("workspace/a", { period: "2026-09", limit: 20, cursor: "user:a/b" });
    await client
      .asUser("person", { source: "product" })
      .getMyUsage("workspace/a", { period: "current" });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["PUT", "/v1/workspaces/workspace%2Fa/allowance"],
      ["GET", "/v1/workspaces/workspace%2Fa/allowance"],
      ["DELETE", "/v1/workspaces/workspace%2Fa/allowance"],
      ["POST", "/v1/workspaces/workspace%2Fa/allowance/grants"],
      ["PUT", "/v1/workspaces/workspace%2Fa/members/user%3Aa%2Fb/allowance"],
      ["PUT", "/v1/workspaces/workspace%2Fa/members/external/product%2Fa/Person%2Fb/allowance"],
      ["GET", "/v1/workspaces/workspace%2Fa/usage"],
      ["GET", "/v1/workspaces/workspace%2Fa/usage/me"],
    ]);
    expect(calls[0]!.body).toEqual(config);
    expect(calls[2]!.body).toEqual({ expectedVersion: 1 });
    expect(Object.fromEntries(calls[6]!.url.searchParams)).toEqual({
      period: "2026-09",
      limit: "20",
      cursor: "user:a/b",
    });
    expect(calls[7]!.actor).toEqual({
      mode: "external",
      identity: { source: "product", externalId: "person" },
    });
    expect(calls.slice(0, 7).every((call) => call.actor === null)).toBe(true);
  });

  test("standalone and enveloped exhaustion produce a non-retryable typed API error", async () => {
    for (const scope of ["workspace", "member"] as const) {
      const refusal = {
        code: "allowance_exhausted",
        scope,
        resetsAt: null,
        subjectId: "user:a",
        message: "Usage exhausted",
      };
      for (const body of [
        refusal,
        {
          error: {
            code: refusal.code,
            message: refusal.message,
            details: refusal,
            requestId: "request-1",
          },
        },
      ]) {
        const client = new OpenGeniClient({
          baseUrl: "https://api.test",
          fetch: async () => Response.json(body, { status: 429 }),
        });
        try {
          await client.requestJson("POST", "/v1/refused", {});
          throw new Error("expected refusal");
        } catch (error) {
          expect(error).toBeInstanceOf(OpenGeniApiError);
          expect(error).toBeInstanceOf(OpenGeniAllowanceExhaustedError);
          expect(error).toMatchObject({
            scope,
            resetsAt: null,
            subjectId: "user:a",
            code: "allowance_exhausted",
            retryable: false,
            outcomeUnknown: false,
          });
        }
      }
    }
  });

  test("generic failures remain generic and uncertain grants are never replayed", async () => {
    let calls = 0;
    const client = new OpenGeniClient({
      baseUrl: "https://api.test",
      fetch: async () => {
        calls++;
        throw new TypeError("lost response");
      },
    });
    await expect(
      client.grantWorkspaceCredits(workspaceId, { operationId: "once", credits: 1 }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    expect(calls).toBe(1);
    const ordinary = new OpenGeniClient({
      baseUrl: "https://api.test",
      fetch: async () =>
        Response.json({ error: { code: "forbidden", message: "Denied" } }, { status: 403 }),
    });
    await expect(ordinary.getUsage(workspaceId)).rejects.toMatchObject({
      name: "OpenGeniApiError",
      code: "forbidden",
    });
  });

  test("signed workspace-scoped events verify; unknown null-session events fail closed", async () => {
    for (const type of [
      "usage.threshold_reached",
      "usage.exhausted",
      "usage.period_reset",
      "unknown",
    ]) {
      const body = JSON.stringify({
        id: crypto.randomUUID(),
        type,
        workspaceId,
        sessionId: null,
        turnId: null,
        sequence: 1,
        occurredAt: "",
        data: { scope: "workspace" },
      });
      const headers = { "OpenGeni-Signature": await signOpenGeniPayload("secret", body) };
      if (type === "unknown")
        await expect(verifyWebhookEvent({ secret: "secret", body, headers })).rejects.toThrow();
      else
        expect(
          (await verifyWebhookEvent({ secret: "secret", body, headers })).event.sessionId,
        ).toBeNull();
    }
    const body = JSON.stringify({
      id: crypto.randomUUID(),
      workspaceId,
      type: "usage.period_reset",
      occurredAt: "",
      data: { period: "2026-10" },
    });
    expect(
      (
        await verifyWebhookEvent({
          secret: "secret",
          body,
          headers: {
            "OpenGeni-Signature": await signOpenGeniPayload("secret", body),
          },
        })
      ).event.type,
    ).toBe("usage.period_reset");
  });
});

describe("own-usage read-only proxy", () => {
  test("forwards exhaustion intact so the browser receives the typed refusal", async () => {
    const body = {
      error: {
        code: "allowance_exhausted",
        message: "Usage exhausted",
        retryable: false,
        details: { scope: "member", resetsAt: null, subjectId: "external_user:own" },
      },
    };
    const service = new OpenGeniClient({
      baseUrl: "https://api.test",
      apiKey: "service",
      fetch: async () => Response.json(body, { status: 429 }),
    });
    const handler = createSessionProxyHandler(service, {
      resolve: () => ({ workspaceId, user: "person" }),
    });
    const browser = new OpenGeniClient({
      baseUrl: "https://host.test",
      fetch: async (input, init) => handler(new Request(input, init)),
    });
    await expect(browser.getMyUsage(workspaceId)).rejects.toMatchObject({
      name: "OpenGeniAllowanceExhaustedError",
      scope: "member",
      resetsAt: null,
      subjectId: "external_user:own",
      retryable: false,
    });
  });

  test("forwards only own usage as the host-resolved user", async () => {
    const { client, calls } = fixture();
    const handler = createSessionProxyHandler(client, {
      resolve: () => ({ workspaceId, user: "resolved-user", source: "host" }),
    });
    const response = await handler(
      new Request(`https://host.test/v1/workspaces/${workspaceId}/usage/me?period=2026-09`),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.actor).toEqual({
      mode: "external",
      identity: { externalId: "resolved-user", source: "host" },
    });
    expect(calls[0]!.url.search).toBe("?period=2026-09");
  });

  test("denies full usage, controls, roster selectors, wrong workspace and unsupported methods", async () => {
    const { client, calls } = fixture();
    const handler = createSessionProxyHandler(client, {
      resolve: () => ({ workspaceId, user: "resolved-user" }),
    });
    const base = `https://host.test/v1/workspaces/${workspaceId}`;
    for (const [method, path, status] of [
      ["GET", `${base}/usage`, 404],
      ["GET", `${base}/allowance`, 404],
      ["PUT", `${base}/allowance`, 404],
      ["POST", `${base}/allowance/grants`, 404],
      ["PUT", `${base}/members/user:a/allowance`, 404],
      ["GET", `${base}/usage/me?subjectId=other`, 400],
      ["GET", `${base}/usage/me?cursor=other`, 400],
      ["GET", `${base}/usage/me?limit=1`, 400],
      ["POST", `${base}/usage/me`, 404],
      ["DELETE", `${base}/usage/me`, 405],
      ["GET", "https://host.test/v1/workspaces/other/usage/me", 403],
    ] as const) {
      expect((await handler(new Request(path, { method }))).status).toBe(status);
    }
    expect(calls).toHaveLength(0);
  });

  test("never falls back to service identity when the host supplies no user", async () => {
    const { client, calls } = fixture();
    const handler = createSessionProxyHandler(client, {
      resolve: () => ({ workspaceId, user: "" }),
    });
    expect(
      (await handler(new Request(`https://host.test/v1/workspaces/${workspaceId}/usage/me`)))
        .status,
    ).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
