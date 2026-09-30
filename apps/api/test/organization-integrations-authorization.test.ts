import { describe, expect, test } from "bun:test";
import type { AccessContext } from "@opengeni/contracts";
import { requireOrganizationIntegrationAdmin } from "../src/routes/organization-integrations";
import {
  integrationProviderFields,
  integrationWebhookFields,
} from "../src/routes/workspace-integrations";

const organizationId = "8e6e6e5e-1a53-4f45-971a-2b4a0d84301d";
const workspaceId = "78576ccd-771f-44c5-938f-359ca1a19f2c";
function context(): AccessContext {
  return {
    mode: "managed",
    subjectId: "user:admin",
    accountGrants: [
      { accountId: organizationId, subjectId: "user:admin", permissions: ["account:admin"] },
    ],
    workspaceGrants: [],
    defaultAccountId: organizationId,
    defaultWorkspaceId: null,
  };
}
describe("organization integration authority", () => {
  test("shared projections expose no account credentials or signing secret", () => {
    const provider = {
      id: organizationId,
      accountId: organizationId,
      url: "https://example.test",
      secretEncrypted: "never-expose",
      enabled: true,
      timeoutMs: 5000,
      createdBySubjectId: "user:admin",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const projected = integrationProviderFields(provider);
    expect(JSON.stringify(projected)).not.toContain("never-expose");
    expect(projected).not.toHaveProperty("accountId");
    const webhook = integrationWebhookFields({
      ...provider,
      eventTypes: ["turn.completed"],
      description: null,
    });
    expect(webhook.id).toBe(organizationId);
    expect(JSON.stringify(webhook)).not.toContain("never-expose");
    expect(webhook).not.toHaveProperty("createdBySubjectId");
  });
  test("literal same-account admin works without workspace membership", () => {
    expect(requireOrganizationIntegrationAdmin(context(), organizationId)).toBe("user:admin");
  });
  test("workspace admin, foreign-account and mismatched-subject grants do not qualify", () => {
    const access = context();
    access.accountGrants[0]!.permissions = ["workspace:admin"];
    expect(() => requireOrganizationIntegrationAdmin(access, organizationId)).toThrow(
      "account:admin",
    );
    expect(() => requireOrganizationIntegrationAdmin(context(), workspaceId)).toThrow(
      "account:admin",
    );
    access.accountGrants[0]!.permissions = ["account:admin"];
    access.accountGrants[0]!.subjectId = "user:other";
    expect(() => requireOrganizationIntegrationAdmin(access, organizationId)).toThrow(
      "account:admin",
    );
  });
  test("agent attempts and attempt metadata are refused despite account admin", () => {
    for (const marker of [
      { principalKind: "agent_attempt" as const },
      { principalKind: "service" as const, metadata: { attemptId: "attempt" } },
      { principalKind: "service" as const, metadata: { turnId: "turn" } },
    ]) {
      const access = context();
      access.workspaceGrants = [
        {
          accountId: organizationId,
          workspaceId,
          subjectId: access.subjectId,
          permissions: ["workspace:admin"],
          ...marker,
        },
      ];
      expect(() => requireOrganizationIntegrationAdmin(access, organizationId)).toThrow(
        "Agent attempts",
      );
    }
  });
  test("unstamped workspace API keys cannot borrow account admin", () => {
    const access = context();
    access.subjectId = "api_key:37ac151d-cd4c-4e75-b6c2-01702e1edca6";
    access.accountGrants[0]!.subjectId = access.subjectId;
    expect(() => requireOrganizationIntegrationAdmin(access, organizationId)).toThrow(
      "organization API key",
    );
  });
});
