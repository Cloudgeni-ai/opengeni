import { describe, expect, test } from "bun:test";
import {
  MICROSOFT_ADMIN_CONSENT_STATE,
  microsoftAdminConsentUrl,
  organizationAppApproval,
} from "../src/connect";

const redirect = "https://api.example.com/v1/integrations/provider-oauth/callback";

function microsoftSignIn(
  tenant: string,
  scope = "offline_access User.Read Mail.ReadWrite",
): string {
  const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", "app-1");
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", "signed-sign-in-state");
  url.searchParams.set("code_challenge", "pkce-challenge");
  return url.toString();
}

describe("organization app approval", () => {
  test("a Microsoft work sign-in yields an organization-wide approval link", () => {
    const approval = organizationAppApproval(microsoftSignIn("common"));
    expect(approval?.appId).toBe("app-1");
    const url = new URL(approval!.approvalUrl!);
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/organizations/v2.0/adminconsent",
    );
    expect(url.searchParams.get("client_id")).toBe("app-1");
    expect(url.searchParams.get("redirect_uri")).toBe(redirect);
    expect(url.searchParams.get("state")).toBe(MICROSOFT_ADMIN_CONSENT_STATE);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "https://graph.microsoft.com/User.Read",
      "https://graph.microsoft.com/Mail.ReadWrite",
    ]);
    // The sign-in's own state and PKCE challenge never travel to the administrator.
    expect(approval!.approvalUrl).not.toContain("signed-sign-in-state");
    expect(approval!.approvalUrl).not.toContain("pkce-challenge");
  });

  test("the server's link for every service of the app is preferred over this sign-in's scopes", () => {
    const everyService = microsoftAdminConsentUrl({
      clientId: "app-1",
      redirectUri: redirect,
      scopes: ["User.Read", "Mail.ReadWrite", "Calendars.ReadWrite"],
    });
    expect(organizationAppApproval(microsoftSignIn("common"), everyService)?.approvalUrl).toBe(
      everyService,
    );
    // A link for another app, or not Microsoft's approval page, is never offered.
    for (const foreign of [
      everyService.replace("client_id=app-1", "client_id=app-2"),
      "https://login.example.com/organizations/v2.0/adminconsent?client_id=app-1",
      "not a url",
    ])
      expect(
        new URL(
          organizationAppApproval(microsoftSignIn("common"), foreign)!.approvalUrl!,
        ).searchParams.get("scope"),
      ).toBe("https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite");
  });

  test("a sign-in pinned to one organization keeps that organization", () => {
    const approval = organizationAppApproval(microsoftSignIn("contoso.onmicrosoft.com"));
    expect(new URL(approval!.approvalUrl!).pathname).toBe(
      "/contoso.onmicrosoft.com/v2.0/adminconsent",
    );
    expect(
      new URL(organizationAppApproval(microsoftSignIn("organizations"))!.approvalUrl!).pathname,
    ).toBe("/organizations/v2.0/adminconsent");
  });

  test("personal Microsoft accounts have no organization to approve anything", () => {
    expect(organizationAppApproval(microsoftSignIn("consumers"))).toBeNull();
  });

  test("Google Workspace administrators get the app's client ID", () => {
    expect(
      organizationAppApproval(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=google-app.apps.googleusercontent.com&scope=openid",
      ),
    ).toEqual({ approvalUrl: null, appId: "google-app.apps.googleusercontent.com" });
  });

  test("anything else is not an organization approval", () => {
    for (const url of [
      "https://provider.example/authorize?client_id=x",
      "http://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&redirect_uri=y",
      "https://user:pass@login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&redirect_uri=y",
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?redirect_uri=y",
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x",
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=${"x".repeat(300)}`,
      "not a url",
    ]) {
      expect(organizationAppApproval(url)).toBeNull();
    }
  });

  test("fully qualified scopes pass through unchanged", () => {
    const url = new URL(
      microsoftAdminConsentUrl({
        clientId: "app-1",
        redirectUri: redirect,
        scopes: ["openid", "profile", "https://graph.microsoft.com/Calendars.ReadWrite"],
        tenant: "tenant-id",
      }),
    );
    expect(url.pathname).toBe("/tenant-id/v2.0/adminconsent");
    expect(url.searchParams.get("scope")).toBe("https://graph.microsoft.com/Calendars.ReadWrite");
  });
});
