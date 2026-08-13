import { describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { requireAccessKey } from "../src/http/auth";

const accessKey = "configured-deployment-access-key";
const delegationSecret = "independent-first-party-delegation-secret";
const accountId = "00000000-0000-4000-8000-000000000101";
const workspaceId = "00000000-0000-4000-8000-000000000102";
const sessionId = "00000000-0000-4000-8000-000000000103";
const turnId = "00000000-0000-4000-8000-000000000104";
const attemptId = "00000000-0000-4000-8000-000000000105";

function protectedApp(options: { delegationSecret?: string } = {}) {
  const app = new Hono();
  app.use(
    "*",
    requireAccessKey(
      testSettings({
        productAccessMode: "configured",
        authRequired: true,
        accessKey,
        delegationSecret: options.delegationSecret,
      }),
    ),
  );
  app.get("/protected", (context) => context.json({ ok: true }));
  app.get("/v1/protected", (context) => context.json({ ok: true }));
  return app;
}

async function attemptBearer(secret: string, expiresAt = Math.floor(Date.now() / 1_000) + 3_600) {
  return await signDelegatedAccessToken(secret, {
    accountId,
    workspaceId,
    subjectId: `sandbox:${attemptId}`,
    subjectLabel: "sandbox Codemode",
    permissions: ["codemode:call"],
    sessionId,
    turnId,
    attemptId,
    executionGeneration: 1,
    principalKind: "agent_attempt",
    exp: expiresAt,
  });
}

describe("configured deployment perimeter authentication", () => {
  test("continues to accept the static deployment key in either supported header", async () => {
    const app = protectedApp({ delegationSecret });
    for (const headers of [
      { "x-opengeni-access-key": accessKey },
      { authorization: `Bearer ${accessKey}` },
    ]) {
      expect((await app.request("/protected", { headers })).status).toBe(200);
    }
  });

  test("admits a valid first-party delegated bearer only to product route authorization", async () => {
    const bearer = await attemptBearer(delegationSecret);
    const app = new Hono();
    app.use(
      "*",
      requireAccessKey(
        testSettings({
          productAccessMode: "configured",
          authRequired: true,
          accessKey,
          delegationSecret,
        }),
      ),
    );
    app.get("/v1/workspaces/:workspaceId/protected", (context) => context.json({ ok: true }));
    app.get("/metrics", (context) => context.text("private metrics"));

    const headers = { authorization: `Bearer ${bearer}` };
    expect(
      (
        await app.request(`/v1/workspaces/${workspaceId}/protected`, {
          headers,
        })
      ).status,
    ).toBe(200);
    expect((await app.request("/metrics", { headers })).status).toBe(401);
  });

  test("rejects forged, expired, malformed, and unsigned delegated bearers", async () => {
    const app = protectedApp({ delegationSecret });
    const bearers = await Promise.all([
      attemptBearer("wrong-delegation-secret"),
      attemptBearer(delegationSecret, 1),
      Promise.resolve("ogd_not-a-token"),
      Promise.resolve("unsigned-delegated-value"),
    ]);
    for (const bearer of bearers) {
      const response = await app.request("/v1/protected", {
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(response.status).toBe(401);
    }
  });

  test("derives delegated signing authority from the configured deployment key when no explicit secret is set", async () => {
    const bearer = await attemptBearer(accessKey);
    const response = await protectedApp().request("/v1/protected", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(response.status).toBe(200);
  });
});
