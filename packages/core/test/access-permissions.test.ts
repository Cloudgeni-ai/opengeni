import { describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import {
  accountScopedApiKeyWorkspaceAuthority,
  hasLiteralPermission,
  hasPermission,
  requireAccessContext,
  requireLiteralPermission,
  requirePermission,
  requireExplicitPermissionDelegation,
} from "../src/access";

const grant = (permissions: AccessGrant["permissions"]): AccessGrant => ({
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "subject",
  permissions,
});

describe("literal high-trust permissions", () => {
  test("external actor headers cannot borrow local bootstrap authority", async () => {
    const app = new Hono();
    app.get("/", async (c) =>
      c.json(
        await requireAccessContext(c, {
          db: {} as never,
          settings: testSettings({ productAccessMode: "local" }),
        }),
      ),
    );
    const response = await app.request("/", {
      headers: {
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({ mode: "external", identity: { externalId: "dev" } }),
        ),
      },
    });
    expect(response.status).toBe(401);
  });
  test("API-key-shaped access contexts cannot forge account-scoped workspace authority", () => {
    const accountId = "11111111-1111-4111-8111-111111111111";
    expect(
      accountScopedApiKeyWorkspaceAuthority({
        mode: "managed",
        subjectId: "api_key:forged",
        accountGrants: [
          {
            accountId,
            subjectId: "api_key:forged",
            permissions: ["workspace:admin"],
          },
        ],
        workspaceGrants: [],
        defaultAccountId: accountId,
        defaultWorkspaceId: null,
      }),
    ).toBeNull();
  });

  test("malformed non-array permission values fail closed at the authorization predicate", () => {
    const malformedValues = ["workspace:admin", { includes: () => true }, null];
    for (const malformed of malformedValues) {
      const permissions = malformed as unknown as AccessGrant["permissions"];
      expect(hasPermission(permissions, "workspace:read")).toBe(false);
      expect(hasLiteralPermission(permissions, "workspace:admin")).toBe(false);
    }
  });

  test("workspace:admin remains an ordinary wildcard but cannot manufacture secrets:read", () => {
    const admin = grant(["workspace:admin"]);
    expect(hasPermission(admin.permissions, "variable-sets:read")).toBe(true);
    expect(hasPermission(admin.permissions, "secrets:read")).toBe(false);
    expect(hasLiteralPermission(admin.permissions, "secrets:read")).toBe(false);
    expect(() => requireLiteralPermission(admin, "secrets:read")).toThrow(
      "missing literal permission: secrets:read",
    );
  });
  test("explicit policy admin remains literal across serialized grant boundaries", () => {
    const admin: AccessGrant = JSON.parse(
      JSON.stringify({ ...grant(["workspace:admin"]), permissionMode: "explicit" }),
    );
    expect(() => requirePermission(admin, "workspace:admin")).not.toThrow();
    expect(hasPermission(admin.permissions, "sessions:control")).toBe(false);
    expect(() => requirePermission(admin, "sessions:control")).toThrow(
      "missing permission: sessions:control",
    );
    expect(() => requireExplicitPermissionDelegation(admin, ["workspace:admin"])).toThrow(
      "cannot delegate a legacy workspace-admin wildcard",
    );
  });

  test("an explicit secrets:read grant passes the literal boundary", () => {
    const explicit = grant(["workspace:admin", "secrets:read"]);
    expect(hasLiteralPermission(explicit.permissions, "secrets:read")).toBe(true);
    expect(() => requireLiteralPermission(explicit, "secrets:read")).not.toThrow();
  });
  test("explicit permission delegation cannot exceed its effective grant", () => {
    const limited: AccessGrant = {
      ...grant(["workspace:read", "members:manage"]),
      permissionMode: "explicit",
    };
    expect(() => requireExplicitPermissionDelegation(limited, ["workspace:read"])).not.toThrow();
    expect(() => requireExplicitPermissionDelegation(limited, ["sessions:control"])).toThrow(
      "outside the organization key policy",
    );
    expect(
      hasPermission([...limited.permissions], "sessions:control", limited.permissionMode),
    ).toBe(false);
  });

  test("variable-set capabilities do not imply one another", () => {
    const exact = [
      "variable-sets:list",
      "variable-sets:read",
      "variable-sets:write",
      "variable-sets:attach",
      "variable-sets:use",
      "secrets:list",
      "secrets:read",
      "secrets:write",
    ] as const;
    for (const permission of exact) {
      expect(hasPermission([permission], permission)).toBe(true);
      for (const other of exact) {
        if (other !== permission) expect(hasPermission([permission], other)).toBe(false);
      }
    }
    expect(hasPermission(["variable-sets:manage"], "variable-sets:write")).toBe(false);
    expect(hasPermission(["environments:use"], "variable-sets:use")).toBe(false);
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
