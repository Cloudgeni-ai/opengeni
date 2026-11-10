import { describe, expect, test } from "bun:test";
import { canonicalId, createsSharedConnection, matchAdminRoute } from "../src/auth/admin-step-up";

const ORG = "/v1/organizations/0e3c7a3e-4f5f-4a43-9a0b-6c3b7b0f6c1a";
const WS = "/v1/workspaces/7c1b6e24-6a8c-4bd8-8d55-0b2b1f0a9e77";
const CONNECTION_ID = "5d0f3c1e-2b7a-4c8e-9f61-3a4b5c6d7e8f";

describe("admin step-up routes", () => {
  test("covers the admin functions, as changes", () => {
    for (const [method, path] of [
      ["PATCH", ORG],
      ["POST", `${ORG}/invitations`],
      ["POST", `${ORG}/invitations/abc/revoke`],
      ["PATCH", `${ORG}/members/abc`],
      ["POST", `${ORG}/api-keys`],
      ["DELETE", `${ORG}/api-keys/abc`],
      ["PATCH", `${ORG}/privacy-settings`],
      ["PATCH", `${ORG}/workspaces/abc/settings`],
      ["PUT", `${ORG}/credential-provider`],
      ["POST", `${ORG}/connectors`],
      ["PATCH", `${ORG}/mcp-connections/${CONNECTION_ID}`],
      ["PATCH", WS],
      ["PATCH", `${WS}/settings`],
      ["POST", `${WS}/members`],
      ["DELETE", `${WS}/members/abc`],
      ["POST", `${WS}/api-keys`],
      ["POST", `${WS}/webhooks`],
      ["PUT", `${WS}/members/user:abc/allowance`],
      ["PUT", `${WS}/members/external/slack/U1/allowance`],
      ["POST", `${WS}/connect/attempts`],
      ["DELETE", `${WS}/connections/${CONNECTION_ID}`],
      // PostgreSQL reads these as the same uuid.
      ["DELETE", `${WS}/connections/${CONNECTION_ID.replaceAll("-", "")}`],
      ["DELETE", `${WS}/connections/{${CONNECTION_ID}}`],
      ["PATCH", `${WS}/connections/${CONNECTION_ID}`],
      ["PUT", `${WS}/connections/${CONNECTION_ID}/1password/token`],
      ["POST", `${WS}/connections/slack-bot/install`],
      ["POST", `${WS}/connections/1password/install`],
      ["POST", `${WS}/connections/fiken/install`],
      ["POST", `${WS}/connections/fiken/oauth/start`],
      ["POST", `${WS}/connections/atlassian/${CONNECTION_ID}/source`],
      ["PATCH", `${WS}/connections/google-drive/${CONNECTION_ID}/lifecycle`],
      ["DELETE", `${WS}/integrations/cap/instances/key`],
      ["PUT", `${WS}/integrations/cap/instances/key/facets/facet`],
      ["POST", `${WS}/capabilities/cap/enable`],
      ["DELETE", `${WS}/capabilities/cap/installation`],
      ["PUT", `${WS}/capabilities/cap/tool-permissions`],
      ["POST", `${WS}/plugins/install`],
      ["POST", `${WS}/github/installations`],
      ["PATCH", `${WS}/github/action-policies`],
      ["PUT", `${WS}/video-generation/policy`],
      ["PUT", `${WS}/site-limit-profile`],
      ["POST", `${WS}/inference-control`],
      ["POST", "/v1/billing/checkout"],
      ["POST", "/v1/billing/subscription/change"],
      ["PUT", "/v1/billing/auto-top-up"],
    ] as const) {
      expect(matchAdminRoute(method, path), `${method} ${path}`).not.toBeNull();
    }
  });

  test("ids are compared in their canonical form", () => {
    const id = CONNECTION_ID;
    for (const written of [id.toUpperCase(), id.replaceAll("-", ""), `{${id}}`]) {
      expect(canonicalId(written)).toBe(id);
      expect(matchAdminRoute("DELETE", `${WS}/connections/${written}`)?.connectionId).toBe(id);
    }
    expect(
      matchAdminRoute("PATCH", WS.toUpperCase().replace("/V1/WORKSPACES", "/v1/workspaces"))
        ?.workspaceId,
    ).toBe(WS.split("/").at(-1));
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
    expect(createsSharedConnection({})).toBe(true);
    expect(createsSharedConnection(null)).toBe(true);
    expect(createsSharedConnection({ ownership: "workspace" })).toBe(true);
    expect(createsSharedConnection({ ownership: "organization" })).toBe(true);
    expect(createsSharedConnection({ subjectId: null })).toBe(true);
    expect(createsSharedConnection({ ownership: "personal" })).toBe(false);
    expect(createsSharedConnection({ ownership: "user" })).toBe(false);
    expect(createsSharedConnection({ subjectId: "user:abc" })).toBe(false);
  });
});
