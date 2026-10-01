import { describe, expect, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  metadataWithTurnExecutionPolicyV1,
  signDelegatedAccessToken,
  type AccessContext,
  type AccessGrant,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import {
  accessGrantAuthorizationFromContext,
  isDeveloperSetupAuthorization,
  isDeveloperSetupGrant,
  requireAccessContext,
  requireApiKeyDelegationContext,
  requireApiKeyManagementContext,
} from "../src/access";
import { withDeveloperSetupCredentialRestriction } from "../src/developer-setup-credential-ceiling";

const settings = testSettings({ productAccessMode: "managed", delegationSecret: "ceiling-test" });
const policy = resolveTurnExecutionPolicyV1(settings, {
  modelId: "scripted-model",
  requestedModelId: null,
  modelSource: "session",
  reasoningEffort: "high",
  reasoningSource: "session",
});
const grant: AccessGrant = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "worker:first-party-mcp",
  principalKind: "agent_attempt",
  permissions: ["workspace:admin", "api_keys:manage"],
  metadata: {
    delegated: true,
    sessionId: crypto.randomUUID(),
    credentialRestriction: "developer_setup",
  },
};
const forgedContext: AccessContext = {
  mode: "managed",
  subjectId: grant.subjectId,
  accountGrants: [
    { accountId: grant.accountId, subjectId: grant.subjectId, permissions: ["api_keys:manage"] },
  ],
  workspaceGrants: [grant],
  defaultAccountId: grant.accountId,
  defaultWorkspaceId: grant.workspaceId,
};

async function canonicalContext(restricted: boolean): Promise<AccessContext> {
  const token = await signDelegatedAccessToken("ceiling-test", {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    principalKind: "agent_attempt",
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
    permissions: ["workspace:admin", "api_keys:manage", "account:admin", "secrets:read"],
    ...(restricted ? { credentialRestriction: "developer_setup" as const } : {}),
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  let resolved: AccessContext | undefined;
  const app = new Hono().get("/", async (c) => {
    resolved = await requireAccessContext(c, {
      db: new Proxy(
        {},
        {
          get() {
            throw new Error("delegated resolution touched the database");
          },
        },
      ) as never,
      settings,
    });
    return c.json({ authenticated: true });
  });
  expect((await app.request("/", { headers: { authorization: `Bearer ${token}` } })).status).toBe(
    200,
  );
  return resolved!;
}

describe("setup-specific inherited credential ceiling", () => {
  test("unmarked policies and forged grant/context metadata preserve non-setup behavior", () => {
    const authorization = accessGrantAuthorizationFromContext(forgedContext, grant);
    expect(isDeveloperSetupGrant(grant)).toBe(false);
    expect(isDeveloperSetupAuthorization(authorization)).toBe(false);
    expect(withDeveloperSetupCredentialRestriction(policy, { grant, authorization })).toBe(policy);
    expect(() => requireApiKeyManagementContext(forgedContext)).not.toThrow();
    expect(() => requireApiKeyDelegationContext(forgedContext, ["workspace:admin"])).not.toThrow();
  });

  test("verified restricted HMAC provenance stamps the exact authorization and resolved grant", async () => {
    const context = await canonicalContext(true);
    const resolvedGrant = context.workspaceGrants[0]!;
    const authorization = accessGrantAuthorizationFromContext(context, resolvedGrant);
    expect(isDeveloperSetupGrant(resolvedGrant)).toBe(true);
    expect(isDeveloperSetupGrant({ ...resolvedGrant })).toBe(false);
    expect(isDeveloperSetupAuthorization(authorization)).toBe(true);
    expect(isDeveloperSetupAuthorization({ ...authorization })).toBe(false);
    expect(isDeveloperSetupAuthorization({ ...authorization, grant: { ...resolvedGrant } })).toBe(
      false,
    );
    expect(
      withDeveloperSetupCredentialRestriction(policy, { authorization }).credentialRestriction,
    ).toBe("developer_setup");
    expect(
      withDeveloperSetupCredentialRestriction(policy, { grant: resolvedGrant })
        .credentialRestriction,
    ).toBe("developer_setup");
    expect(() => requireApiKeyManagementContext(context)).toThrow("cannot manage API keys");
    expect(() => requireApiKeyDelegationContext(context, ["workspace:admin"])).toThrow(
      "cannot delegate",
    );
    expect(() =>
      requireApiKeyDelegationContext(context, ["sessions:read", "sessions:create"]),
    ).not.toThrow();
    expect(context.accountGrants[0]!.permissions).toEqual([]);
    expect(resolvedGrant.permissions).toEqual(["workspace:admin"]);
  });

  test("verified authorized non-setup attempts retain their scopes and key authority", async () => {
    const context = await canonicalContext(false);
    const authorization = accessGrantAuthorizationFromContext(context, context.workspaceGrants[0]!);
    expect(isDeveloperSetupAuthorization(authorization)).toBe(false);
    expect(withDeveloperSetupCredentialRestriction(policy, { authorization })).toBe(policy);
    expect(() => requireApiKeyManagementContext(context)).not.toThrow();
    expect(() => requireApiKeyDelegationContext(context, ["workspace:admin"])).not.toThrow();
    expect(context.accountGrants[0]!.permissions).toContain("api_keys:manage");
    expect(context.workspaceGrants[0]!.permissions).toContain("secrets:read");
  });

  test("protected root, retry, or scheduled turn policy restrictions cannot be cleared", () => {
    const restricted = { ...policy, credentialRestriction: "developer_setup" as const };
    for (const trustedMetadata of [
      [metadataWithTurnExecutionPolicyV1({}, restricted)],
      [{}, metadataWithTurnExecutionPolicyV1({}, restricted)],
      [
        metadataWithTurnExecutionPolicyV1({}, restricted),
        metadataWithTurnExecutionPolicyV1({}, policy),
      ],
    ]) {
      expect(
        withDeveloperSetupCredentialRestriction(policy, { trustedMetadata }).credentialRestriction,
      ).toBe("developer_setup");
    }
    expect(withDeveloperSetupCredentialRestriction(restricted, {}).credentialRestriction).toBe(
      "developer_setup",
    );
  });

  test("malformed persisted ceilings fail closed while legacy absent policy remains compatible", () => {
    expect(
      withDeveloperSetupCredentialRestriction(policy, { trustedMetadata: [null, undefined, {}] }),
    ).toBe(policy);
    expect(() =>
      withDeveloperSetupCredentialRestriction(policy, {
        trustedMetadata: [{ turnExecutionPolicyV1: { ...policy, credentialRestriction: "full" } }],
      }),
    ).toThrow("frozen session credential ceiling is invalid");
  });
});
