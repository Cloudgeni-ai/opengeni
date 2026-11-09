import { describe, expect, test } from "bun:test";
import { matchAdminRoute } from "../src/auth/admin-step-up";

const ORG = "/v1/organizations/0e3c7a3e-4f5f-4a43-9a0b-6c3b7b0f6c1a";
const WS = "/v1/workspaces/7c1b6e24-6a8c-4bd8-8d55-0b2b1f0a9e77";

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
      ["PATCH", `${ORG}/mcp-connections/abc`],
      ["PATCH", WS],
      ["PATCH", `${WS}/settings`],
      ["POST", `${WS}/members`],
      ["DELETE", `${WS}/members/abc`],
      ["POST", `${WS}/api-keys`],
      ["POST", `${WS}/webhooks`],
      ["PUT", `${WS}/members/user:abc/allowance`],
      ["PUT", `${WS}/members/external/slack/U1/allowance`],
      ["POST", `${WS}/connect/attempts`],
      ["POST", "/v1/billing/checkout"],
      ["POST", "/v1/billing/subscription/change"],
      ["PUT", "/v1/billing/auto-top-up"],
    ] as const) {
      expect(matchAdminRoute(method, path), `${method} ${path}`).not.toBeNull();
    }
  });

  test("leaves reads, a person's own keys and everyday work alone", () => {
    for (const [method, path] of [
      ["GET", ORG],
      ["GET", `${ORG}/members`],
      ["POST", `${ORG}/personal-api-keys`],
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
    ] as const) {
      expect(matchAdminRoute(method, path), `${method} ${path}`).toBeNull();
    }
  });

  test("a connection is an admin setting only when shared", () => {
    expect(matchAdminRoute("POST", `${WS}/connect/attempts`)?.route.sharedOwnershipOnly).toBe(true);
    expect(matchAdminRoute("POST", `${WS}/connections`)?.route.sharedOwnershipOnly).toBe(true);
  });
});
