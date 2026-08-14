import { describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import {
  hasLiteralPermission,
  hasPermission,
  requireAccessContext,
  requireLiteralPermission,
} from "../src/access";

const grant = (permissions: AccessGrant["permissions"]): AccessGrant => ({
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "subject",
  permissions,
});

describe("literal high-trust permissions", () => {
  test("workspace:admin remains an ordinary wildcard but cannot manufacture secrets:read", () => {
    const admin = grant(["workspace:admin"]);
    expect(hasPermission(admin.permissions, "variable-sets:read")).toBe(true);
    expect(hasPermission(admin.permissions, "secrets:read")).toBe(false);
    expect(hasLiteralPermission(admin.permissions, "secrets:read")).toBe(false);
    expect(() => requireLiteralPermission(admin, "secrets:read")).toThrow(
      "missing literal permission: secrets:read",
    );
  });

  test("an explicit secrets:read grant passes the literal boundary", () => {
    const explicit = grant(["workspace:admin", "secrets:read"]);
    expect(hasLiteralPermission(explicit.permissions, "secrets:read")).toBe(true);
    expect(() => requireLiteralPermission(explicit, "secrets:read")).not.toThrow();
  });

  test("legacy scopes imply granular metadata and write scopes but never plaintext", () => {
    expect(hasPermission(["variable-sets:use"], "variable-sets:list")).toBe(true);
    expect(hasPermission(["variable-sets:use"], "variable-sets:read")).toBe(true);
    expect(hasPermission(["variable-sets:use"], "secrets:list")).toBe(true);
    expect(hasPermission(["variable-sets:use"], "variable-sets:write")).toBe(false);
    expect(hasPermission(["variable-sets:use"], "secrets:write")).toBe(false);

    expect(hasPermission(["variable-sets:manage"], "variable-sets:write")).toBe(true);
    expect(hasPermission(["variable-sets:manage"], "secrets:write")).toBe(true);
    expect(hasPermission(["variable-sets:manage"], "secrets:read")).toBe(false);
  });

  test("verified agent-attempt depth claims reach grant metadata unchanged", async () => {
    const delegationSecret = "access-depth-claims-test-secret";
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId: "worker:first-party-mcp",
      permissions: ["sessions:create"],
      principalKind: "agent_attempt",
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      nestedAgentDepth: 3,
      effectiveMaxNestedAgentDepth: 3,
      exp: Math.floor(Date.now() / 1_000) + 60,
    });
    const app = new Hono().get("/", async (context) => {
      const access = await requireAccessContext(context, {
        settings: testSettings({ productAccessMode: "managed", delegationSecret }),
        db: new Proxy(
          {},
          {
            get() {
              throw new Error("delegated access unexpectedly touched the database");
            },
          },
        ) as never,
      });
      return context.json(access.workspaceGrants[0]);
    });

    const response = await app.request("http://x/", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workspaceId,
      accountId,
      principalKind: "agent_attempt",
      metadata: {
        delegated: true,
        nestedAgentDepth: 3,
        effectiveMaxNestedAgentDepth: 3,
      },
    });
  });
});
