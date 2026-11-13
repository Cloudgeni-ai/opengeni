import { describe, expect, test } from "bun:test";
import type { ManagedEmailTransport } from "@opengeni/core";
import { getSettings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";

import {
  createManagedAuth,
  managedAuthPublicBaseUrls,
  managedAuthRequestBaseUrl,
} from "../src/auth/managed-auth";
import { resolveOrganizationUserSetupDeliveryEmail } from "../src/auth/organization-user-setup";
import { billingReturnOrigins, checkoutReturnUrl } from "../src/routes/billing";

// Opengeni Console is served on its own hosts (console.opengeni.ai,
// staging.console.opengeni.ai) by the same API. Links sent for a request open
// on the allowed public host the request came from, and a deployment can give
// its auth cookies their own name.

const hosts = {
  publicBaseUrl: "https://app.opengeni.test",
  betterAuthAllowedHosts: "app.opengeni.test,console.opengeni.test",
};

function request(host: string): Request {
  return new Request("http://api.internal:8080/v1/organizations/x/invitations", {
    headers: { "x-forwarded-host": host },
  });
}

describe("managed auth on Opengeni Console's host", () => {
  test("links open on the allowed host the request came from", () => {
    expect(managedAuthRequestBaseUrl(hosts, request("console.opengeni.test"))).toBe(
      "https://console.opengeni.test",
    );
    expect(managedAuthRequestBaseUrl(hosts, request("Console.Opengeni.test"))).toBe(
      "https://console.opengeni.test",
    );
    // A host that isn't allowed never chooses the link.
    expect(managedAuthRequestBaseUrl(hosts, request("attacker.test"))).toBe(
      "https://app.opengeni.test",
    );
    expect(managedAuthRequestBaseUrl(hosts, undefined)).toBe("https://app.opengeni.test");
    expect(
      managedAuthRequestBaseUrl(
        { ...hosts, betterAuthAllowedHosts: "" },
        request("console.opengeni.test"),
      ),
    ).toBe("https://app.opengeni.test");
    expect(managedAuthPublicBaseUrls(hosts, request("console.opengeni.test"))).toEqual([
      "https://console.opengeni.test",
      "https://app.opengeni.test",
    ]);
  });

  test("an invitation sent from Console opens account setup on Console, and its retry keeps it", async () => {
    const settings = testSettings({
      ...hosts,
      betterAuthSecret: "managed-console-host-test-secret-at-least-32-bytes",
      organizationUserSetupEmailTokenTransport: "fragment",
    });
    const identity = {
      invitationId: "00000000-0000-4000-8000-000000000001",
      deliveryId: "00000000-0000-4000-8000-000000000002",
      senderEmail: "Opengeni <invites@example.test>",
      recipientEmail: "invited@example.test",
      recipientName: null,
      organizationName: "Kontali",
      organizationRole: "member" as const,
      sharedWorkspaceAccess: [],
      providerIdempotencyScope: "test-provider-v1:console",
    };
    const first = await resolveOrganizationUserSetupDeliveryEmail(settings, {
      ...identity,
      frozenTransport: null,
      frozenPayloadDigest: null,
      setupBaseUrls: managedAuthPublicBaseUrls(settings, request("console.opengeni.test")),
    });
    expect(first.message.text).toContain("https://console.opengeni.test/setup-account#token=");
    // Retried from the app's host, the frozen email still names Console.
    const retry = await resolveOrganizationUserSetupDeliveryEmail(settings, {
      ...identity,
      frozenTransport: "fragment",
      frozenPayloadDigest: first.payloadDigest,
      setupBaseUrls: managedAuthPublicBaseUrls(settings, request("app.opengeni.test")),
    });
    expect(retry).toEqual(first);
  });

  test("OPENGENI_BETTER_AUTH_COOKIE_PREFIX names the auth cookies; unset keeps Better Auth's", async () => {
    expect(getSettings({ OPENGENI_BETTER_AUTH_COOKIE_PREFIX: "opengeni-staging" })).toMatchObject({
      betterAuthCookiePrefix: "opengeni-staging",
    });
    expect(getSettings({}).betterAuthCookiePrefix).toBeUndefined();
    expect(() => getSettings({ OPENGENI_BETTER_AUTH_COOKIE_PREFIX: "bad prefix;" })).toThrow();

    const transport: ManagedEmailTransport = {
      sender: "auth@example.test",
      idempotency: { scope: "test:cookie-prefix", retentionSeconds: 86_400 },
      send: async () => ({ status: "sent" as const, providerMessageId: null }),
    };
    const cookieName = async (betterAuthCookiePrefix: string | undefined) => {
      const settings = testSettings({
        databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused",
        productAccessMode: "managed",
        publicBaseUrl: "https://app.opengeni.test",
        betterAuthSecret: "managed-cookie-prefix-test-secret-at-least-32-bytes",
        betterAuthCookiePrefix,
      });
      const auth = createManagedAuth(settings, {} as never, transport)!;
      return (await auth.$context).createAuthCookie("session_token").name;
    };
    expect(await cookieName(undefined)).toBe("__Secure-better-auth.session_token");
    expect(await cookieName("opengeni-staging")).toBe("__Secure-opengeni-staging.session_token");
  });

  test("Stripe may return to Console's host, and never to a host that isn't allowed", () => {
    const origins = billingReturnOrigins(hosts);
    expect(origins).toContain("https://console.opengeni.test");
    const consoleUrl = "https://console.opengeni.test/console/usage?checkout=success";
    expect(
      checkoutReturnUrl(
        hosts.publicBaseUrl,
        undefined,
        consoleUrl,
        "/billing",
        "successUrl",
        origins,
      ),
    ).toBe(consoleUrl);
    expect(() =>
      checkoutReturnUrl(
        hosts.publicBaseUrl,
        undefined,
        "https://attacker.test/",
        "/billing",
        "successUrl",
        origins,
      ),
    ).toThrow();
  });
});
