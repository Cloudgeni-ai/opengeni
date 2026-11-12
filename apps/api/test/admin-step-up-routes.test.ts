import { describe, expect, test } from "bun:test";
import { canonicalId, createsSharedConnection, matchAdminRoute } from "../src/auth/admin-step-up";

const ORG = "/v1/organizations/0e3c7a3e-4f5f-4a43-9a0b-6c3b7b0f6c1a";
const WS = "/v1/workspaces/7c1b6e24-6a8c-4bd8-8d55-0b2b1f0a9e77";
const CONNECTION_ID = "5d0f3c1e-2b7a-4c8e-9f61-3a4b5c6d7e8f";

describe("admin step-up routes", () => {
  test("covers who can access the organization and its data, as changes", () => {
    for (const [method, path] of [
      // Access management.
      ["POST", `${ORG}/invitations`],
      ["POST", `${ORG}/invitations/abc/revoke`],
      ["POST", `${ORG}/invitations/abc/delivery/retry`],
      ["PATCH", `${ORG}/members/abc`],
      ["PATCH", `${ORG}/external-members/abc`],
      ["PATCH", `${ORG}/workspaces/abc/members/def`],
      ["DELETE", `${ORG}/workspaces/abc/members/def`],
      ["POST", `${ORG}/workspaces/abc/members/def/revoke`],
      ["PATCH", `${ORG}/workspaces/abc/external-members/def`],
      ["POST", `${ORG}/service-accounts`],
      ["PATCH", `${ORG}/service-accounts/abc`],
      ["POST", `${ORG}/recovery/operations`],
      ["POST", `${WS}/members`],
      ["PATCH", `${WS}/members/abc`],
      ["DELETE", `${WS}/members/abc`],
      ["POST", `${WS}/external-members`],
      // Credentials.
      ["POST", `${ORG}/api-keys`],
      ["PATCH", `${ORG}/api-keys/abc`],
      ["POST", `${WS}/api-keys`],
      ["POST", `${ORG}/personal-api-keys`],
      // Shared connections, including Gmail.
      ["POST", `${ORG}/connectors`],
      ["PATCH", `${ORG}/connectors/abc`],
      ["DELETE", `${ORG}/connectors/abc`],
      ["PATCH", `${ORG}/mcp-connections/${CONNECTION_ID}`],
      ["DELETE", `${ORG}/mcp-connections/${CONNECTION_ID}`],
      ["POST", `${WS}/connections`],
      ["POST", `${WS}/connections/oauth/start`],
      ["POST", `${WS}/integrations/oauth/start`],
      ["POST", `${WS}/connect/attempts`],
      ["DELETE", `${WS}/connections/${CONNECTION_ID}`],
      // PostgreSQL reads these as the same uuid.
      ["DELETE", `${WS}/connections/${CONNECTION_ID.replaceAll("-", "")}`],
      ["DELETE", `${WS}/connections/{${CONNECTION_ID}}`],
      ["PATCH", `${WS}/connections/${CONNECTION_ID}`],
      ["POST", `${WS}/connections/slack-bot/install`],
      ["POST", `${WS}/connections/fiken/install`],
      ["POST", `${WS}/connections/fiken/oauth/start`],
      ["POST", `${WS}/connections/atlassian/${CONNECTION_ID}/source`],
      ["PATCH", `${WS}/connections/google-drive/${CONNECTION_ID}/lifecycle`],
      ["POST", `${WS}/connections/${CONNECTION_ID}/github/reconnect`],
    ] as const) {
      expect(matchAdminRoute(method, path), `${method} ${path}`).not.toBeNull();
    }
  });

  test("leaves settings, billing, policies and revoking keys alone", () => {
    for (const [method, path] of [
      // Organization and workspace settings.
      ["PATCH", ORG],
      ["PATCH", `${ORG}/privacy-settings`],
      ["PATCH", `${ORG}/private-session-settings`],
      ["PATCH", `${ORG}/retention-policy`],
      ["PATCH", `${ORG}/inference-residency`],
      ["POST", `${ORG}/workspaces`],
      ["PATCH", `${ORG}/workspaces/abc`],
      ["DELETE", `${ORG}/workspaces/abc`],
      ["PATCH", `${ORG}/workspaces/abc/settings`],
      ["PATCH", `${ORG}/agent-admin-access`],
      ["PATCH", WS],
      ["DELETE", WS],
      ["PATCH", `${WS}/settings`],
      // Webhooks, model policy and custom models.
      ["POST", `${ORG}/webhooks`],
      ["PATCH", `${ORG}/webhooks/abc`],
      ["PUT", `${ORG}/model-defaults`],
      ["PUT", `${ORG}/model-providers/openai`],
      ["POST", `${ORG}/model-providers/openai/custom-models`],
      ["PATCH", `${ORG}/codex/settings`],
      ["POST", `${WS}/webhooks`],
      ["PUT", `${WS}/model-policy`],
      ["PUT", `${WS}/default-rig`],
      ["PUT", `${WS}/model-account-settings`],
      ["POST", `${WS}/gateway-custom-models`],
      ["DELETE", `${WS}/openrouter-custom-models/abc`],
      ["POST", `${WS}/opper-custom-models`],
      // Vaults, credential provider and integration installs.
      ["PUT", `${ORG}/credential-provider`],
      ["PUT", `${WS}/credential-provider`],
      ["POST", `${WS}/vaults`],
      ["POST", `${WS}/vault-providers/connections`],
      ["POST", `${WS}/connections/1password/install`],
      ["PUT", `${WS}/connections/${CONNECTION_ID}/1password/token`],
      ["DELETE", `${WS}/connections/${CONNECTION_ID}/1password`],
      ["POST", `${WS}/connections/${CONNECTION_ID}/managed-vaults`],
      ["POST", `${WS}/integrations/install`],
      ["PUT", `${WS}/integrations/cap/organization`],
      ["DELETE", `${WS}/integrations/cap/instances/key`],
      ["PUT", `${WS}/integrations/cap/instances/key/facets/facet`],
      // Capabilities, plugins and GitHub.
      ["POST", `${WS}/capabilities/cap/enable`],
      ["DELETE", `${WS}/capabilities/cap/installation`],
      ["PUT", `${WS}/capabilities/cap/tool-permissions`],
      ["POST", `${WS}/plugins/install`],
      ["POST", `${WS}/github/installations`],
      ["POST", `${WS}/github/app-manifest`],
      ["PATCH", `${WS}/github/action-policies`],
      // Video, sites, inference control and Slack policies.
      ["PUT", `${WS}/video-generation/policy`],
      ["PUT", `${WS}/site-limit-profile`],
      ["POST", `${WS}/inference-control`],
      ["PUT", `${WS}/connections/${CONNECTION_ID}/slack-bot/organization-access`],
      ["PUT", `${WS}/slack-task-policy`],
      ["PUT", `${WS}/agent-policy`],
      ["PUT", `${WS}/members/user:abc/allowance`],
      ["PUT", `${WS}/members/external/slack/U1/allowance`],
      // Billing.
      ["POST", "/v1/billing/checkout"],
      ["POST", "/v1/billing/portal"],
      ["POST", "/v1/billing/subscription/change"],
      ["PUT", "/v1/billing/alerts"],
      ["PUT", "/v1/billing/auto-top-up"],
      // Removing access is safe.
      ["DELETE", `${ORG}/api-keys/abc`],
      ["DELETE", `${WS}/api-keys/abc`],
      ["DELETE", `${ORG}/service-accounts/abc`],
      ["DELETE", `${ORG}/personal-api-keys/abc`],
    ] as const) {
      expect(matchAdminRoute(method, path), `${method} ${path}`).toBeNull();
    }
  });

  test("ids are compared in their canonical form", () => {
    const id = CONNECTION_ID;
    for (const written of [id.toUpperCase(), id.replaceAll("-", ""), `{${id}}`]) {
      expect(canonicalId(written)).toBe(id);
      expect(matchAdminRoute("DELETE", `${WS}/connections/${written}`)?.connectionId).toBe(id);
    }
    const upper = WS.toUpperCase().replace("/V1/WORKSPACES", "/v1/workspaces");
    expect(matchAdminRoute("POST", `${upper}/members`)?.workspaceId).toBe(WS.split("/").at(-1));
    expect(canonicalId("not-a-uuid")).toBe("not-a-uuid");
  });

  test("creating a personal key is checked; using or revoking one is not", () => {
    expect(matchAdminRoute("POST", `${ORG}/personal-api-keys`)?.route.scope).toBe(
      "personal_api_key",
    );
    expect(matchAdminRoute("POST", `${ORG}/personal-api-keys/`)?.organizationId).toBe(
      ORG.split("/").at(-1),
    );
    expect(matchAdminRoute("PATCH", `${ORG}/personal-api-keys`)).toBeNull();
  });

  test("leaves reads, a person's own keys and everyday work alone", () => {
    for (const [method, path] of [
      ["GET", ORG],
      ["GET", `${ORG}/members`],
      ["GET", `${ORG}/personal-api-keys`],
      ["DELETE", `${ORG}/personal-api-keys/abc`],
      ["POST", `${ORG}/external-identities/lookup`],
      ["POST", `${ORG}/connectors/api-integrations/preview`],
      ["POST", "/v1/organizations/additional"],
      ["POST", "/v1/organizations"],
      ["POST", "/v1/organization-invitations/abc/accept"],
      ["POST", `${WS}/sessions`],
      ["POST", `${WS}/files`],
      ["PUT", `${WS}/my-default-execution-target`],
      ["POST", "/v1/billing/notifications/abc/read"],
      ["POST", "/v1/webhooks/stripe"],
      ["POST", "/v1/auth/passkey/step-up"],
      ["POST", `${WS}/plugins/preview`],
      ["POST", `${WS}/capabilities/discovery/mcp-auth`],
      ["POST", `${WS}/connections/github/oauth/start`],
      ["POST", `${WS}/event-sources`],
    ] as const) {
      expect(matchAdminRoute(method, path), `${method} ${path}`).toBeNull();
    }
  });

  test("a connection is an admin setting only when shared", () => {
    expect(matchAdminRoute("POST", `${WS}/connect/attempts`)?.route.shared).toBe("created");
    expect(matchAdminRoute("POST", `${WS}/connections`)?.route.shared).toBe("created");
    expect(matchAdminRoute("POST", `${WS}/connections/slack-bot/install`)?.route.shared).toBe(
      "created",
    );
    const existing = matchAdminRoute("DELETE", `${WS}/connections/${CONNECTION_ID}`);
    expect(existing?.route.shared).toBe("existing");
    expect(existing?.connectionId).toBe(CONNECTION_ID);
    // As the routes read it: shared unless it names the person as owner.
    expect(createsSharedConnection({}, "user:abc")).toBe(true);
    expect(createsSharedConnection(null, "user:abc")).toBe(true);
    expect(createsSharedConnection({ ownership: "workspace" }, "user:abc")).toBe(true);
    expect(createsSharedConnection({ ownership: "organization" }, "user:abc")).toBe(true);
    expect(createsSharedConnection({ subjectId: null }, "user:abc")).toBe(true);
    expect(createsSharedConnection({ ownership: "personal" }, "user:abc")).toBe(false);
    expect(createsSharedConnection({ ownership: "user" }, "user:abc")).toBe(false);
    expect(createsSharedConnection({ subjectId: "user:abc" }, "user:abc")).toBe(false);
    // Named for someone else: an admin act.
    expect(createsSharedConnection({ subjectId: "user:other" }, "user:abc")).toBe(true);
  });
});
